// Copy of worker/src/circle.js for the gateway Worker, with merchantRefund allowed (the store panel).
// Circle user-controlled wallets for the Demo Shop: a visitor signs in with Google and gets an EOA wallet
// on Arc testnet that pays its own gas in USDC (no Gas Station). The API key stays here as a secret
// (CIRCLE_API_KEY); the page holds the user's session token and approves every transaction in
// Circle's own window. This module only forwards: it stores nothing, and it lets a wallet execute
// only the Demo Shop's own calls (approve USDC to the demo escrow, pay, openClaim, submit, withdraw).
import { toFunctionSelector } from "viem";

const BASE = "https://api.circle.com";
const CHAIN = "ARC-TESTNET";
const APPROVE = "0x095ea7b3"; // approve(address,uint256)
const ESCROW_FNS = ["pay", "openClaim", "submit", "withdraw", "merchantRefund"]; // gateway: the store panel refunds too

export class CircleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function makeCircle({ apiKey, escrow, usdc, abi, fetchImpl = fetch, uuid = () => crypto.randomUUID() }) {
  const sel = new Set(abi.filter((x) => x.type === "function" && ESCROW_FNS.includes(x.name)).map((x) => toFunctionSelector(x)));
  const lower = (a) => String(a || "").toLowerCase();

  async function call(method, path, userToken, body) {
    const headers = { authorization: "Bearer " + apiKey, accept: "application/json", "user-agent": "tenet-demo-worker" };
    if (userToken) headers["x-user-token"] = userToken;
    if (body) headers["content-type"] = "application/json";
    const r = await fetchImpl(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new CircleError(r.status, j.code ?? null, String(j.message || "Circle answered " + r.status).slice(0, 200));
    return j.data || {};
  }

  /** The Demo Shop's own calls only: anything else is refused before it reaches Circle. */
  function allowed(to, data) {
    const d = lower(data);
    if (!/^0x[0-9a-f]{8}([0-9a-f]{2})*$/.test(d)) return false;
    if (lower(to) === lower(escrow)) return sel.has(d.slice(0, 10));
    if (lower(to) === lower(usdc)) return d.slice(0, 10) === APPROVE && d.length === 138 && "0x" + d.slice(34, 74) === lower(escrow);
    return false;
  }

  return {
    allowed,
    /** A device token for the Google sign-in (the SDK passes it through Google's redirect). */
    async deviceToken(deviceId) {
      const d = await call("POST", "/v1/w3s/users/social/token", null, { idempotencyKey: uuid(), deviceId: String(deviceId) });
      return { deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey };
    },
    /** The user's wallet on Arc testnet, creating it (EOA) on the first sign-in: a challenge to approve, or none. */
    async initialize(userToken) {
      try {
        const d = await call("POST", "/v1/w3s/user/initialize", userToken, { idempotencyKey: uuid(), accountType: "EOA", blockchains: [CHAIN] });
        return { challengeId: d.challengeId };
      } catch (e) {
        if (e.code === 155106) return { challengeId: null }; // already initialized
        throw e;
      }
    },
    async wallet(userToken) {
      const d = await call("GET", "/v1/w3s/wallets?blockchain=" + CHAIN, userToken);
      const w = (d.wallets || []).find((x) => x.blockchain === CHAIN && x.state !== "FROZEN");
      return w ? { walletId: w.id, address: w.address, accountType: w.accountType } : null;
    },
    /** A contract call for the user to approve in Circle's window; the wallet pays its own gas. */
    async execute(userToken, walletId, to, data) {
      if (!allowed(to, data)) throw new CircleError(400, null, "not a Demo Shop call");
      const d = await call("POST", "/v1/w3s/user/transactions/contractExecution", userToken,
        { idempotencyKey: uuid(), walletId: String(walletId), contractAddress: to, callData: data, feeLevel: "MEDIUM" });
      return { challengeId: d.challengeId };
    },
    async challenge(userToken, id) {
      const c = (await call("GET", "/v1/w3s/user/challenges/" + encodeURIComponent(id), userToken)).challenge || {};
      return { status: c.status, type: c.type, transactionId: (c.correlationIds || [])[0] || null,
               error: c.errorMessage || null };
    },
    async transaction(userToken, id) {
      const t = (await call("GET", "/v1/w3s/transactions/" + encodeURIComponent(id), userToken)).transaction || {};
      return { state: t.state || null, txHash: t.txHash || null, error: t.errorReason || null };
    },
  };
}

/** The Worker's /api/circle/<name> routes (POST bodies), shared with the local rehearsal: { status, body }. */
export async function circleApi(c, name, b) {
  const user = String(b.userToken || "");
  try {
    if (name === "device") return { status: 200, body: await c.deviceToken(b.deviceId) };
    if (!user) return { status: 401, body: { error: "sign in first" } };
    if (name === "init") return { status: 200, body: await c.initialize(user) };
    if (name === "wallet") {
      const w = await c.wallet(user);
      return w ? { status: 200, body: w } : { status: 404, body: { error: "no wallet yet" } };
    }
    if (name === "execute") return { status: 200, body: await c.execute(user, b.walletId, String(b.to || ""), String(b.data || "")) };
    if (name === "challenge") return { status: 200, body: await c.challenge(user, String(b.id || "")) };
    if (name === "tx") return { status: 200, body: await c.transaction(user, String(b.id || "")) };
    return { status: 404, body: { error: "not found" } };
  } catch (e) {
    return { status: e.status && e.status < 500 ? e.status : 502, body: { error: String(e.message || e).slice(0, 300), code: e.code ?? null } };
  }
}
