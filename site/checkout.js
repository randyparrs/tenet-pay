/*
 * Tenet Pay checkout (paytenet.site): the checkout's interface wired to the gateway
 * Worker, Arc and the visitor's wallet through tenet.js. The page renders the store's refund terms from their
 * structure (terms.js), hashes that text and compares it with the order's and the escrow's terms hash before it lets
 * anyone pay.
 *
 * Routes:
 *   #/ (or no hash)       No payment link screen
 *   #/pay/:orderId        Checkout for one order (also #pay/:orderId, the link the Worker gives stores)
 *
 * Checkout status values (set on #app as data-status):
 *   nolink, loading, notfound, down, ready, mismatch, rpc, approve, pay, confirm, paid
 * Wallet status values (set on #app as data-wallet):
 *   disconnected, connecting, connected, error (a wallet on another network)
 */
import { get, wallet, call, word, uint, SEL, sendTx, waitReceipt, escrowTermsHash, renderTerms, termsHash, ruleSummaries,
  cancelled, txUrl, money, short, shortAddr, when, RPC_TRIED, CHAIN_ID, ARC } from "./tenet.js";

const CONFIG = { notifyEvery: 5000, copyReset: 1600, rpcRetry: 900 };
// My orders is orders/ and How it works is how/; the stores' pages are on merchants.paytenet.site.
const LINKS = { demoStore: "https://techshopping.site", demoStoreLabel: "techshopping.site", how: "how/", myOrders: "orders/#/orders/{orderId}" };

/* ---------- Data and chain layer ---------- */
const Api = {
  loadConfig() {
    return Promise.resolve({ links: LINKS, network: { name: ARC.chainName, chainId: String(CHAIN_ID) }, rpc: { tried: RPC_TRIED } });
  },
  // GET /api/checkout/:orderId; a 404 is "not found", anything else (or no answer) is "Tenet is down".
  async loadCheckout(orderId) {
    try {
      return toCheckout(await get("/api/checkout/" + encodeURIComponent(orderId)));
    } catch (e) {
      throw { code: e && e.status === 404 ? "notfound" : "down",
        detail: `GET /api/checkout/${orderId} \u00b7 ${e && e.status ? e.status + " " : ""}${(e && e.message) || "no answer"}` };
    }
  },
  // The text shown is hashed here and compared with the order's hash and the escrow's (read on Arc, or by the Worker).
  async verifyTerms(c) {
    const local = await termsHash(c.raw.terms.structure, c.raw.terms.hold_days, c.raw.terms.windows);
    c.terms.hash = local;
    c.terms.hashShort = short(local);
    const escrow = await escrowTermsHash(c.raw.escrow, c.raw.merchant);
    c.terms.escrowHashShort = escrow ? short(escrow) : "";
    if (!escrow) return local === c.raw.terms.terms_hash ? "unreadable" : "mismatch";
    return local === c.raw.terms.terms_hash && local === escrow ? "verified" : "mismatch";
  },
  // Whether the escrow already may take the total from this wallet (then there is no "Approve" step).
  async needsApproval(c) {
    if (!wallet.address) return true;
    const have = BigInt(await call(c.raw.usdc, "0x" + SEL.allowance + word(wallet.address) + word(c.raw.escrow)).catch(() => "0x0"));
    return have < BigInt(c.raw.amount_cents) * 10000n;
  },
  async approve(c) {
    const amount = BigInt(c.raw.amount_cents) * 10000n;
    const hash = await sendTx(c.raw.usdc, "0x" + SEL.approve + word(c.raw.escrow) + uint(amount));
    await waitReceipt(hash);
  },
  async pay(c) {
    const r = c.raw, amount = BigInt(r.amount_cents) * 10000n;
    const txHash = await sendTx(r.escrow, "0x" + SEL.pay + word(r.ref) + word(r.merchant) + word(r.usdc) + uint(amount)
      + uint(r.terms.hold_days * 86400) + word(r.terms.terms_hash));
    return { txHash };
  },
  async waitForConfirmation(c, txHash) {
    await waitReceipt(txHash);
    remember(c.orderId);
    const now = Math.floor(Date.now() / 1000);
    return paymentRecord(c, txHash, now);
  },
  // Polls the order until the Worker has read the payment and the store's webhook accepted the "paid" notice.
  watchStoreNotified(c, onTick, onDone) {
    const start = Date.now();
    let stopped = false;
    onTick(0);
    const tick = setInterval(() => onTick(Math.floor((Date.now() - start) / 1000)), 1000);
    const poll = async () => {
      if (stopped) return;
      const v = await get("/api/checkout/" + encodeURIComponent(c.orderId)).catch(() => null);
      if (stopped) return;
      if (v && v.store_notified_at) { clearInterval(tick); stopped = true; onDone(); return; }
      setTimeout(poll, CONFIG.notifyEvery);
    };
    poll();
    return () => { stopped = true; clearInterval(tick); };
  },
};

