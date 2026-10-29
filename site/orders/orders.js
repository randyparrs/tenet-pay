/*
 * Tenet Pay My orders (paytenet.site/orders/): the buyer's interface wired to the
 * gateway Worker, Arc and the buyer's wallet through ../tenet.js. The Worker's view of each order is turned into the
 * page's order model (toOrder); every signature is an escrow transaction: openClaim, submit (store emails, proof,
 * closing proof) and withdraw. After each one the page waits until the Worker has read it.
 *
 * Routes:
 *   #/orders              Orders of the connected wallet (default)
 *   #/orders/:orderId     One order: item, store emails, timeline and claim
 *
 * Page status values (set on #app as data-status): list, loading, detail, notfound, down
 * Wallet status values (set on #app as data-wallet): disconnected, connecting, connected, error
 * Claim stages (order.claim.stage): opening, emails, store, judge, verdict, settle, withdraw, done
 *
 * The claim type and the answers typed before signing are kept in localStorage per order
 * (tenet-orders.draft.<orderId>), so they survive a reload and a change of account.
 */
import { get, wallet, call, word, SEL, sendTx, waitReceipt, withBytes, cj, renderTerms, ruleSummaries, cancelled,
  txUrl as arcTxUrl, glTx, money as centsToUsdc, shortAddr, CHAIN_ID, ARC } from "../tenet.js";

const CONFIG = { draftKeyPrefix: "tenet-orders.draft.", pollEvery: 8000, readEvery: 4000 };
const LINKS = { store: "https://techshopping.site" };

const TYPES = {
  late: { name: "It arrived late", event: "arrived late" },
  not_as_described: { name: "It is not what the description says", event: "not as described" },
  not_delivered: { name: "It never arrived", event: "never arrived" },
};
const PROOF_TYPES = { label: "Label", model: "Model number", serial: "Serial number" };
const PROOF_KIND = { label: "label", model: "model_number", serial: "serial_number" };
const PROOF_FROM_KIND = { label: "label", model_number: "model", serial_number: "serial" };
const STAGE_ORDER = ["opening", "emails", "store", "judge", "verdict", "settle", "withdraw", "done"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ---------- Data and chain layer ---------- */
let cfg = null; // the Worker's /api/config: escrow, usdc, windows
const Api = {
  async loadConfig() {
    cfg = await get("/api/config");
    return { links: LINKS, network: { name: ARC.chainName, chainId: String(CHAIN_ID) } };
  },
  // GET /api/orders?buyer=, then each order's view and its checkout (the terms the buyer paid under).
  async listOrders(address) {
    const r = await get("/api/orders?buyer=" + address);
    state.withdrawals = r.withdrawals || [];
    const all = await Promise.all(r.orders.map((x) => Api.getOrder(x.order).catch(() => null)));
    return all.filter(Boolean).reverse();
  },
  async getOrder(orderId) {
    try {
      const [v, co] = await Promise.all([get("/api/orders/" + encodeURIComponent(orderId)), get("/api/checkout/" + encodeURIComponent(orderId))]);
      return toOrder(v, co);
    } catch (e) {
      throw { code: e && e.status === 404 ? "notfound" : "down", detail: `GET /api/orders/${orderId} \u00b7 ${e && e.status ? e.status + " " : ""}${(e && e.message) || "no answer"}` };
    }
  },
  // The escrow's balance for this wallet, and which settled refunds it comes from. The balance on Arc decides: the
  // newest refunds that add up to it are the ones still waiting (withdrawals made before the Worker read Withdrawn
  // events are not in its list, so the list alone could show refunds already withdrawn).
  async getBalance(address) {
    const units = BigInt(await call(cfg.escrow, "0x" + SEL.claimable + word(address) + word(cfg.usdc)).catch(() => "0x0"));
    const refunds = state.orders.filter((o) => o.raw.settled && o.raw.settled.refund > 0).sort((a, b) => b.raw.settled.at - a.raw.settled.at);
    const waiting = [];
    let left = units;
    for (const o of refunds) {
      if (left <= 0n) break;
      waiting.push(o);
      left -= BigInt(o.raw.settled.refund);
    }
    state.waiting = new Set(waiting.map((o) => o.id));
    for (const o of state.orders) restage(o);
    if (state.order) restage(state.order);
    const sources = waiting.map((o) => ({ orderId: o.id, why: TYPES[o.claim.type].event[0].toUpperCase() + TYPES[o.claim.type].event.slice(1) + ", " + o.claim.result.pct + "% refund",
      amount: usdc(o.raw.settled.refund) }));
    return { claimable: usdc(units), sources, withdrawn: null };
  },
  async openClaim(o, claim) {
    const n = o.raw.next;
    const c = { ...n.base, claimed_at: Math.max(n.claimed_at + Math.floor((Date.now() - o.loadedAt) / 1000), n.base.paid_at), event: claim.type };
    const a = claim.answers || {};
    if (claim.type === "not_delivered") Object.assign(c, { account: (a.whatHappened || "").trim(), promised_date: new Date(n.base.paid_at * 1000).toISOString().slice(0, 10) });
    if (claim.type === "not_as_described") {
      const kind = PROOF_KIND[a.proofType] || "";
      Object.assign(c, { description: o.raw.description, account: (a.whatHappened || "").trim(), promised: (a.promised || "").trim(), received: (a.arrived || "").trim(),
        proof_kind: kind, proof: kind ? (a.proofShows || "").trim() : "", delivered_date: a.deliveredOn || new Date(n.claimed_at * 1000).toISOString().slice(0, 10) });
    }
    return tx(o.raw.escrowTo || cfg.escrow, withBytes(SEL.openClaim, o.raw.ref, cj(c)));
  },
  // One store email per signature: the Worker gives the exact submissions (the record id and the signed body).
  async registerEmail(o) {
    o._queue = o._queue || [...((o.raw.next && o.raw.next.submissions) || [])];
    const s = o._queue.shift();
    if (!s) throw new Error("No store email left to register.");
    return tx(cfg.escrow, withBytes(SEL.submit, o.raw.ref, s));
  },
  async sendProof(o, text, kind, closing) {
    const content = { proof_kind: kind, proof: text };
    return tx(cfg.escrow, withBytes(SEL.submit, o.raw.ref, cj({ party: "buyer", kind: closing ? "closing_proof" : "proof", content })));
  },
  async withdraw() { return tx(cfg.escrow, "0x" + SEL.withdraw + word(cfg.usdc)); },
  // Polls until the Worker shows the transaction among the order's events (or among the wallet's withdrawals).
  watchRead(txHash, onTick, onDone, orderId) {
    const start = Date.now();
    let stopped = false;
    onTick(0);
    const tick = setInterval(() => onTick(Math.floor((Date.now() - start) / 1000)), 1000);
    const seen = async () => {
      const h = String(txHash).toLowerCase();
      if (orderId) { const v = await get("/api/orders/" + encodeURIComponent(orderId)).catch(() => null); return !!v && v.events.some((e) => String(e.tx || "").toLowerCase() === h); }
      const r = await get("/api/orders?buyer=" + wallet.address).catch(() => null);
      return !!r && (r.withdrawals || []).some((w) => String(w.tx).toLowerCase() === h);
    };
    const poll = async () => {
      if (stopped) return;
      if (await seen()) { stopped = true; clearInterval(tick); onDone(); return; }
      setTimeout(poll, CONFIG.readEvery);
    };
    poll();
    return () => { stopped = true; clearInterval(tick); };
  },
  // Polls the order and keeps what this page already signed until the Worker reads it.
  watchOrder(o, onUpdate) {
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      const fresh = await Api.getOrder(o.id).catch(() => null);
      if (stopped) return;
      // Not while a signature is in progress: the action updates the order it started from, which must stay the shown one.
      if (fresh && !state.busy && state.order && state.order.id === fresh.id) { state.order = mergeOrder(state.order, fresh); onUpdate(state.order); }
      setTimeout(poll, CONFIG.pollEvery);
    };
    setTimeout(poll, CONFIG.pollEvery);
    return () => { stopped = true; };
  },
};

