// Arc adapter of the gateway Worker (viem). One key: the gateway relayer, which also registers each
// store's terms on the gateway escrow. Stores and buyers sign their own transactions in their wallets. Every
// transaction goes to the gateway escrow and nowhere else; it is simulated first (a revert sends nothing), signed,
// and handed back to the core, which stores it before broadcasting it (as the demo Worker, worker/src/arc.js).
import { createPublicClient, http, encodeFunctionData, parseEventLogs, defineChain, decodeErrorResult, hexToString, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MIN_FEE = 20_000_000_000n; // Arc: maxFeePerGas >= 20 gwei
const EVENTS = ["OrderPaid", "ClaimOpened", "Submitted", "ProofRequested", "VerdictProposed", "OrderSettled", "ClaimCleared", "Withdrawn"];
const ACTIONS = ["markNoResponse", "markClosingTimeout", "openClosingRound", "requestProof", "proposeVerdict", "executeVerdict",
  "releaseUnproven", "setMerchantTerms"];

export function makeArc({ rpc, chainId, escrow, abi, key }) {
  const chain = defineChain({ id: chainId, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 2 }) });
  const relayer = privateKeyToAccount(key);
  const times = new Map();
  const read = (functionName, args) => client.readContract({ address: escrow, abi, functionName, args });

  async function blockTime(n) {
    if (!times.has(n)) times.set(n, Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp));
    if (times.size > 500) times.delete(times.keys().next().value);
    return times.get(n);
  }

  function errorName(e) {
    for (let cur = e; cur; cur = cur.cause) {
      const data = cur.data?.data || cur.data;
      if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
        try { return decodeErrorResult({ abi, data }).errorName; } catch { /* not ours */ }
      }
      if (cur.data?.errorName) return cur.data.errorName;
    }
    return (e.shortMessage || e.message || String(e)).slice(0, 160);
  }

  return {
    relayer: relayer.address,
    escrow,
    async now() { return Number((await client.getBlock({ blockTag: "latest" })).timestamp); },
    async latestBlock() { return Number(await client.getBlockNumber({ cacheTime: 0 })); },
    async logs(from, to) {
      const raw = await client.getLogs({ address: escrow, fromBlock: BigInt(from), toBlock: BigInt(to) });
      const out = [];
      for (const l of parseEventLogs({ abi, logs: raw, strict: false })) {
        if (!EVENTS.includes(l.eventName)) continue;
        const args = { ...l.args };
        for (const k of ["claim", "submission"]) if (typeof args[k] === "string") args[k] = hexToString(args[k]);
        out.push({ name: l.eventName, args, tx: l.transactionHash, index: Number(l.logIndex), block: Number(l.blockNumber),
          time: await blockTime(Number(l.blockNumber)) });
      }
      return out;
    },
    async getOrder(ref) {
      const o = await read("getOrder", [ref]);
      return { chain: o.chain, claimHash: o.claimHash, state: Number(o.state), claimedAt: Number(o.claimedAt),
        termsHash: o.termsHash, merchant: o.merchant };
    },
    async merchantTerms(merchant) {
      const [hash, hold] = await Promise.all([read("merchantTermsHash", [merchant]), read("merchantHold", [merchant])]);
      return { terms_hash: String(hash).toLowerCase(), hold_seconds: Number(hold) };
    },
    async prepare(fn, args) {
      if (!ACTIONS.includes(fn)) throw new Error(`the relayer does not send ${fn}`);
      const data = encodeFunctionData({ abi, functionName: fn, args: fn === "proposeVerdict"
        ? [args[0], args[1], BigInt(args[2]), args[3], args[4], args[5]] : fn === "setMerchantTerms" ? [args[0], BigInt(args[1]), args[2]] : args });
      let gas;
      try {
        gas = await client.estimateGas({ account: relayer, to: escrow, data });
      } catch (e) {
        throw new Error("the simulation reverts: " + errorName(e));
      }
      const price = await client.getGasPrice();
      const maxFeePerGas = 2n * price > MIN_FEE ? 2n * price : MIN_FEE;
      const nonce = await client.getTransactionCount({ address: relayer.address, blockTag: "pending" });
      const raw = await relayer.signTransaction({ to: escrow, data, gas: (gas * 13n) / 10n, maxFeePerGas,
        maxPriorityFeePerGas: maxFeePerGas < 10n ** 9n ? maxFeePerGas : 10n ** 9n, nonce, chainId, type: "eip1559", value: 0n });
      return { raw, hash: keccak256(raw), nonce };
    },
    async broadcast(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        const m = (e.shortMessage || e.message || "").toLowerCase();
        if (!/already known|nonce too low|already imported|known transaction/.test(m)) throw e;
      }
    },
    async waitReceipt(hash, ms) {
      try {
        const r = await client.waitForTransactionReceipt({ hash, timeout: ms, pollingInterval: 500 });
        return { status: r.status, block: Number(r.blockNumber) };
      } catch {
        return null;
      }
    },
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, block: Number(r.blockNumber) };
      } catch {
        return null;
      }
    },
  };
}
