// The new My orders (site/orders: index.html from the design, orders.js, ../tenet.js, ../terms.js) in a real DOM
// (linkedom), for the gateway rehearsal. The page's
// code runs as written; its API calls go to the gateway routes (src/routes.js) served by the rehearsal's core, its reads
// of Arc to anvil, and its wallet is a browser wallet on anvil.
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { serve } from "../src/routes.js";

const API = "https://tenet-gateway.randyparra.workers.dev";
const RPC = "https://rpc.testnet.arc.io";

/** terms.js, tenet.js and orders.js as one script, each module in its own scope as in the browser. */
function bundle(P) {
  const read = (f) => readFileSync(P("site/" + f), "utf8");
  const mod = (name, src, imports) => {
    const exported = [...src.matchAll(/^export (?:async function|function|const|let|class) (\w+)/gm)].map((m) => m[1]);
    for (const m of src.matchAll(/^export \{([^}]*)\};?/gm)) exported.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
    let body = src.replace(/^export \{[^}]*\};?[ \t]*$/gm, "").replace(/^export (async function|function|const|let|class) /gm, "$1 ");
    for (const [from, varName] of imports) {
      const re = new RegExp(`^import \\{([\\s\\S]*?)\\} from "${from.replace(/[./]/g, "\\$&")}";`, "m");
      const m = re.exec(body);
      if (!m) throw new Error(`${name} does not import ${from} as the rehearsal expects`);
      body = body.replace(re, `const {${m[1].replace(/\bas\b/g, ":")}} = ${varName};`);
    }
    if (/^import /m.test(body)) throw new Error(`${name} has an import the rehearsal does not provide`);
    return `const __${name} = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();\n`;
  };
  return mod("terms", read("terms.js"), []) + mod("tenet", read("tenet.js"), [["./terms.js", "__terms"]])
    + mod("orders", read("orders/orders.js").replace("pollEvery: 8000", "pollEvery: 150").replace("readEvery: 4000", "readEvery: 100"), [["../tenet.js", "__tenet"]]);
}