async function tx(to, data) {
  try {
    const hash = await sendTx(to, data);
    await waitReceipt(hash);
    return { txHash: hash };
  } catch (e) {
    throw cancelled(e) ? { code: "rejected" } : { code: "failed", message: (e && e.message) || String(e) };
  }
}

/* ---------- The Worker's order as the design's order model ---------- */
const usdc = (units) => (Number(units) / 1e6).toFixed(2);
const pad2 = (n) => String(n).padStart(2, "0");
function fmt(seconds) { if (!seconds) return ""; const d = new Date(Number(seconds) * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; }
function hm(seconds) { if (!seconds) return ""; const d = new Date(Number(seconds) * 1000); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
function fmtDay(seconds) { const d = new Date(Number(seconds) * 1000); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; }
function itemIcon(name) { const n = String(name || "").toLowerCase(); return /earbud|headphone/.test(n) ? "buds" : /charger/.test(n) ? "charger" : /case/.test(n) ? "case" : "package"; }

/** Tenet's address for this order (order-<n>@ or orders+<n>@ its mail domain); anything else is not shown. */
function orderAddress(v) {
  const a = String(v.mail_to || "").toLowerCase(), id = String(v.order || "").toLowerCase();
  return id && (a.startsWith("order-" + id + "@") || a.startsWith("orders+" + id + "@")) && /^[^@\s]+@[a-z0-9.-]+\.[a-z]+$/.test(a) ? a : "";
}

function toOrder(v, co) {
  const item = (v.items && v.items[0]) || null;
  const subs = v.submissions || [];
  const ev = v.events || [];
  const evTx = (re, last) => { const list = ev.filter((e) => re.test(e.what) && e.tx); const e = last ? list[list.length - 1] : list[0]; return e ? { tx: e.tx, at: e.at, net: e.net } : {}; };
  const rules = ruleSummaries(co.terms.structure, v.amount_cents).map((r) => ({ key: r.key, name: r.name, condition: r.condition, refund: r.refund, refundPct: r.percent }));
  const emails = (v.mails || []).filter((m) => m.state === "attested" || m.state === "attesting").map((m) => ({
    id: m.id, kind: m.dates && m.dates.delivered ? "delivered" : "order", subject: m.subject,
    detail: m.dates && m.dates.delivered ? "Carries the delivery date" : m.dates && m.dates.promised ? "Carries the promised delivery date" : "Signed by the store",
    sentAt: fmt(m.received_at), lacre: m.state === "attested" ? "verified" : "pending", regNo: m.record != null ? String(m.record) : "",
  }));
  const o = {
    id: v.order, raw: { ...v, escrowTo: co.escrow }, loadedAt: Date.now(),
    store: { domain: v.domain, url: "https://" + v.domain },
    item: { name: item ? item.name : v.description, description: v.description, quantity: item ? item.qty || 1 : 1,
      price: centsToUsdc(item ? item.price_cents : v.amount_cents), icon: itemIcon(item ? item.name : v.description) },
    total: centsToUsdc(v.amount_cents), currency: "USDC",
    paidAt: fmt(v.paid_at), releaseAt: v.paid_at ? fmtDay(v.paid_at + co.terms.hold_days * 86400) : "",
    // The timeline's note: while the payment is held, the day it goes to the store; once settled, how it was settled.
    timelineNote: v.settled ? `Settled on Arc on ${fmtDay(v.settled.at)}: ` + [
      v.settled.refund > 0 ? `${usdc(v.settled.refund)} USDC refunded to you` : "",
      v.settled.released > 0 ? `${usdc(v.settled.released)} USDC released to ${v.domain}` : ""].filter(Boolean).join(", ") + "."
      : `In escrow on Arc. Released to the store: ${v.paid_at ? fmtDay(v.paid_at + co.terms.hold_days * 86400) : ""}.`,
    mailTo: orderAddress(v), terms: { rules, text: renderTerms(co.terms.structure, co.terms.hold_days, co.terms.windows) },
    emails,
    // One line per transaction, as on Tenet's page: when the Worker logs a transaction twice (sent, then its result,
    // such as "Verdict proposed" and "Verdict proposed on Arc"), the line shows its last state at that time.
    events: ev.filter((e, i) => !e.tx || !ev.some((x, j) => j > i && x.tx && x.tx.toLowerCase() === e.tx.toLowerCase()))
      .map((e) => ({ time: fmt(e.at), at: e.at, what: e.what, tx: e.tx || "", net: e.net || "arc",
        tone: /refund|Settled/i.test(e.what) ? "ok" : /denied|not provided|unexpected/i.test(e.what) ? "red" : "neutral" })),
    claim: null,
  };
  if (!v.claim) return o;

  const c = v.claim, w = v.windows_seconds || { response: 300, proof: 300, closing: 300 };
  const content = v.claim_content || {};
  const answers = c.event === "not_as_described"
    ? { promised: content.promised || "", arrived: content.received || "", proofType: PROOF_FROM_KIND[content.proof_kind] || "", proofShows: content.proof || "",
      deliveredOn: content.delivered_date || "", whatHappened: content.account || "" }
    : c.event === "not_delivered" ? { whatHappened: content.account || "" } : {};
  const response = subs.find((s) => s.party === "merchant" && s.kind === "response");
  const noResponse = subs.find((s) => s.kind === "no_response");
  const evidence = subs.filter((s) => s.party === "buyer" && s.kind === "evidence");
  const closingOpen = subs.find((s) => s.kind === "closing_open");
  const steps = v.steps || [];
  const decideFinal = steps.find((s) => s.final && s.final.action === "decide");
  const last = steps[steps.length - 1];
  const now = Math.floor(Date.now() / 1000);
  let stage;
  if (v.settled) stage = v.settled.refund > 0 && state.waiting && state.waiting.has(v.order) ? "withdraw" : "done";
  else if (v.next && v.next.action === "submit") stage = "emails";
  else if (c.judge === "subjective" && !response && !noResponse && now < c.at + w.response) stage = "store";
  else if (decideFinal) stage = "settle";
  else if (last && last.decided && last.decided.action === "decide" && !last.final) stage = "verdict";
  else stage = "judge";

  let proof = null;
  if (closingOpen) {
    const sent = subs.some((s) => s.party === "buyer" && (s.kind === "closing_proof" || s.kind === "closing_statement"));
    proof = { mode: "closing", deadline: (closingOpen.at + w.closing) * 1000, sent, question: "Add one more piece of proof that shows what arrived: the label, the model number or the serial number." };
  } else if (v.proof_requested_at) {
    const sent = subs.some((s) => s.party === "buyer" && s.kind === "proof");
    proof = { mode: "proof", deadline: (v.proof_requested_at + w.proof) * 1000, sent, question: "Show what arrived: the label, the model number or the serial number of the item." };
  }

  const open = evTx(/Claim opened/), emailsTx = evTx(/Registered: evidence/, true), storeTx = evTx(/Registered: (response|no response)/);
  const settledTx = v.settled ? { tx: v.settled.tx, at: v.settled.at } : {};
  const finalStep = steps.find((s) => s.final);
  const finalEv = evTx(/final:/);
  const lastOutTx = (state.withdrawals || []).filter((x) => v.settled && x.at >= v.settled.at)[0];
  const pct = v.settled && v.amount_cents ? Math.round((v.settled.refund / 1e4 / v.amount_cents) * 100) : 0;
  o.claim = {
    type: c.event, stage, signedAt: fmt(c.at), answers,
    emailsRegistered: evidence.length,
    storeDeadline: c.judge === "subjective" ? (c.at + w.response) * 1000 : null,
    storeAnswered: !!response, storeAnswer: response && typeof response.content === "string" ? response.content : "",
    proof,
    result: v.settled ? { outcome: v.settled.refund > 0 ? "refund" : "released", refunded: usdc(v.settled.refund),
      released: usdc(v.settled.released || 0), pct,
      summary: v.settled.refund > 0 ? `refund of ${usdc(v.settled.refund)} USDC` : (finalStep && finalStep.final.reason) || "paid to the store" } : null,
    times: { open: hm(open.at || c.at), emails: hm(emailsTx.at), store: hm(storeTx.at || (noResponse && noResponse.at)), judge: hm(finalEv.at),
      verdict: hm(finalEv.at), settle: hm(settledTx.at), withdraw: hm(lastOutTx && lastOutTx.at) },
    txs: { open: open.tx || "", emails: emailsTx.tx || "", store: storeTx.tx || "", settle: settledTx.tx || "", withdraw: (lastOutTx && lastOutTx.tx) || "" },
  };
  return o;
}

/** A settled refund waits in the escrow (stage withdraw) or was withdrawn (done), as the balance on Arc says. */
function restage(o) {
  const c = o.claim, s = o.raw.settled;
  if (!c || !s || !(s.refund > 0)) return;
  c.stage = state.waiting && state.waiting.has(o.id) ? "withdraw" : "done";
}

/** A newer reading of the order, keeping what this page signed and the Worker has not read yet. */
function mergeOrder(old, fresh) {
  const oc = old.claim, fc = fresh.claim;
  if (oc && !fc) fresh.claim = oc; // the claim was signed here; the Worker reads it within a minute
  else if (oc && fc) {
    fc.emailsRegistered = Math.max(fc.emailsRegistered || 0, oc.emailsRegistered || 0);
    if (oc.proof && oc.proof.sent && fc.proof) fc.proof.sent = true;
  }
  fresh._queue = old._queue;
  return fresh;
}

/* ---------- State ---------- */
const state = {
  status: "list",
  wallet: "disconnected",
  walletInfo: null,
  config: null,
  orders: [],
  withdrawals: [],
  waiting: null,
  balance: null,
  orderId: null,
  order: null,
  error: null,
  menu: null,
  draft: emptyDraft(),
  invalid: {},
  missing: false,
  proofText: "",
  proofKind: "",
  busy: null,
  rejected: { claim: false, emails: false, proof: false, withdraw: false },
  failed: "",
  pendings: {},
  runId: 0,
  stopWatch: null,
};

/* ---------- Helpers ---------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function mmss(sec) { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ":" + pad2(sec % 60); }
function nowLabel() { return fmt(Math.floor(Date.now() / 1000)); }
function nowHM() { return hm(Math.floor(Date.now() / 1000)); }
function money(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
function cloneTemplate(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }
function findById(list, id) { for (let i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
function txShort(h) { return h ? h.slice(0, 6) + "\u2026" + h.slice(-4) : ""; }
function setF(root, name, value) { $all('[data-f="' + name + '"]', root).forEach((el) => { el.textContent = value == null ? "" : value; }); }
/** Arc transactions open Arc's explorer; the judge's and Lacre's (GenLayer) open Bradbury's, or their archived record. */
function setTx(root, hash, net, at) {
  const a = $("[data-f-tx]", root);
  if (!a) return;
  if (!hash) { a.remove(); return; }
  const gl = net && net !== "arc" ? glTx(hash, at) : null;
  a.setAttribute("href", gl ? gl.href : arcTxUrl(hash));
  setF(a, "txShort", txShort(hash));
  if (gl && gl.archived) {
    a.setAttribute("title", "Archived: the record of " + hash + " in the repository");
    const tag = document.createElement("span");
    tag.className = "archived-tag";
    tag.textContent = "archived";
    a.appendChild(tag);
  }
}
function renderIfChanged(el, data, build) {
  const sig = JSON.stringify(data);
  if (el.__sig === sig) return false;
  el.__sig = sig;
  build();
  return true;
}

let svgCopy = 0;
function mountSvg(slot, templateId) {
  const tpl = document.getElementById(templateId);
  if (!slot || !tpl) return;
  svgCopy += 1;
  slot.innerHTML = tpl.innerHTML.replace(/\b(tn)-/g, "$1" + svgCopy + "-");
}

/* ---------- Draft (saved per order in localStorage) ---------- */
function emptyDraft() { return { type: null, answers: { not_as_described: {}, not_delivered: {} }, confirming: false }; }
function loadDraft(orderId) {
  const d = emptyDraft();
  try {
    const raw = window.localStorage.getItem(CONFIG.draftKeyPrefix + orderId);
    if (raw) {
      const saved = JSON.parse(raw);
      d.type = saved.type || null;
      d.answers.not_as_described = Object.assign({}, saved.answers && saved.answers.not_as_described);
      d.answers.not_delivered = Object.assign({}, saved.answers && saved.answers.not_delivered);
    }
  } catch (e) { /* ignore */ }
  return d;
}
function saveDraft() {
  if (!state.order) return;
  try { window.localStorage.setItem(CONFIG.draftKeyPrefix + state.order.id, JSON.stringify({ type: state.draft.type, answers: state.draft.answers })); } catch (e) { /* ignore */ }
}
function clearDraft(orderId) {
  try { window.localStorage.removeItem(CONFIG.draftKeyPrefix + orderId); } catch (e) { /* ignore */ }
}

/* ---------- Order logic ---------- */
function verifiedEmails(o) { return (o.emails || []).filter((e) => e.lacre === "verified"); }
function lateDisabled(o) { return !(o.emails || []).some((e) => e.kind === "delivered" && e.lacre === "verified"); }
function effectiveType() {
  const t = state.draft.type;
  if (!t || !state.order) return null;
  if (t === "late" && lateDisabled(state.order)) return null;
  return t;
}
function rule(o, key) {
  const rules = (o && o.terms && o.terms.rules) || [];
  for (let i = 0; i < rules.length; i++) if (rules[i].key === key) return rules[i];
  return { condition: "", refund: "", refundPct: 0 };
}
function refundAmount(o, key) { return money((Number(o.total) * rule(o, key).refundPct) / 100); }
function proofState(c) {
  const p = c && c.proof;
  if (!p) return { requested: false };
  const left = p.deadline ? (p.deadline - Date.now()) / 1000 : 0;
  return { requested: true, sent: !!p.sent, expired: !p.sent && left <= 0, left, closing: p.mode === "closing" };
}
function orderStatus(o) {
  const c = o.claim;
  if (!c) return { text: "In escrow", tone: "green" };
  if (c.stage === "done") return c.result && c.result.outcome === "refund" ? { text: "Refunded " + c.result.refunded + " USDC", tone: "neutral" } : { text: "Released to the store", tone: "neutral" };
  if (c.stage === "withdraw") return { text: "Refund ready", tone: "green" };
  const p = proofState(c);
  if (c.stage === "judge" && p.requested && !p.sent && !p.expired) return { text: "Proof requested", tone: "red" };
  return { text: "Claim open", tone: "amber" };
}
function setChip(el, st) { el.className = "chip chip--" + st.tone; el.textContent = st.text; }

function claimSteps(o) {
  const c = o.claim;
  const n = verifiedEmails(o).length;
  const released = c.result && c.result.outcome === "released";
  const store = o.store.domain;
  const defs = [{ key: "open", title: "Open the claim", est: "1 signature", desc: "Your claim is signed and sent to the escrow on Arc.", done: "Signed by you" }];
  if (c.type === "late") defs.push({ key: "emails", title: "Register the store emails", est: n + " signatures", desc: "Each store email verified in Lacre goes into the claim with its own signature.", done: n + " store emails registered" });
  if (c.type !== "late") defs.push({ key: "store", title: "Wait for the store", est: "5 min on testnet", desc: store + " can answer the claim before the judge reads it.", done: c.storeAnswered ? 'The store answered: "' + (c.storeAnswer || "") + '"' : "The store did not answer in time" });
  defs.push({ key: "judge", title: "Judge on GenLayer", est: "about 10 min", desc: "An AI judge reads the refund terms, your claim and the store emails. It can ask you for proof.", done: c.result ? "Decided: " + c.result.summary : "The judge decided" });
  defs.push({ key: "verdict", title: "Final verdict", est: "about 30 min", desc: "GenLayer validators confirm the decision. This verdict is final.", done: "Confirmed by GenLayer validators" });
  defs.push({ key: "settle", title: "Settlement on Arc", est: "a few minutes", desc: "Arc moves the funds out of the escrow.", done: released ? "Payment released to the store" : "Refund moved to your balance in the escrow" });
  defs.push({ key: "withdraw", title: "Withdraw", est: "1 signature", desc: "Your refund waits in the escrow until you withdraw it.", done: "Withdrawn to your wallet" });

  const activeKey = { opening: "open", emails: "emails", store: "store", judge: "judge", verdict: "verdict", settle: "settle", withdraw: "withdraw" }[c.stage];
  const idx = activeKey ? defs.map((d) => d.key).indexOf(activeKey) : defs.length;
  return defs.map((d, i) => {
    let st = i < idx ? "done" : i === idx ? "active" : "todo";
    let sub = st === "done" ? d.done : d.desc;
    let time = st === "done" ? c.times[d.key] || "" : d.est;
    if (d.key === "withdraw" && released) { st = c.stage === "done" ? "skipped" : st; sub = "Nothing to withdraw: the payment went to the store."; time = ""; }
    return { key: d.key, n: String(i + 1), title: d.title, state: st, sub, time, tx: st === "done" ? c.txs[d.key] || "" : "" };
  });
}

/* ---------- View model and rendering ---------- */
function viewModel() {
  const conf = state.config || {};
  const w = state.walletInfo || {};
  const o = state.order;
  const c = o && o.claim;
  const b = state.balance || {};
  const types = {};
  Object.keys(TYPES).forEach((k) => {
    const r = rule(o, k);
    types[k] = { condition: r.condition, refund: r.refund ? r.refund + " back" : "", amount: o ? refundAmount(o, k) : "" };
  });
  const n = o ? verifiedEmails(o).length : 0;
  const reg = c ? c.emailsRegistered || 0 : 0;
  const p = proofState(c);
  return {
    route: { orderId: state.orderId || "" },
    links: conf.links || {},
    network: conf.network || {},
    wallet: { address: w.address, addressShort: w.addressShort, balance: w.balance },
    list: { count: state.orders.length === 1 ? "1 order" : state.orders.length + " orders" },
    order: o || {},
    types,
    draft: { typeName: state.draft.type ? TYPES[state.draft.type].name : "" },
    claim: c ? { typeName: TYPES[c.type].name, signedAt: c.signedAt, result: c.result || {} } : { result: {} },
    emails: {
      idleLabel: "Register " + (n - reg) + " store email" + (n - reg === 1 ? "" : "s"),
      stepLabel: Math.min(reg + 1, n) + " of " + n,
      doneLabel: n + " store email" + (n === 1 ? "" : "s") + " registered",
    },
    store: { countdown: c && c.storeDeadline ? mmss((c.storeDeadline - Date.now()) / 1000) : "" },
    proof: { question: c && c.proof ? c.proof.question : "", countdown: p.requested ? mmss(p.left) : "" },
    balance: { shown: b.withdrawn ? b.withdrawn.amount : b.claimable },
    error: state.error || {},
    ui: { walletMessage: wallet.message, failText: state.failed },
  };
}

function computeFlags() {
  const o = state.order;
  const c = o && o.claim;
  const b = state.balance || {};
  const p = proofState(c);
  const proofPending = state.pendings.proof && !state.pendings.proof.read;
  return {
    confirming: !!state.draft.confirming,
    missing: state.missing,
    lateDisabled: !!o && lateDisabled(o),
    hasProofType: !!(state.draft.answers.not_as_described || {}).proofType,
    busyClaim: state.busy === "claim",
    claimRejected: state.rejected.claim,
    emailsRejected: state.rejected.emails,
    proofRejected: state.rejected.proof,
    withdrawRejected: state.rejected.withdraw,
    proofRequested: p.requested,
    proofSent: !!p.sent,
    proofExpired: !!p.expired,
    closing: !!p.closing,
    judgeDeciding: !!c && c.stage === "judge" && (!p.requested || (p.sent && !proofPending) || p.expired),
    hasResult: !!(c && c.result && (c.stage === "withdraw" || c.stage === "done")),
    outcomeRefund: !!(c && c.result && c.result.outcome === "refund"),
    outcomeReleased: !!(c && c.result && c.result.outcome === "released"),
    withdrawn: !!b.withdrawn,
    withdrawPending: !!state.pendings.withdraw && !state.pendings.withdraw.read,
    showBalance: !!(b.withdrawn || Number(b.claimable) > 0 || state.pendings.withdraw),
    circle: !!wallet.circle(),
    walletMessage: !!wallet.message,
    failed: !!state.failed,
  };
}

function fillFields(vm) {
  $all("[data-field]").forEach((el) => {
    const v = getPath(vm, el.getAttribute("data-field"));
    const s = v == null ? "" : String(v);
    if (el.textContent !== s) el.textContent = s;
  });
  $all("[data-field-href]").forEach((el) => {
    const v = getPath(vm, el.getAttribute("data-field-href"));
    el.setAttribute("href", v || "#");
  });
}

function matchList(attr, value) { return attr.split(/\s+/).indexOf(value) !== -1; }
function matchFlags(attr, flags) {
  return attr.split(/\s+/).every((f) => {
    const neg = f.charAt(0) === "!";
    const on = !!flags[neg ? f.slice(1) : f];
    return neg ? !on : on;
  });
}
function applyVisibility(flags) {
  const stage = state.order && state.order.claim ? state.order.claim.stage : "none";
  const type = effectiveType() || "none";
  $all("[data-visible-on], [data-visible-wallet], [data-visible-flag], [data-visible-stage], [data-visible-type]").forEach((el) => {
    const on = el.getAttribute("data-visible-on");
    const wl = el.getAttribute("data-visible-wallet");
    const fl = el.getAttribute("data-visible-flag");
    const st = el.getAttribute("data-visible-stage");
    const ty = el.getAttribute("data-visible-type");
    el.hidden = !((!on || matchList(on, state.status)) && (!wl || matchList(wl, state.wallet)) && (!fl || matchFlags(fl, flags)) && (!st || matchList(st, stage)) && (!ty || matchList(ty, type)));
  });
}

function renderOrderList() {
  const el = $("#order-list");
  const rows = state.orders.map((o) => ({ id: o.id, name: o.item.name, store: o.store.domain, paidAt: o.paidAt, amount: o.total + " " + o.currency, icon: o.item.icon, status: orderStatus(o) }));
  renderIfChanged(el, rows, () => {
    el.innerHTML = "";
    if (!rows.length) { el.appendChild(cloneTemplate("tpl-order-empty")); return; }
    rows.forEach((r) => {
      const a = cloneTemplate("tpl-order-row");
      a.id = "order-row-" + r.id;
      a.setAttribute("href", "#/orders/" + encodeURIComponent(r.id));
      a.setAttribute("data-order-id", r.id);
      mountSvg($("[data-f-icon]", a), "icon-item-" + r.icon);
      setF(a, "name", r.name); setF(a, "id", r.id); setF(a, "store", r.store); setF(a, "paidAt", r.paidAt); setF(a, "amount", r.amount);
      setChip($('[data-f="status"]', a), r.status);
      el.appendChild(a);
    });
  });
}

function renderBalanceSources() {
  const el = $("#balance-sources");
  const b = state.balance || {};
  const list = (b.withdrawn && b.withdrawn.sources) || b.sources || [];
  renderIfChanged(el, list, () => {
    el.innerHTML = "";
    list.forEach((s) => {
      const row = cloneTemplate("tpl-balance-source");
      row.setAttribute("data-order-id", s.orderId);
      const a = $('[data-f="orderId"]', row);
      a.textContent = s.orderId;
      a.setAttribute("href", "#/orders/" + encodeURIComponent(s.orderId));
      setF(row, "why", s.why);
      setF(row, "amount", s.amount + " USDC");
      el.appendChild(row);
    });
  });
}

function renderTypeCards() {
  const o = state.order;
  const type = effectiveType();
  $all("[data-claim-type].type-card").forEach((card) => {
    const k = card.getAttribute("data-claim-type");
    const disabled = k === "late" && lateDisabled(o);
    card.setAttribute("aria-disabled", disabled ? "true" : "false");
    card.setAttribute("aria-checked", type === k ? "true" : "false");
    card.tabIndex = disabled ? -1 : 0;
  });
  const pt = (state.draft.answers.not_as_described || {}).proofType || "";
  $all("[data-proof-type]").forEach((b) => b.setAttribute("aria-pressed", b.getAttribute("data-proof-type") === pt ? "true" : "false"));
  $all("[data-proof-kind]").forEach((b) => b.setAttribute("aria-pressed", b.getAttribute("data-proof-kind") === state.proofKind ? "true" : "false"));
  $all("[data-answer]").forEach((inp) => {
    const f = inp.closest(".field");
    if (f) f.setAttribute("data-invalid", state.invalid[inp.id] ? "true" : "false");
  });
}

function fillInputs() {
  $all("[data-answer]").forEach((inp) => {
    const t = inp.closest("[data-answer-type]").getAttribute("data-answer-type");
    inp.value = (state.draft.answers[t] || {})[inp.getAttribute("data-answer")] || "";
  });
  $("#proof-text").value = state.proofText;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00Z");
  return isNaN(d) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function renderSummary() {
  const o = state.order;
  const t = state.draft.type;
  if (!o || !t || !state.draft.confirming) return;
  const a = state.draft.answers[t] || {};
  const r = rule(o, t);
  const rows = [
    ["Order", o.id + " \u00b7 " + o.total + " " + o.currency],
    ["Store", o.store.domain],
    ["If the judge agrees", r.refund + " back \u00b7 " + refundAmount(o, t) + " " + o.currency],
  ];
  if (t === "late") {
    const n = verifiedEmails(o).length;
    rows.push(["Evidence", n + " store emails verified in Lacre. You register them after signing, one signature each."]);
  } else if (t === "not_as_described") {
    rows.push(["The description promised", a.promised]);
    rows.push(["What arrived", a.arrived]);
    rows.push(["Proof", a.proofType ? PROOF_TYPES[a.proofType] + ": " + (a.proofShows || "") : "No proof"]);
    rows.push(["Delivered on", formatDate(a.deliveredOn)]);
    rows.push(["What happened", a.whatHappened]);
  } else {
    rows.push(["What happened", a.whatHappened]);
  }
  const el = $("#confirm-summary");
  renderIfChanged(el, rows, () => {
    el.innerHTML = "";
    rows.forEach((r2) => {
      const row = cloneTemplate("tpl-summary-row");
      setF(row, "label", r2[0]); setF(row, "value", r2[1]);
      el.appendChild(row);
    });
  });
}

function parkActions() {
  const park = $("#step-actions");
  $all("[data-step-action]").forEach((blk) => { if (blk.parentNode !== park) park.appendChild(blk); });
}
function renderSteps() {
  const el = $("#claim-steps");
  const o = state.order;
  if (!o || !o.claim) { if (el.childNodes.length) { parkActions(); el.innerHTML = ""; el.__sig = null; } return; }
  const steps = claimSteps(o);
  renderIfChanged(el, steps, () => {
    parkActions();
    el.innerHTML = "";
    steps.forEach((s) => {
      const row = cloneTemplate("tpl-step");
      row.id = "step-" + s.key;
      row.setAttribute("data-step", s.key);
      row.setAttribute("data-step-state", s.state);
      setF(row, "n", s.n); setF(row, "title", s.title); setF(row, "time", s.time); setF(row, "sub", s.sub);
      setTx(row, s.tx, "arc");
      el.appendChild(row);
    });
  });
  const active = steps.filter((s) => s.state === "active")[0];
  if (active) {
    const body = $("#step-" + active.key + " .step__body");
    const blk = $('[data-step-action="' + active.key + '"]');
    if (body && blk && blk.parentNode !== body) body.appendChild(blk);
  }
}

function renderRegList() {
  const el = $("#reg-list");
  const o = state.order;
  if (!o || !o.claim || o.claim.type !== "late") return;
  const list = verifiedEmails(o);
  const reg = o.claim.emailsRegistered || 0;
  const rows = list.map((e, i) => ({ subject: e.subject, reg: "Reg. " + e.regNo, state: i < reg ? "done" : i === reg && state.busy === "emails" ? "active" : "todo" }));
  renderIfChanged(el, rows, () => {
    el.innerHTML = "";
    rows.forEach((r) => {
      const row = cloneTemplate("tpl-reg-item");
      row.setAttribute("data-reg-state", r.state);
      setF(row, "subject", r.subject); setF(row, "reg", r.reg);
      el.appendChild(row);
    });
  });
}

function renderEmails() {
  const el = $("#email-list");
  const list = (state.order && state.order.emails) || [];
  renderIfChanged(el, list, () => {
    el.innerHTML = "";
    list.forEach((e) => {
      const row = cloneTemplate("tpl-email");
      row.id = "email-" + e.id;
      row.setAttribute("data-email-kind", e.kind);
      setF(row, "subject", e.subject); setF(row, "detail", e.detail); setF(row, "sentAt", "Sent " + e.sentAt);
      setF(row, "reg", e.lacre === "verified" ? "Reg. no. " + e.regNo : "No registration number yet");
      $all("[data-lacre]", row).forEach((s) => { if (s.getAttribute("data-lacre") !== e.lacre) s.remove(); });
      el.appendChild(row);
    });
  });
}

function renderTimeline() {
  const el = $("#timeline");
  const list = (state.order && state.order.events) || [];
  renderIfChanged(el, list, () => {
    el.innerHTML = "";
    list.forEach((ev) => {
      const row = cloneTemplate("tpl-event");
      row.setAttribute("data-tone", ev.tone || "neutral");
      setF(row, "what", ev.what); setF(row, "time", ev.time);
      setTx(row, ev.tx, ev.net, ev.at);
      el.appendChild(row);
    });
  });
}

const PENDING_TEXT = {
  claim: ["Claim registered on Arc, waiting for Tenet to read it", "Tenet read your claim"],
  emails: ["Store emails registered on Arc, waiting for Tenet to read them", "Tenet read the store emails"],
  proof: ["Proof registered on Arc, waiting for Tenet to read it", "Tenet read your proof. The judge has it."],
  withdraw: ["Withdrawal registered on Arc, waiting for Tenet to read it", "Tenet read it. The USDC is in your wallet."],
};
function renderPendings() {
  $all("[data-pending]").forEach((el) => {
    const key = el.getAttribute("data-pending");
    const p = state.pendings[key];
    const show = !!p && (key === "withdraw" || (state.order && p.orderId === state.order.id));
    el.hidden = !show;
    if (!show) { el.__sig = null; return; }
    const data = { read: p.read, tx: p.txHash };
    renderIfChanged(el, data, () => {
      el.innerHTML = "";
      el.appendChild(document.getElementById("tpl-pending").content.cloneNode(true));
      el.classList.toggle("pending--read", p.read);
      setF(el, "label", PENDING_TEXT[key][p.read ? 1 : 0]);
      $(p.read ? "[data-pending-wait]" : "[data-pending-read]", el).remove();
      setTx(el, p.txHash, "arc");
    });
    setF(el, "time", p.read ? "" : mmss(p.seconds));
  });
}

function signState(key) {
  if (state.busy === key) return "busy";
  const o = state.order, c = o && o.claim, b = state.balance || {};
  if (key === "claim" && c) return "done";
  if (key === "emails" && c && (c.emailsRegistered || 0) >= verifiedEmails(o).length) return "done";
  if (key === "proof" && c && c.proof && c.proof.sent) return "done";
  if (key === "withdraw" && (b.withdrawn || state.pendings.withdraw)) return "done";
  return "idle";
}
function renderSignButtons(flags) {
  $all("[data-sign-key]").forEach((btn) => {
    const s = signState(btn.getAttribute("data-sign-key"));
    btn.setAttribute("data-sign-state", s);
    const off = s !== "idle" || (btn.id === "proof-send" && flags.proofExpired) || (btn.id !== "balance-withdraw" && state.busy && state.busy !== btn.getAttribute("data-sign-key"));
    btn.disabled = off;
    btn.setAttribute("aria-busy", s === "busy" ? "true" : "false");
  });
  $("#proof-text").disabled = signState("proof") !== "idle";
}

function render() {
  const app = $("#app");
  app.setAttribute("data-status", state.status);
  app.setAttribute("data-wallet", state.wallet);
  const flags = computeFlags();
  fillFields(viewModel());
  if (state.status === "list") renderOrderList();
  renderBalanceSources();
  if (state.status === "detail" && state.order) {
    setChip($("#detail-status"), orderStatus(state.order));
    renderTypeCards();
    renderSummary();
    renderSteps();
    renderRegList();
    renderEmails();
    renderTimeline();
  }
  renderPendings();
  renderSignButtons(flags);
  applyVisibility(flags);
  $all("[data-menu]").forEach((m) => { m.hidden = m.getAttribute("data-menu") !== state.menu; });
  $("#menu-backdrop").hidden = !state.menu;
}

function setStatus(s) { state.status = s; render(); }

/* ---------- Routing and loading ---------- */
function parseRoute() {
  const h = (window.location.hash || "").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "orders" && parts[1]) return { view: "detail", orderId: decodeURIComponent(parts[1]).toUpperCase() };
  return { view: "list", orderId: null };
}

function stopWatch() { if (state.stopWatch) { state.stopWatch(); state.stopWatch = null; } }

function resetOrderUi() {
  state.draft = emptyDraft();
  state.invalid = {};
  state.missing = false;
  state.proofText = "";
  state.proofKind = "";
  state.failed = "";
  state.rejected.claim = state.rejected.emails = state.rejected.proof = false;
  $("#claim-steps").__sig = null;
  parkActions();
}

function loadRoute() {
  const run = ++state.runId;
  const r = parseRoute();
  stopWatch();
  state.menu = null;
  state.error = null;
  state.orderId = r.orderId;
  if (state.wallet !== "connected") { render(); return Promise.resolve(); }
  if (r.view === "list") {
    state.order = null;
    setStatus("list");
    // The list and the balance are read again each time: claims settle while the page is open.
    return refreshWalletData();
  }
  state.order = null;
  resetOrderUi();
  setStatus("loading");
  return Api.getOrder(r.orderId).then((o) => {
    if (run !== state.runId) return;
    showOrder(o, loadDraft(o.id));
  }).catch((err) => {
    if (run !== state.runId) return;
    state.error = { detail: (err && err.detail) || "" };
    setStatus(err && err.code === "notfound" ? "notfound" : "down");
  });
}

function showOrder(o, draft) {
  state.order = o;
  state.orderId = o.id;
  state.draft = draft;
  mountSvg($("#order-item-thumb"), "icon-item-" + o.item.icon);
  fillInputs();
  stopWatch();
  let wasSettled = !!o.raw.settled;
  state.stopWatch = Api.watchOrder(o, (fresh) => {
    // A claim that just settled may have put a refund in the escrow balance: read the balance again (it sets the stage).
    if (!wasSettled && fresh.raw.settled) refreshWalletData();
    wasSettled = !!fresh.raw.settled;
    render();
  });
  setStatus("detail");
}

async function loadWalletData() {
  const addr = state.walletInfo && state.walletInfo.address;
  state.orders = await Api.listOrders(addr);
  state.balance = await Api.getBalance(addr);
}

function onRoute() { loadRoute(); }

/* ---------- Claim builder ---------- */
function chooseType(t, card) {
  if (!state.order || state.order.claim) return;
  if (card && card.getAttribute("aria-disabled") === "true") return;
  if (t === "late" && lateDisabled(state.order)) return;
  state.draft.type = t;
  state.draft.confirming = false;
  state.missing = false;
  state.invalid = {};
  saveDraft();
  render();
}
function setProofType(pt) {
  const a = state.draft.answers.not_as_described;
  a.proofType = pt || "";
  if (!pt) delete state.invalid["answer-proof-shows"];
  saveDraft();
  render();
}
function validate() {
  const t = effectiveType();
  const a = state.draft.answers[t] || {};
  const inv = {};
  if (t === "not_as_described") {
    if (!(a.promised || "").trim()) inv["answer-promised"] = true;
    if (!(a.arrived || "").trim()) inv["answer-arrived"] = true;
    if (a.proofType && !(a.proofShows || "").trim()) inv["answer-proof-shows"] = true;
    if (!a.deliveredOn) inv["answer-delivered-on"] = true;
    if (!(a.whatHappened || "").trim()) inv["answer-what-happened-nad"] = true;
  } else if (t === "not_delivered") {
    if (!(a.whatHappened || "").trim()) inv["answer-what-happened-nd"] = true;
  }
  state.invalid = inv;
  return Object.keys(inv).length === 0;
}
function reviewClaim() {
  if (!effectiveType()) return;
  if (!validate()) { state.missing = true; render(); return; }
  state.missing = false;
  state.draft.confirming = true;
  state.rejected.claim = false;
  render();
  window.scrollTo(0, Math.max(0, $("#claim-card").getBoundingClientRect().top + window.scrollY - 90));
}

function startPending(key, order, txHash, onRead) {
  if (state.pendings[key] && state.pendings[key].stop) state.pendings[key].stop();
  const p = { orderId: order ? order.id : null, txHash, seconds: 0, read: false, stop: null };
  state.pendings[key] = p;
  p.stop = Api.watchRead(txHash, (s) => { p.seconds = s; render(); }, () => {
    p.read = true;
    if (onRead) onRead();
    render();
  }, order ? order.id : null);
}

function failedText(err) { return err && err.code === "failed" ? (err.message || "The transaction did not go through.") : ""; }

function signClaim() {
  const o = state.order;
  const t = effectiveType();
  if (!o || o.claim || !t || state.busy) return;
  // The escrow takes a claim only from the wallet that paid; another account would pay gas for a failed transaction.
  if (String(wallet.address).toLowerCase() !== String(o.raw.buyer).toLowerCase()) {
    state.failed = `Only the wallet that paid this order (${shortAddr(o.raw.buyer)}) can open its claim. Switch to that account in your wallet.`;
    render();
    return;
  }
  const answers = t === "late" ? {} : clone(state.draft.answers[t]);
  state.busy = "claim";
  state.rejected.claim = false;
  state.failed = "";
  render();
  Api.openClaim(o, { type: t, answers }).then((res) => {
    state.busy = null;
    o.claim = { type: t, stage: "opening", signedAt: nowLabel(), answers, times: { open: nowHM() }, txs: { open: res.txHash }, emailsRegistered: 0 };
    o.events.push({ time: nowLabel(), what: "Claim opened: " + TYPES[t].event, tx: res.txHash, net: "arc", tone: "neutral" });
    clearDraft(o.id);
    state.draft = emptyDraft();
    startPending("claim", o, res.txHash, () => refreshOrder());
    render();
  }).catch((err) => {
    state.busy = null;
    state.rejected.claim = !!(err && err.code === "rejected");
    state.failed = failedText(err);
    render();
  });
}

function registerEmails() {
  const o = state.order;
  const c = o && o.claim;
  if (!c || c.stage !== "emails" || state.busy) return;
  const total = verifiedEmails(o).length;
  let lastTx = "";
  state.busy = "emails";
  state.rejected.emails = false;
  state.failed = "";
  const next = () => {
    render();
    if ((c.emailsRegistered || 0) >= total) return Promise.resolve();
    return Api.registerEmail(o).then((res) => {
      lastTx = res.txHash;
      c.emailsRegistered = (c.emailsRegistered || 0) + 1;
      return next();
    });
  };
  next().then(() => {
    state.busy = null;
    c.times.emails = nowHM();
    c.txs.emails = lastTx;
    o.events.push({ time: nowLabel(), what: "You registered " + total + " store emails", tx: lastTx, net: "arc", tone: "neutral" });
    startPending("emails", o, lastTx, () => refreshOrder());
    render();
  }).catch((err) => {
    state.busy = null;
    state.rejected.emails = !!(err && err.code === "rejected");
    state.failed = failedText(err);
    render();
  });
}

function sendProof() {
  const o = state.order;
  const c = o && o.claim;
  const p = proofState(c);
  if (!c || !p.requested || p.sent || p.expired || state.busy) return;
  const text = state.proofText.trim();
  const field = $("#proof-text").closest(".field");
  if (!text || !state.proofKind) { field.setAttribute("data-invalid", "true"); return; }
  field.setAttribute("data-invalid", "false");
  state.busy = "proof";
  state.rejected.proof = false;
  state.failed = "";
  render();
  Api.sendProof(o, text, state.proofKind, p.closing).then((res) => {
    state.busy = null;
    c.proof.sent = true;
    c.proof.text = text;
    c.proof.tx = res.txHash;
    o.events.push({ time: nowLabel(), what: "You sent proof", tx: res.txHash, net: "arc", tone: "neutral" });
    startPending("proof", o, res.txHash, () => refreshOrder());
    render();
  }).catch((err) => {
    state.busy = null;
    state.rejected.proof = !!(err && err.code === "rejected");
    state.failed = failedText(err);
    render();
  });
}

function withdraw() {
  const b = state.balance;
  if (!b || b.withdrawn || state.pendings.withdraw || state.busy || !(Number(b.claimable) > 0)) return;
  state.busy = "withdraw";
  state.rejected.withdraw = false;
  state.failed = "";
  render();
  Api.withdraw().then((res) => {
    state.busy = null;
    markWithdrawn(res.txHash);
    startPending("withdraw", null, res.txHash, () => { wallet.readBalance(); refreshWalletData(); });
    render();
  }).catch((err) => {
    state.busy = null;
    state.rejected.withdraw = !!(err && err.code === "rejected");
    state.failed = failedText(err);
    render();
  });
}
function markWithdrawn(txHash) {
  const b = state.balance;
  b.withdrawn = { amount: b.claimable, tx: txHash, at: nowLabel(), sources: b.sources };
  (b.sources || []).forEach((s) => {
    const o = findById(state.orders, s.orderId) || (state.order && state.order.id === s.orderId ? state.order : null);
    if (o && o.claim && o.claim.stage === "withdraw") {
      o.claim.stage = "done";
      o.claim.times.withdraw = nowHM();
      o.claim.txs.withdraw = txHash;
      o.events.push({ time: nowLabel(), what: "You withdrew " + s.amount + " USDC", tx: txHash, net: "arc", tone: "ok" });
    }
  });
}
function gotoBalance() {
  const el = $("#balance-card");
  if (!el || el.hidden) return;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 90), behavior: "smooth" });
}

