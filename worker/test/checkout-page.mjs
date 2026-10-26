// The checkout (site/pay/index.html, checkout.js, tenet.js, terms.js) in a real DOM (linkedom), for the gateway rehearsal. The page's
// code runs as written; its API calls go to the same routes as the gateway Worker (src/routes.js), served by the
// rehearsal's core; its reads of Arc go to anvil; its wallet is a browser wallet on anvil.
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { serve } from "../src/routes.js";

const API = "https://tenet-gateway.randyparra.workers.dev";
const RPC = "https://rpc.testnet.arc.io";

/** The three ES modules as one script, each in its own scope as in the browser (terms.js and checkout.js both have a
 *  `render`): every module becomes a function that takes its imports and returns its exports. */
function bundle(P) {
  const read = (f) => readFileSync(P("site/" + f), "utf8");
  const mod = (name, src, imports) => {
    const exported = [...src.matchAll(/^export (?:async function|function|const|let|class) (\w+)/gm)].map((m) => m[1]);
    for (const m of src.matchAll(/^export \{([^}]*)\};?/gm)) exported.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
    let body = src.replace(/^export \{[^}]*\};?[ \t]*$/gm, "").replace(/^export (async function|function|const|let|class) /gm, "$1 ");
    for (const [from, varName] of imports) {
      const re = new RegExp(`^import \\{([\\s\\S]*?)\\} from "\\./${from.replace(".", "\\.")}";`, "m");
      const m = re.exec(body);
      if (!m) throw new Error(`${name} does not import ${from} as the rehearsal expects`);
      body = body.replace(re, `const {${m[1].replace(/\bas\b/g, ":")}} = ${varName};`);
    }
    if (/^import /m.test(body)) throw new Error(`${name} has an import the rehearsal does not provide`);
    return `const __${name} = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();\n`;
  };
  return mod("terms", read("terms.js"), []) + mod("tenet", read("tenet.js"), [["terms.js", "__terms"]])
    + mod("checkout", read("checkout.js").replace("notifyEvery: 5000", "notifyEvery: 100").replace("rpcRetry: 900", "rpcRetry: 20"), [["tenet.js", "__tenet"]]);
}

export async function makeCheckout({ getCore, cfg, pub, wallet, P }) {
  const net = { workerDown: false, rpcDown: false, relayDown: false, tamper: null, account: null, chainId: "0x4cef52", reject: false,
    refuseSwitch: false, sent: [] };
  const evts = {};
  const ethereum = {
    on(n, f) { (evts[n] ||= []).push(f); },
    request: async ({ method, params }) => {
      const a = net.account;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return a ? [a.address] : [];
      if (method === "eth_chainId") return net.chainId;
      if (method === "wallet_switchEthereumChain") {
        if (net.refuseSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        net.chainId = params[0].chainId; (evts.chainChanged || []).forEach((f) => f(net.chainId)); return null;
      }
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
      if (net.workerDown) throw new TypeError("Failed to fetch");
      const url = s.slice(API.length);
      if (net.relayDown && url.startsWith("/api/escrow-terms/")) return resp(503, { error: "down" });
      const headers = { get: (k) => (init.headers || {})[k] || (init.headers || {})[k.toLowerCase()] || null };
      let r;
      try { r = await serve(getCore(), cfg, { method: init.method || "GET", url, headers, body: init.body ? JSON.parse(init.body) : {} }); }
      catch (e) { r = { status: 400, body: { error: e.message } }; }
      let body = structuredClone(r.body);
      if (net.tamper && /^\/api\/checkout\//.test(url) && body.terms) body = net.tamper(body);
      return resp(r.status, body);
    }
    if (s === RPC) {
      if (net.rpcDown) throw new TypeError("Failed to fetch");
      const b = JSON.parse(init.body);
      try { return resp(200, { jsonrpc: "2.0", id: b.id, result: await pub.request({ method: b.method, params: b.params }) }); }
      catch (e) { return resp(200, { jsonrpc: "2.0", id: b.id, error: { message: e.message } }); }
    }
    throw new Error("no network in the rehearsal: " + s);
  };

  let ctx = null, document = null;
  const winListeners = {};
  const ls = new Map();
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  /** A fresh page load: the HTML of the design, the bundled modules, the given hash. */
  async function load(hash = "") {
    const dom = parseHTML(readFileSync(P("site/pay/index.html"), "utf8"));
    document = dom.document;
    for (const k of Object.keys(winListeners)) delete winListeners[k];
    const location = { hash, replaced: null, replace(u) { this.replaced = u; } };
    const window = { document, location, ethereum, Event: dom.window.Event, scrollTo() {},
      addEventListener: (n, f) => { winListeners[n] = f; } };
    ctx = { window, document, location, navigator: {}, console, Date, JSON, Math, Number, String, Object, Array, RegExp, BigInt, Promise,
      Map, Set, Error, TypeError, encodeURIComponent, decodeURIComponent, TextEncoder, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      crypto: webcrypto, structuredClone, fetch: fetchImpl,
      localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) } };
    vm.createContext(ctx);
    let loadError = null;
    ctx.__fail = (e) => { loadError = e; };
    vm.runInContext("(async () => {\n" + bundle(P) + "\n})().catch(__fail);", ctx, { filename: "site/checkout.js (bundled)" });
    for (let i = 0; i < 60 && !ctx.window.TenetCheckout && !loadError; i++) await settle(25);
    if (loadError) throw loadError;
    await page.until(() => !["loading"].includes(page.status()) || location.replaced, 6000);
    await settle();
  }

  const page = {
    net, load,
    get doc() { return document; },
    get T() { return ctx.window.TenetCheckout; },
    get replaced() { return ctx.location.replaced; },
    status: () => document.getElementById("app").getAttribute("data-status"),
    walletStatus: () => document.getElementById("app").getAttribute("data-wallet"),
    shown: (id) => { const el = document.getElementById(id); if (!el) throw new Error("no element " + id); for (let x = el; x; x = x.parentElement) if (x.hidden) return false; return true; },
    text: (id) => (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim(),
    attr: (id, a) => document.getElementById(id)?.getAttribute(a),
    async click(id) {
      const el = document.getElementById(id);
      if (!el) throw new Error("no element " + id);
      el.dispatchEvent(new ctx.window.Event("click", { bubbles: true }));
      await settle();
    },
    async go(hash) { ctx.location.hash = hash; await winListeners.hashchange(); await page.until(() => page.status() !== "loading", 6000); await settle(); },
    debug: () => JSON.stringify({ status: page.status(), wallet: page.walletStatus(), error: ctx.window.TenetCheckout?.state.error,
      fail: ctx.window.TenetCheckout?.state.failText, hash: ctx.window.TenetCheckout?.state.checkout?.terms?.hash,
      escrowShort: ctx.window.TenetCheckout?.state.checkout?.terms?.escrowHashShort, orderHash: ctx.window.TenetCheckout?.state.checkout?.raw?.terms?.terms_hash }),
    async until(cond, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await settle(40); } return cond(); },
  };
  return page;
}
