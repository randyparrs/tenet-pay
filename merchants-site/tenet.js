// Tenet Pay: the logic the new pages share (checkout, My orders, stores), with no interface in it. The gateway Worker's
// API, reads of Arc with fallbacks, the visitor's wallet (a browser wallet, or Circle's for buyers who sign in with
// Google) and the escrow transactions. Everything that changes state on chain is signed in the visitor's wallet; the
// Worker only reads and relays. The terms text and its hash come from terms.js, the same code the Worker uses.
import { render as renderTerms, termsHash } from "./terms.js";

export { renderTerms, termsHash };

const meta = (name) => ((document.querySelector(`meta[name="${name}"]`) || {}).content || "").trim();
export const API = meta("tenet-gateway-api").replace(/\/$/, "");
export const ARC = { chainId: "0x4cef52", chainName: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.io"], blockExplorerUrls: ["https://explorer.testnet.arc.io"] };
export const CHAIN_ID = 5042002;
export const txUrl = (h) => `${ARC.blockExplorerUrls[0]}/tx/${h}`;
// GenLayer reset Bradbury in October 2026 (Phase 2, Consensus v0.6): its explorer no longer has the gateway's earlier
// judge and Lacre transactions (the last one on 2026-10-23), so they open their record in the repository, marked
// "archived", as on Tenet's page. Later ones open Bradbury Phase 2's explorer.
export const BRADBURY_ARCHIVE = "https://github.com/randyparrs/tenet-pay/blob/main/data/bradbury-archive.jsonl";
export const ARCHIVED_BEFORE = Date.UTC(2026, 9, 28) / 1000;
export const glTx = (h, at) => (Number(at) < ARCHIVED_BEFORE ? { href: BRADBURY_ARCHIVE, archived: true }
  : { href: `https://scan.bradbury.genlayer.com/tx/${h}`, archived: false });
export const SEL = { approve: "095ea7b3", allowance: "dd62ed3e", pay: "919aeb18", openClaim: "f0dd1fe5", submit: "3d5376fa", withdraw: "51cff8d9",
  claimable: "d4570c1c", merchantTermsHash: "e16eba66", merchantRefund: "40b81e11" };

// ---- the gateway Worker ----------------------------------------------------------------------------------------

/** A Worker error keeps its HTTP status: 404 is "no such order", anything else (or no answer) is "Tenet is down". */
async function answer(r) {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || `the gateway did not answer (${r.status})`), { status: r.status });
  return j;
}
export async function get(path) {
  let r;
  try { r = await fetch(API + path, { cache: "no-store" }); } catch (e) { throw Object.assign(new Error("the gateway did not answer"), { status: 0 }); }
  return answer(r);
}
export async function post(path, body) {
  let r;
  try { r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }
  catch (e) { throw Object.assign(new Error("the gateway did not answer"), { status: 0 }); }
  return answer(r);
}

// ---- encoding --------------------------------------------------------------------------------------------------

export const word = (h) => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
export const uint = (n) => BigInt(n).toString(16).padStart(64, "0");
export function utf8Hex(text) { return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
/** A call that takes (bytes32 orderRef, bytes text): openClaim and submit. */
export function withBytes(sel, ref, text) {
  const h = utf8Hex(text), len = h.length / 2;
  return "0x" + sel + word(ref) + uint(64) + uint(len) + h.padEnd(Math.ceil(len / 32) * 64, "0");
}
/** Canonical JSON (sorted keys, no spaces, ASCII), as the escrow and the judges read a claim or a submission. */
export function cj(o) {
  if (o === null || typeof o !== "object") return typeof o === "string" ? JSON.stringify(o).replace(/[\u0080-\uffff]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) : JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(cj).join(",") + "]";
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + cj(o[k])).join(",") + "}";
}

// ---- reads of Arc ----------------------------------------------------------------------------------------------