async function refreshOrder() {
  if (!state.order) return;
  const fresh = await Api.getOrder(state.order.id).catch(() => null);
  if (fresh && !state.busy && state.order && fresh.id === state.order.id) { state.order = mergeOrder(state.order, fresh); render(); }
}
async function refreshWalletData() {
  if (state.wallet !== "connected") return;
  const keepWithdrawn = state.balance && state.balance.withdrawn;
  await loadWalletData().catch(() => {});
  if (keepWithdrawn && state.balance && Number(state.balance.claimable) === 0) state.balance.withdrawn = keepWithdrawn;
  render();
}

/* ---------- Wallet ---------- */
function syncWallet() {
  state.wallet = wallet.status;
  state.walletInfo = wallet.address ? { address: wallet.address, addressShort: shortAddr(wallet.address),
    balance: wallet.balance == null ? "..." : wallet.balance.toFixed(2) } : null;
}
function chooseWallet(type) {
  state.menu = null;
  if (type === "google") wallet.connectGoogle(); else wallet.connectBrowser();
}

/* ---------- Events ---------- */
function bindEvents() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    switch (el.getAttribute("data-action")) {
      case "open-menu": wallet.message = ""; state.menu = el.getAttribute("data-menu-target"); render(); break;
      case "close-menu": state.menu = null; render(); break;
      case "choose-wallet": chooseWallet(el.getAttribute("data-wallet-type")); break;
      case "disconnect": state.menu = null; wallet.disconnect(); break;
      case "switch-network": state.menu = null; wallet.switchNetwork(); break;
      case "retry-load": loadRoute(); break;
      case "choose-type": chooseType(el.getAttribute("data-claim-type"), el.classList.contains("type-card") ? el : null); break;
      case "proof-type": setProofType(el.getAttribute("data-proof-type")); break;
      case "proof-kind": state.proofKind = el.getAttribute("data-proof-kind"); render(); break;
      case "review-claim": reviewClaim(); break;
      case "edit-claim": state.draft.confirming = false; state.rejected.claim = false; render(); break;
      case "sign-claim": signClaim(); break;
      case "register-emails": registerEmails(); break;
      case "send-proof": sendProof(); break;
      case "withdraw": withdraw(); break;
      case "goto-balance": gotoBalance(); break;
    }
  });
  document.addEventListener("input", (e) => {
    const inp = e.target;
    if (inp.matches("[data-answer]")) {
      const t = inp.closest("[data-answer-type]").getAttribute("data-answer-type");
      state.draft.answers[t] = state.draft.answers[t] || {};
      state.draft.answers[t][inp.getAttribute("data-answer")] = inp.value;
      if (state.missing) { validate(); if (!Object.keys(state.invalid).length) state.missing = false; }
      saveDraft();
      render();
    } else if (inp.matches("[data-proof-input]")) {
      state.proofText = inp.value;
      if (inp.value.trim()) inp.closest(".field").setAttribute("data-invalid", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.menu) { state.menu = null; render(); }
  });
  window.addEventListener("hashchange", onRoute);
  setInterval(() => { if (state.status === "detail" || Object.keys(state.pendings).length) render(); }, 1000);
  wallet.onChange(async () => {
    const was = state.wallet, addr = state.walletInfo && state.walletInfo.address;
    syncWallet();
    if (wallet.message) state.menu = state.menu || "connect";
    render();
    if (state.wallet === "connected" && (was !== "connected" || addr !== wallet.address)) {
      await loadWalletData().catch(() => {});
      loadRoute();
    }
  });
}

/* ---------- Boot ---------- */
async function init() {
  $all('[data-icon="tenet"]').forEach((el) => mountSvg(el, "icon-tenet"));
  bindEvents();
  render();
  state.config = await Api.loadConfig().catch(() => ({ links: LINKS, network: { name: ARC.chainName, chainId: String(CHAIN_ID) } }));
  if (!window.location.hash || window.location.hash === "#/" || window.location.hash === "#") history.replaceState(null, "", window.location.pathname + window.location.search + "#/orders");
  await wallet.restore().catch(() => {});
  syncWallet();
  if (state.wallet === "connected") await loadWalletData().catch(() => {});
  onRoute();
}

window.TenetOrders = { state, render, onRoute, toOrder };
init();