/** The Worker's checkout as the design's view model expects it. `raw` keeps what the chain actions need. */
function toCheckout(r) {
  const item = (r.items && r.items[0]) || null;
  const qty = item ? item.qty || 1 : 1;
  let storeUrl = "https://" + r.domain;
  try { if (r.return_url) storeUrl = new URL(r.return_url).origin; } catch (e) { /* keeps the domain */ }
  return {
    raw: r,
    orderId: r.order,
    store: { domain: r.domain, url: storeUrl },
    item: { name: item ? item.name : r.description, description: r.description, quantity: qty,
      price: money(item ? item.price_cents : r.amount_cents) },
    total: money(r.amount_cents),
    currency: "USDC",
    holdDays: r.terms.hold_days,
    terms: {
      rules: ruleSummaries(r.terms.structure, r.amount_cents),
      claimDeadline: `While the payment is held: ${r.terms.hold_days} days after payment`,
      text: renderTerms(r.terms.structure, r.terms.hold_days, r.terms.windows),
      hash: "", hashShort: "", escrowHashShort: "",
    },
    paid: !!r.paid,
    payment: r.paid && r.pay_tx ? paymentRecord(null, r.pay_tx, r.paid_at, r) : null,
  };
}
function paymentRecord(c, txHash, paidAt, raw) {
  const r = raw || c.raw;
  return { txHash, txShort: short(txHash), paidAt: when(paidAt),
    releaseAt: when(Number(paidAt) + r.terms.hold_days * 86400) + ", unless you open a claim" };
}
// The current My orders (app/) lists the orders this browser paid as well as the wallet's.
function remember(n) {
  try { localStorage.setItem("tenet-pay-orders", JSON.stringify([...new Set([...JSON.parse(localStorage.getItem("tenet-pay-orders") || "[]"), n])].slice(-50))); } catch (e) { /* storage off */ }
}

/* ---------- State ---------- */
const state = {
  status: "loading",
  wallet: "disconnected",
  walletInfo: null,
  config: null,
  orderId: null,
  checkout: null,
  payment: null,
  error: null,
  menu: null,
  policyOpen: false,
  needsApproval: true,
  failText: "",
  flags: { rejected: false, failed: false, rpcRetrying: false, copied: false, storeNotified: false, circle: false, walletMessage: false },
  notifySeconds: 0,
  runId: 0,
  stopNotify: null,
};

/* ---------- Helpers ---------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function fillTemplate(str, vals) { return String(str || "").replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : "")); }
function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function cloneTemplate(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }
const elapsed = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

let svgCopy = 0;
function mountSvg(slot, templateId) {
  const tpl = document.getElementById(templateId);
  if (!slot || !tpl) return;
  svgCopy += 1;
  slot.innerHTML = tpl.innerHTML.replace(/\b(tn)-/g, "$1" + svgCopy + "-");
}

/* ---------- View model and rendering ---------- */
function viewModel() {
  const c = state.checkout || {};
  const cfg = state.config || {};
  const w = state.walletInfo || {};
  const p = state.payment || c.payment || {};
  const step = state.status === "approve" ? "1 of 2" : state.status === "pay" ? (state.needsApproval ? "2 of 2" : "1 of 1") : "Signed";
  return {
    route: { orderId: state.orderId || "" },
    checkout: c,
    links: Object.assign({}, cfg.links, { myOrders: fillTemplate((cfg.links || {}).myOrders, { orderId: state.orderId || "" }) }),
    network: cfg.network || {},
    rpc: cfg.rpc || {},
    wallet: { address: w.address, addressShort: w.addressShort, balanceShown: w.balanceShown },
    payment: { txShort: p.txShort, paidAt: p.paidAt, releaseAt: p.releaseAt, txUrl: p.txHash ? txUrl(p.txHash) : "#" },
    error: state.error || {},
    ui: { progressStep: step, notifyElapsed: elapsed(state.notifySeconds), failText: state.failText, walletMessage: wallet.message },
  };
}

function fillFields(vm) {
  $all("[data-field]").forEach((el) => {
    if (el.closest("[data-list]")) return;
    const v = getPath(vm, el.getAttribute("data-field"));
    el.textContent = v == null ? "" : v;
  });
  $all("[data-field-href]").forEach((el) => {
    if (el.closest("[data-list]")) return;
    const v = getPath(vm, el.getAttribute("data-field-href"));
    el.setAttribute("href", v || "#");
  });
}