async function rpcDirect(method, params) {
  const r = await fetch(ARC.rpcUrls[0], { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error || j.result === undefined) throw new Error((j.error && j.error.message) || "Arc did not answer");
  return j.result;
}
/** Arc's public RPC first; if the browser blocks it (an ad blocker, Opera GX), the wallet's own provider on Arc. */
export async function rpc(method, params) {
  try { return await rpcDirect(method, params); } catch (e) {
    const eth = wallet.provider();
    if (eth && wallet.address && (await wallet.onArc().catch(() => false))) return eth.request({ method, params });
    throw e;
  }
}
export const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
export const RPC_TRIED = "rpc.testnet.arc.io \u00b7 wallet provider \u00b7 Tenet relay";

/** A store's terms hash as the escrow holds it: read on Arc (RPC or wallet), else by the Worker. null if nothing answers. */
export async function escrowTermsHash(escrow, merchant) {
  try {
    const r = await call(escrow, "0x" + SEL.merchantTermsHash + word(merchant));
    return "0x" + String(r).replace(/^0x/, "").padStart(64, "0").slice(-64).toLowerCase();
  } catch (e) { /* the Worker reads it instead */ }
  try { return String((await get(`/api/escrow-terms/${merchant}`)).terms_hash).toLowerCase(); } catch (e) { return null; }
}

// ---- wallet ----------------------------------------------------------------------------------------------------

const listeners = new Set();
export const cancelled = (e) => !!e && (e.code === 4001 || /user (rejected|denied|cancel)|rejected the request|cancell?ed/i.test(e.message || ""));

/** status: disconnected, connecting, connected, error (a browser wallet on another network). */
export const wallet = {
  kind: "browser", status: "disconnected", address: "", balance: null, message: "",
  provider() { return window.ethereum || null; },
  circle() { return window.TenetCircle && window.TenetCircle.available() ? window.TenetCircle : null; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { listeners.forEach((fn) => { try { fn(wallet); } catch (e) { console.error(e); } }); },
  set(patch) { Object.assign(wallet, patch); wallet.emit(); },
  async onArc() {
    if (wallet.kind === "circle") return true;
    const eth = wallet.provider();
    return !!eth && String(await eth.request({ method: "eth_chainId" })).toLowerCase() === ARC.chainId;
  },
  async ensureArc() {
    const eth = wallet.provider();
    if (await wallet.onArc()) return;
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.chainId }] }); } catch (e) {
      if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ""))) await eth.request({ method: "wallet_addEthereumChain", params: [ARC] });
      else throw e;
    }
  },
  listen() {
    const eth = wallet.provider();
    if (!eth || !eth.on || wallet.listening) return;
    wallet.listening = true;
    eth.on("accountsChanged", (a) => {
      if (wallet.kind !== "browser") return;
      wallet.set({ address: (a && a[0]) || "", status: a && a[0] ? wallet.status === "error" ? "error" : "connected" : "disconnected", balance: null });
      wallet.readBalance();
    });
    eth.on("chainChanged", async () => {
      if (wallet.kind !== "browser" || !wallet.address) return;
      wallet.set({ status: (await wallet.onArc().catch(() => false)) ? "connected" : "error" });
      wallet.readBalance();
    });
  },
  async connectBrowser() {
    const eth = wallet.provider();
    if (!eth) { wallet.set({ message: "No wallet found in this browser." }); return; }
    wallet.set({ status: "connecting", message: "" });
    try {
      const a = await eth.request({ method: "eth_requestAccounts" });
      wallet.kind = "browser";
      wallet.address = a[0];
      wallet.listen();
      try { await wallet.ensureArc(); } catch (e) { /* stays on the other network: the page offers the switch */ }
      wallet.set({ status: (await wallet.onArc().catch(() => false)) ? "connected" : "error" });
      wallet.readBalance();
    } catch (e) {
      wallet.set({ status: wallet.address ? "error" : "disconnected", message: cancelled(e) ? "" : "Could not connect the wallet." });
    }
  },
  connectGoogle() {
    const C = wallet.circle();
    if (!C) { wallet.set({ message: "Circle sign-in is not available here yet. A browser wallet works." }); return; }
    wallet.set({ status: "connecting", message: "" });
    C.login().catch((e) => wallet.set({ status: "disconnected", message: ((e && e.message) || "Circle sign-in failed.") + " A browser wallet still works." }));
  },
  useCircle(s) { wallet.set({ kind: "circle", address: s.address, status: "connected" }); wallet.readBalance(); },
  async switchNetwork() {
    try { await wallet.ensureArc(); wallet.set({ status: "connected" }); wallet.readBalance(); } catch (e) { if (!cancelled(e)) wallet.set({ message: "The wallet did not switch to Arc Testnet." }); }
  },
  disconnect() {
    if (wallet.kind === "circle" && window.TenetCircle) window.TenetCircle.signOut();
    wallet.set({ kind: "browser", status: "disconnected", address: "", balance: null, message: "" });
  },
  /** On load: a Circle session of this tab, or a browser wallet the site was already allowed to use. */
  async restore() {
    const C = wallet.circle();
    if (C && C.returning()) { wallet.set({ status: "connecting" }); try { wallet.useCircle(await C.resume()); } catch (e) { wallet.set({ status: "disconnected" }); } return; }
    const cs = C && C.session && C.session();
    if (cs) { wallet.useCircle(cs); return; }
    const eth = wallet.provider();
    if (!eth) return;
    const a = await eth.request({ method: "eth_accounts" }).catch(() => []);
    if (!a || !a[0]) return;
    wallet.kind = "browser";
    wallet.address = a[0];
    wallet.listen();
    wallet.set({ status: (await wallet.onArc().catch(() => false)) ? "connected" : "error" });
    wallet.readBalance();
  },
  async readBalance() {
    if (!wallet.address) return;
    try { wallet.set({ balance: Number(BigInt(await rpc("eth_getBalance", [wallet.address, "latest"])) / 10n ** 16n) / 100 }); } catch (e) { /* stays unknown */ }
  },
};

