// GenLayer Bradbury adapter of the gateway Worker (genlayer-js 1.2.0), after the demo Worker's worker/src/genlayer.js.
// The gateway key owns the two gateway judges and sends only to them, to Lacre's Verifier and to Lacre's
// KeyCache (register_key and confirm_key are open to anyone; the Worker pays them for each store). Gas is
// three times the node's estimate, capped at the per-transaction limit, as Lacre's tools/chain.py does.
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CAP = 16_777_216n;
const DONE = new Set(["FINALIZED", "CANCELED"]);
const plain = (x) => (x instanceof Map ? Object.fromEntries([...x].map(([k, v]) => [k, String(v)])) : x || {});

export function makeGl({ key, judges, router }) {
  const base = createAccount(key);
  const account = { ...base, signTransaction: (tx, o) => {
    const g = BigInt(tx.gas ?? 0n) * 3n;
    return base.signTransaction({ ...tx, gas: g > CAP ? CAP : g }, o);
  } };
  const client = createClient({ chain: testnetBradbury, account });
  const read = (address, functionName, args, final) => client.readContract({ address, functionName, args,
    transactionHashVariant: final ? "latest-final" : "latest-nonfinal" });
  const write = (address, functionName, args, value = 0n) => client.writeContract({ address, functionName, args, value });
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
    address: base.address,
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
      const ids = (await read(v, "records_of", [base.address], final)) || [];
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