function matchList(attr, value) { return attr.split(/\s+/).indexOf(value) !== -1; }
function matchFlag(attr) {
  const neg = attr.charAt(0) === "!";
  const on = !!state.flags[neg ? attr.slice(1) : attr];
  return neg ? !on : on;
}
function applyVisibility() {
  $all("[data-visible-on], [data-visible-wallet], [data-visible-flag]").forEach((el) => {
    const on = el.getAttribute("data-visible-on");
    const wl = el.getAttribute("data-visible-wallet");
    const fl = el.getAttribute("data-visible-flag");
    el.hidden = !((!on || matchList(on, state.status)) && (!wl || matchList(wl, state.wallet)) && (!fl || matchFlag(fl)));
  });
}

function renderRules() {
  const list = $("#terms-rule-list");
  list.innerHTML = "";
  const rules = (state.checkout && state.checkout.terms && state.checkout.terms.rules) || [];
  rules.forEach((r) => {
    const row = cloneTemplate("tpl-term-rule");
    row.setAttribute("data-rule-key", r.key);
    $('[data-field="name"]', row).textContent = r.name;
    $('[data-field="condition"]', row).textContent = r.condition;
    $('[data-field="refund"]', row).textContent = r.refund;
    const tpl = document.getElementById("icon-rule-" + r.key);
    if (tpl) $("[data-rule-icon]", row).innerHTML = tpl.innerHTML;
    list.appendChild(row);
  });
}

const SEG_LABELS = { approve: "Approve", pay: "Pay", confirm: "Confirmed on Arc" };
function renderSegments() {
  const wrap = $("#progress-segments");
  const order = state.needsApproval ? ["approve", "pay", "confirm"] : ["pay", "confirm"];
  const idx = state.status === "paid" ? order.length : order.indexOf(state.status);
  wrap.innerHTML = "";
  order.forEach((k, i) => {
    const seg = cloneTemplate("tpl-progress-seg");
    seg.setAttribute("data-seg", k);
    seg.setAttribute("data-seg-state", i < idx ? "done" : i === idx ? "active" : "todo");
    $(".seg__label", seg).textContent = SEG_LABELS[k];
    wrap.appendChild(seg);
  });
}

function render() {
  const app = $("#app");
  app.setAttribute("data-status", state.status);
  app.setAttribute("data-wallet", state.wallet);
  state.flags.circle = !!wallet.circle();
  state.flags.walletMessage = !!wallet.message;
  fillFields(viewModel());
  renderSegments();
  applyVisibility();
  $("#store-notify").setAttribute("data-notified", state.flags.storeNotified ? "true" : "false");
  $all("[data-menu]").forEach((m) => { m.hidden = m.getAttribute("data-menu") !== state.menu; });
  $("#menu-backdrop").hidden = !state.menu;
  $("#policy-modal").hidden = !state.policyOpen;
}

function setStatus(s) { state.status = s; render(); }

/* ---------- Loading and verification ---------- */
function parseRoute() {
  const h = (window.location.hash || "").replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "pay" && parts[1]) return { orderId: decodeURIComponent(parts[1]).toUpperCase() };
  return { orderId: null };
}

async function refreshApproval() {
  if (!state.checkout || state.checkout.paid) return;
  state.needsApproval = await Api.needsApproval(state.checkout).catch(() => true);
  render();
}

function loadOrder(orderId) {
  const run = ++state.runId;
  stopNotify();
  state.orderId = orderId;
  state.flags.rejected = false;
  state.flags.failed = false;
  state.error = null;
  if (!orderId) { state.checkout = null; setStatus("nolink"); return Promise.resolve(); }
  setStatus("loading");
  return Api.loadCheckout(orderId).then((c) => {
    if (run !== state.runId) return;
    state.checkout = c;
    state.payment = c.payment;
    renderRules();
    return Api.verifyTerms(c).then((result) => {
      if (run !== state.runId) return;
      if (c.paid) { setStatus("paid"); startNotify(c.raw.store_notified_at); return; }
      setStatus(result === "mismatch" ? "mismatch" : result === "unreadable" ? "rpc" : "ready");
      refreshApproval();
    });
  }).catch((err) => {
    if (run !== state.runId) return;
    state.error = { detail: (err && err.detail) || "" };
    setStatus(err && err.code === "notfound" ? "notfound" : "down");
  });
}