/** Signs and sends one transaction to Arc; resolves with its hash once the wallet has sent it (onSent), before the receipt. */
export async function sendTx(to, data, onStep = () => {}) {
  if (wallet.kind === "circle") return window.TenetCircle.send(to, data, (w) => onStep(w === "approve" ? "circle-approve" : "circle-sending"));
  await wallet.ensureArc();
  onStep("wallet");
  return wallet.provider().request({ method: "eth_sendTransaction", params: [{ from: wallet.address, to, data }] });
}
/** Waits for the receipt on Arc; throws if the transaction reverted. */
export async function waitReceipt(hash, { tries = 90, every = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r && r.status === "0x1") return r;
    if (r) throw new Error("The transaction reverted on Arc.");
    await new Promise((res) => setTimeout(res, every));
  }
  throw new Error("No receipt yet; check the explorer.");
}

// ---- the terms in short ----------------------------------------------------------------------------------------

const RULE_NAME = { late: "Late delivery", not_as_described: "Not as described", not_delivered: "Never arrives" };
const ANCHOR_SHORT = { purchase: "the purchase", promised: "the promised date", delivery: "delivery" };
const span = (n, dt) => `${n} ${dt === "business" ? "business day" : "day"}${n === 1 ? "" : "s"}`;

/** One line per rule for the cards, from the same structure the full text (terms.js) is rendered from. The full text
 *  stays the one that is hashed and shown in "Read full refund policy"; these lines only summarize it. */
export function ruleSummaries(structure, amountCents) {
  if (!structure || !structure.clear) return [];
  const dt = structure.day_type;
  return structure.rules.filter((r) => RULE_NAME[r.event]).map((r) => {
    const when = r.event === "late" ? (r.late_grace_days ? `More than ${span(r.late_grace_days, dt)} after the promised date` : "Delivered after the promised date")
      : r.event === "not_as_described" ? "Damaged, wrong or not what the description says" : "The order never arrives";
    const from = r.wait_days ? `, claim from ${span(r.wait_days, dt)} after ${ANCHOR_SHORT[r.wait_from]}` : "";
    const until = r.deadline_days ? `, claim within ${span(r.deadline_days, dt)} of ${ANCHOR_SHORT[r.deadline_from]}` : "";
    return { key: r.event, name: RULE_NAME[r.event], condition: when + from + until, refund: `${r.refund_percent}%`,
      percent: r.refund_percent, amount: money(Math.floor((Number(amountCents) * r.refund_percent) / 100)) };
  });
}

// ---- formatting ------------------------------------------------------------------------------------------------

export const money = (cents) => (Number(cents) / 100).toFixed(2);
export const short = (h) => (h ? h.slice(0, 10) + "\u2026" + h.slice(-6) : "");
export const shortAddr = (a) => (a ? a.slice(0, 6) + "\u2026" + a.slice(-4) : "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Times in UTC, as Tenet's records and the explorers show them: "Oct 22, 2026, 14:32 UTC". */
export function when(seconds) {
  const d = new Date(Number(seconds) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
