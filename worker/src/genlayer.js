// GenLayer Bradbury Phase 2 adapter of the gateway Worker (genlayer-js 2.0.0-rc.2), the same calls as Tenet's
// tools/gl2.mjs. The gateway key owns the gateway judges and sends only to them, to Lacre's Verifier and to Lacre's
// KeyCache (register_key and confirm_key are open to anyone; the Worker pays them for each store). Each send estimates
// its fee deposit (returned at finalization) and stops above 10 GEN. Sends and transaction reads go to the SDK's chain
// RPC; contract reads go to the GenLayer node. Lacre is not on Phase 2 yet: its calls fail, and glSend records the error.
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const NODE = "https://rpc-bradbury.genlayer.com";
const MAX_FEE = 10n * 10n ** 18n;
const DONE = new Set(["FINALIZED", "CANCELED"]);
const plain = (x) => (x instanceof Map ? Object.fromEntries([...x].map(([k, v]) => [k, String(v)])) : x || {});

/** The public RPC refuses eth_call from the zero address, so a GenLayer eth_call without "from" goes from the gateway's. */
export function withFrom(realFetch, address) {
  return async (url, init) => {
    if (/genlayer\.com/.test(String(url)) && init && typeof init.body === "string" && init.body.includes('"eth_call"')) {
      const b = JSON.parse(init.body);
      for (const r of Array.isArray(b) ? b : [b]) if (r.method === "eth_call" && r.params?.[0] && !r.params[0].from) r.params[0].from = address;
      init = { ...init, body: JSON.stringify(b) };
    }
    return realFetch(url, init);
  };
}

export function makeGl({ key, judges, router }) {
  const account = createAccount(key);
  globalThis.fetch = withFrom(globalThis.fetch.bind(globalThis), account.address);
  const client = createClient({ chain: testnetBradbury, account });
  const node = createClient({ chain: testnetBradbury, account, endpoint: NODE });
  const read = (address, functionName, args, final) => node.readContract({ address, functionName, args,
    transactionHashVariant: final ? "latest-final" : "latest-nonfinal" });
  const write = async (address, functionName, args, value = 0n) => {
    const fees = await client.estimateTransactionFees({ appealRounds: 0 });
    if (BigInt(fees.feeValue) > MAX_FEE) throw new Error(`fee deposit ${fees.feeValue} wei is above 10 GEN: nothing sent`);
    return client.writeContract({ address, functionName, args, value, fees });
  };
  let verifier = null, keycache = null, fee = null;
  const seen = new Map();

  async function lacre() {
    if (!verifier) {
      verifier = String(await read(router, "resolve", ["verifier"], true));
      keycache = String(await read(router, "resolve", ["keycache"], true));
      fee = BigInt(await read(verifier, "fee", [], true));
    }
    return verifier;
  }
  const judge = (kind) => {
    const to = judges[kind];
    if (!to) throw new Error("not a gateway judge: " + kind);
    return to;
  };

  return {
    address: account.address,
    sendJudge: (kind, claim, step) => write(judge(kind), "judge", [claim, step]),
    setMerchant: (kind, merchant, terms) => write(judge(kind), "set_merchant", [merchant, terms]),
    async getMerchant(kind, merchant, termsHash, final) {
      try { return String((await read(judge(kind), "get_merchant", [merchant, termsHash], final)) || ""); } catch { return null; }
    },
    async status(tx) {
      try {
        const t = await client.getTransaction({ hash: tx });
        const status = String(t.statusName || t.status);
        return { status, result: String(t.resultName ?? ""), done: DONE.has(status), lastVote: Number(t.lastVoteTimestamp || 0) };
      } catch {
        return null;
      }
    },
    async verdict(kind, chain, final) {
      try {
        const raw = await read(judge(kind), "get_verdict", [chain], final);
        return raw ? JSON.parse(String(raw)) : null;
      } catch {
        return null;
      }
    },
    async attest(blob, domain, selector) {
      const to = await lacre();
      return write(to, "attest_inline", [blob, domain, selector], fee);
    },
    async findRecord(bh, final = true) {
      const v = await lacre();
      for (const [rid, b] of seen) if (b === bh) return rid;
      const ids = (await read(v, "records_of", [account.address], final)) || [];
      for (const id of ids) {
        const rid = String(id);
        if (seen.has(rid)) continue;
        const b = plain(await read(v, "get", [rid], final)).bh;
        if (b) seen.set(rid, String(b));
        if (b === bh) return rid;
      }
      return null;
    },
    async registerKey(domain, selector) { await lacre(); return write(keycache, "register_key", [domain, selector]); },
    async confirmKey(domain, selector) { await lacre(); return write(keycache, "confirm_key", [domain, selector]); },
    async keyStatus(domain, selector, final = true) {
      await lacre();
      try { return plain(await read(keycache, "key_status", [domain, selector], final)); } catch { return null; }
    },
  };
}
