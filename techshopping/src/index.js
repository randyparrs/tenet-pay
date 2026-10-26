// Cloudflare entry of TechShopping (techshopping.site), the gateway's example store. Static pages from site/ (the
// assets binding); its API: POST /api/buy (create the order on Tenet, answer with Tenet's checkout link) and POST
// /api/tenet-webhook (Tenet's signed notices). A cron sends the emails that are due (the earbuds' delivery notice
// the next day, UTC). One Durable Object holds the orders. Secrets (wrangler secret put): TENET_API_KEY,
// TENET_WEBHOOK_SECRET (both shown once when the store was registered on Tenet), RESEND_API_KEY.
import { DurableObject } from "cloudflare:workers";
import { ShopCore } from "./core.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const now = () => Math.floor(Date.now() / 1000);

export class ShopState extends DurableObject {
  core() {
    if (!this._core) {
      const st = this.ctx.storage, env = this.env;
      const store = { get: (k) => st.get(k), put: (k, v) => st.put(k, v), list: async (p) => [...(await st.list({ prefix: p })).values()] };
      const tenet = async (path, body) => {
        const r = await fetch(env.TENET_API + path, { method: "POST", body: JSON.stringify(body),
          headers: { "content-type": "application/json", authorization: "Bearer " + String(env.TENET_API_KEY || "").trim() } });
        return r.json().catch(() => ({ error: "Tenet did not answer" }));
      };
      // Resend sends the text and the HTML as multipart/alternative, signed with DKIM for techshopping.site (selector resend).
      // Resend rejects a request without a User-Agent with 403 (its API reference), and a Worker's fetch sends none.
      const mail = async (m) => {
        const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json",
          authorization: "Bearer " + String(env.RESEND_API_KEY || "").trim(), "user-agent": "techshopping/1.0" },
          body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }) });
        if (r.status >= 300) throw new Error("Resend: http " + r.status);
      };
      this._core = new ShopCore({ cfg: { site_url: env.SITE_URL, from: env.MAIL_FROM, webhook_secret: String(env.TENET_WEBHOOK_SECRET || "").trim() },
        store, tenet, mail, log: (t) => console.log(t) });
    }
    return this._core;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const c = this.core();
    try {
      if (url.pathname === "/tick") { await c.tick(now()); return json({ ok: true }); }
      if (url.pathname === "/api/buy" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(await c.buy(String(b.product || ""), now()));
      }
      if (url.pathname === "/api/tenet-webhook" && req.method === "POST") {
        const r = await c.webhook(await req.text(), req.headers.get("x-tenet-signature") || "", now());
        return json({ ok: r.status === 200 }, r.status);
      }
      const m = /^\/api\/orders\/(TS-[0-9]{6})$/.exec(url.pathname);
      if (m && req.method === "GET") {
        const s = await c.status(m[1]);
        return s ? json(s) : json({ error: "no such order" }, 404);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e).slice(0, 200) }, 400);
    }
  }
}

const shop = (env) => env.SHOP.get(env.SHOP.idFromName("techshopping"));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return shop(env).fetch(req);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(shop(env).fetch("https://shop/tick", { method: "POST" })); },
};