export async function makeOrdersPage({ getCore, cfg, pub, wallet, P }) {
  const net = { account: null, chainId: "0x4cef52", reject: false, sent: [] };
  const evts = {};
  const ethereum = {
    on(n, f) { (evts[n] ||= []).push(f); },
    request: async ({ method, params }) => {
      const a = net.account;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return a ? [a.address] : [];
      if (method === "eth_chainId") return net.chainId;
      if (method === "wallet_switchEthereumChain") { net.chainId = params[0].chainId; return null; }
      if (method === "eth_sendTransaction") {
        if (net.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        const h = await wallet(a).sendTransaction({ to: params[0].to, data: params[0].data });
        net.sent.push(h);
        return h;
      }
      return pub.request({ method, params });
    },
  };
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (u, init = {}) => {
    const s = String(u);
    if (s.startsWith(API)) {
      const url = s.slice(API.length);
      let r;
      try { r = await serve(getCore(), cfg, { method: init.method || "GET", url, headers: { get: () => null }, body: init.body ? JSON.parse(init.body) : {} }); }
      catch (e) { r = { status: 400, body: { error: e.message } }; }
      return resp(r.status, structuredClone(r.body));
    }
    if (s === RPC) {
      const b = JSON.parse(init.body);
      try { return resp(200, { jsonrpc: "2.0", id: b.id, result: await pub.request({ method: b.method, params: b.params }) }); }
      catch (e) { return resp(200, { jsonrpc: "2.0", id: b.id, error: { message: e.message } }); }
    }
    throw new Error("no network in the rehearsal: " + s);
  };

  // Timers the page starts, so the rehearsal can stop them when it is done with the page.
  let live = true;
  const intervals = new Set();
  const timers = {
    setTimeout: (f, ms, ...a) => setTimeout(() => { if (live) f(...a); }, ms),
    clearTimeout,
    setInterval: (f, ms, ...a) => { const h = setInterval(() => { if (live) f(...a); }, ms); intervals.add(h); return h; },
    clearInterval: (h) => { intervals.delete(h); clearInterval(h); },
  };
  const ls = new Map();
  let ctx = null, document = null;
  const winListeners = {};
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  const page = {
    net,
    get doc() { return document; },
    get T() { return ctx.window.TenetOrders; },
    async load(hash = "") {
      if (ctx) page.close();
      live = true;
      const dom = parseHTML(readFileSync(P("site/orders/index.html"), "utf8"));
      document = dom.document;
      const El = Object.getPrototypeOf(Object.getPrototypeOf(document.body));
      for (const proto of [Object.getPrototypeOf(document.body), El]) {
        if (typeof proto.getBoundingClientRect !== "function") proto.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0 });
        if (typeof proto.focus !== "function") proto.focus = () => {};
      }
      for (const k of Object.keys(winListeners)) delete winListeners[k];
      const location = { hash, pathname: "/orders/", search: "" };
      const history = { replaceState: (_s, _t, url) => { location.hash = (/#.*$/.exec(url) || [""])[0]; } };
      const window = { document, location, history, ethereum, Event: dom.window.Event, scrollTo() {}, scrollY: 0,
        localStorage: null, addEventListener: (n, f) => { winListeners[n] = f; } };
      const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
      window.localStorage = localStorage;
      ctx = { window, document, location, history, navigator: {}, console, Date, JSON, Math, Number, String, Object, Array, RegExp, BigInt, Promise,
        Map, Set, Error, TypeError, encodeURIComponent, decodeURIComponent, TextEncoder, URL, ...timers, crypto: webcrypto, structuredClone,
        fetch: fetchImpl, localStorage };
      vm.createContext(ctx);
      let loadError = null;
      ctx.__fail = (e) => { loadError = e; };
      vm.runInContext("(async () => {\n" + bundle(P) + "\n})().catch(__fail);", ctx, { filename: "site/orders/orders.js (bundled)" });
      for (let i = 0; i < 80 && !ctx.window.TenetOrders && !loadError; i++) await settle(25);
      if (loadError) throw loadError;
      await settle(400);
    },
    dbg: () => { const s = ctx.window.TenetOrders.state, c = s.order && s.order.claim; return JSON.stringify({ status: s.status, busy: s.busy, failed: s.failed, rejected: s.rejected,
      stage: c && c.stage, reg: c && c.emailsRegistered, proof: c && c.proof, pend: Object.fromEntries(Object.entries(s.pendings).map(([k, p]) => [k, { read: p.read, tx: (p.txHash || "").slice(0, 10) }])),
      sent: net.sent.length, queue: s.order && s.order._queue && s.order._queue.length, next: s.order && s.order.raw.next && s.order.raw.next.action,
      signState: document.getElementById("claim-sign")?.getAttribute("data-sign-state"), pendingText: (document.getElementById("pending-claim")?.textContent || "").trim().slice(0, 80) }); },
    close() { live = false; for (const h of intervals) clearInterval(h); intervals.clear(); },
    status: () => document.getElementById("app").getAttribute("data-status"),
    walletStatus: () => document.getElementById("app").getAttribute("data-wallet"),
    shown: (id) => { const el = document.getElementById(id); if (!el) throw new Error("no element " + id); for (let x = el; x; x = x.parentElement) if (x.hidden) return false; return true; },
    text: (id) => (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim(),
    attr: (id, a) => document.getElementById(id)?.getAttribute(a),
    async click(id) {
      const el = typeof id === "string" ? document.getElementById(id) : id;
      if (!el) throw new Error("no element " + id);
      el.dispatchEvent(new ctx.window.Event("click", { bubbles: true }));
      await settle();
    },
    async type(id, value) {
      const el = document.getElementById(id);
      if (!el) throw new Error("no field " + id);
      el.value = value;
      el.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
      await settle(30);
    },
    async connect(account) {
      net.account = account;
      await page.click("wallet-connect").catch(() => {});
      await page.click("connect-browser-wallet");
      await page.until(() => page.walletStatus() === "connected");
      await settle(400);
    },
    async switchAccount(account) { net.account = account; (evts.accountsChanged || []).forEach((f) => f([account.address])); await settle(600); },
    async go(hash) { ctx.location.hash = hash; await winListeners.hashchange(); await page.until(() => page.status() !== "loading", 8000); await settle(); },
    async until(cond, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await settle(50); } return cond(); },
  };
  return page;
}
