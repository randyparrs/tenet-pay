// TechShopping's new page (techshopping/site: index.html from the design, app.js, store.json) in a real DOM
// (linkedom), for the gateway rehearsal. The
// page's code runs as written; its own API (/api/buy, /api/orders/:id) is served by the rehearsal's ShopCore, as the
// store's Worker does, and Tenet's public order view by the gateway routes (src/routes.js).
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import vm from "node:vm";
import { serve } from "../src/routes.js";

const TENET = "https://tenet-gateway.randyparra.workers.dev";

export async function makeShopPage({ getCore, cfg, shop, t, P }) {
  const net = { popupBlocked: false, buyFails: false, opened: [] };
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (u, init = {}) => {
    const s = String(u);
    if (s === "store.json") return resp(200, JSON.parse(readFileSync(P("techshopping/site/store.json"), "utf8")));
    if (s === "/api/buy" && init.method === "POST") {
      if (net.buyFails) return resp(502, { error: "tenet unreachable" });
      try { return resp(200, await shop.buy(JSON.parse(init.body).product, await t())); } catch (e) { return resp(400, { error: e.message }); }
    }
    let m = /^\/api\/orders\/(TS-[0-9]{6})$/.exec(s);
    if (m) { const st = await shop.status(m[1]); return st ? resp(200, st) : resp(404, { error: "no such order" }); }
    if (s.startsWith(TENET)) {
      const r = await serve(getCore(), cfg, { method: "GET", url: s.slice(TENET.length), headers: { get: () => null }, body: {} }).catch((e) => ({ status: 400, body: { error: e.message } }));
      return resp(r.status, structuredClone(r.body));
    }
    throw new Error("no network in the rehearsal: " + s);
  };

  let ctx = null, document = null;
  const winListeners = {};
  const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const page = {
    net,
    get doc() { return document; },
    async load(hash = "") {
      const dom = parseHTML(readFileSync(P("techshopping/site/index.html"), "utf8"));
      document = dom.document;
      for (const k of Object.keys(winListeners)) delete winListeners[k];
      const location = { hash };
      const window = { document, location, Event: dom.window.Event, scrollTo() {}, pageYOffset: 0,
        addEventListener: (n, f) => { winListeners[n] = f; },
        open: () => {
          if (net.popupBlocked) return null;
          const w = { closed: false, opener: "the store", document: { title: "", body: { style: {}, textContent: "" } }, location: { href: "" }, close() { this.closed = true; } };
          net.opened.push(w);
          return w;
        } };
      Object.defineProperty(location, "hash", { get: () => location._h || "", set: (v) => { location._h = v; if (winListeners.hashchange) winListeners.hashchange(); } });
      location._h = hash;
      ctx = { window, document, location, console, Date, JSON, Math, Number, String, Object, Array, RegExp, Promise, Error,
        encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), fetch: fetchImpl };
      vm.createContext(ctx);
      vm.runInContext(readFileSync(P("techshopping/site/app.js"), "utf8"), ctx, { filename: "techshopping/site/app.js" });
      await page.until(() => document.querySelectorAll("#product-list .product-card").length > 0, 4000);
      await settle();
    },
    shown: (id) => { const el = document.getElementById(id); if (!el) throw new Error("no element " + id); for (let x = el; x; x = x.parentElement) if (x.hidden) return false; return true; },
    text: (id) => (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim(),
    attr: (id, a) => document.getElementById(id)?.getAttribute(a),
    async click(id) {
      const el = document.getElementById(id);
      if (!el) throw new Error("no element " + id);
      el.dispatchEvent(new ctx.window.Event("click", { bubbles: true }));
      await settle();
    },
    async go(hash) { ctx.location.hash = hash; await settle(300); },
    async until(cond, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await settle(40); } return cond(); },
  };
  return page;
}