// Old links keep working: My orders goes to orders/, the sections still in app/ (For stores, Store panel, How it works) there.
const LEGACY = /^#\/?(orders|stores|panel|how)(\/|$)/;
function onRoute() {
  const h = window.location.hash || "";
  if (LEGACY.test(h)) {
    window.location.replace(/^#\/?orders/.test(h) ? "orders/#/" + h.replace(/^#\/?/, "") : /^#\/?how/.test(h) ? "how/" : "app/" + h.replace(/^#\//, "#"));
    return;
  }
  loadOrder(parseRoute().orderId);
}

/* ---------- Pay flow ---------- */
async function onPay() {
  if (state.status !== "ready" || state.wallet !== "connected" || !state.checkout) return;
  const run = ++state.runId;
  const c = state.checkout;
  state.flags.rejected = false;
  state.flags.failed = false;
  try {
    state.needsApproval = await Api.needsApproval(c).catch(() => true);
    if (state.needsApproval) { setStatus("approve"); await Api.approve(c); }
    if (run !== state.runId) return;
    setStatus("pay");
    const res = await Api.pay(c);
    if (run !== state.runId) return;
    state.payment = { txHash: res.txHash, txShort: short(res.txHash) };
    setStatus("confirm");
    const payment = await Api.waitForConfirmation(c, res.txHash);
    if (run !== state.runId) return;
    state.payment = payment;
    c.paid = true;
    setStatus("paid");
    wallet.readBalance();
    startNotify(null);
  } catch (err) {
    if (run !== state.runId) return;
    state.flags.rejected = cancelled(err);
    state.flags.failed = !state.flags.rejected;
    state.failText = state.flags.failed ? ((err && err.message) || "The payment did not go through.") + " Nothing was charged unless the explorer shows it." : "";
    setStatus("ready");
    refreshApproval();
  }
}

function startNotify(alreadyAt) {
  stopNotify();
  state.flags.storeNotified = !!alreadyAt;
  state.notifySeconds = 0;
  if (alreadyAt) { render(); return; }
  state.stopNotify = Api.watchStoreNotified(state.checkout, (s) => { state.notifySeconds = s; render(); }, () => { state.flags.storeNotified = true; render(); });
}
function stopNotify() { if (state.stopNotify) { state.stopNotify(); state.stopNotify = null; } }

/* ---------- Wallet ---------- */
function syncWallet() {
  state.wallet = wallet.status;
  state.walletInfo = wallet.address ? { address: wallet.address, addressShort: shortAddr(wallet.address),
    balanceShown: wallet.balance == null ? "..." : wallet.balance.toFixed(2) } : null;
}
function chooseWallet(type) {
  state.menu = null;
  if (type === "google") wallet.connectGoogle(); else wallet.connectBrowser();
}

/* ---------- Other actions ---------- */
function retryRpc() {
  if (state.flags.rpcRetrying || !state.checkout) return;
  state.flags.rpcRetrying = true;
  render();
  new Promise((res) => setTimeout(res, CONFIG.rpcRetry)).then(() => Api.verifyTerms(state.checkout)).then((result) => {
    state.flags.rpcRetrying = false;
    setStatus(result === "mismatch" ? "mismatch" : result === "unreadable" ? "rpc" : "ready");
    if (state.status === "ready") refreshApproval();
  });
}
function copyHash() {
  const hash = state.checkout && state.checkout.terms && state.checkout.terms.hash;
  if (!hash) return;
  try { navigator.clipboard.writeText(hash).catch(() => {}); } catch (e) { /* ignore */ }
  state.flags.copied = true;
  render();
  setTimeout(() => { state.flags.copied = false; render(); }, CONFIG.copyReset);
}

/* ---------- Events ---------- */
function bindEvents() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    if (action === "close-policy") {
      if (el.id === "policy-modal" && e.target !== el) return;
      state.policyOpen = false; render(); return;
    }
    switch (action) {
      case "open-menu": wallet.message = ""; state.menu = el.getAttribute("data-menu-target"); render(); break;
      case "close-menu": state.menu = null; render(); break;
      case "choose-wallet": chooseWallet(el.getAttribute("data-wallet-type")); break;
      case "disconnect": state.menu = null; wallet.disconnect(); break;
      case "switch-network": state.menu = null; wallet.switchNetwork(); break;
      case "retry-rpc": retryRpc(); break;
      case "retry-load": loadOrder(state.orderId); break;
      case "open-policy": state.policyOpen = true; render(); break;
      case "copy-hash": copyHash(); break;
      case "pay": onPay(); break;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.policyOpen || state.menu) { state.policyOpen = false; state.menu = null; render(); }
  });
  window.addEventListener("hashchange", onRoute);
  wallet.onChange(() => {
    const was = state.wallet;
    syncWallet();
    if (wallet.message) state.menu = state.menu || "connect";
    render();
    if (was !== "connected" && state.wallet === "connected") refreshApproval();
  });
}

/* ---------- Boot ---------- */
async function init() {
  $all('[data-icon="tenet"]').forEach((el) => mountSvg(el, "icon-tenet"));
  bindEvents();
  render();
  state.config = await Api.loadConfig();
  await wallet.restore().catch(() => {});
  syncWallet();
  onRoute();
}

window.TenetCheckout = { state, render, onRoute };
init();
