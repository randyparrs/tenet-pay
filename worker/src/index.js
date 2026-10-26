// Cloudflare entry of the gateway Worker (tenet-gateway). One Durable Object holds all the state and runs the
// core: the cron trigger calls its tick every minute, Email Routing hands it the store emails (order-<number>@ and
// register-<id>@ the mail domain), and the pages' API goes through it too, so there is a single writer.
// Secrets (wrangler secret put): GATEWAY_KEY (the gateway relayer and owner of the gateway judges), OPENROUTER_API_KEY
// (the F1 draft), CIRCLE_API_KEY (Circle wallets for buyers who sign in with Google). Addresses are in gateway-data.json.
import { DurableObject } from "cloudflare:workers";
import cfg from "./gateway-data.json";
import { GatewayCore } from "./core.js";
import { makeArc } from "./arc.js";
import { makeGl } from "./genlayer.js";
import * as dns from "./dns.js";
import * as f1 from "./f1.js";
import { makeCircle, circleApi } from "./circle.js";
import { serve } from "./routes.js";

const secret = (v) => {
  const t = String(v || "").trim();
  return t && !t.startsWith("0x") && /^[0-9a-fA-F]{64}$/.test(t) ? "0x" + t : t;
};
const redact = (e) => String((e && (e.shortMessage || e.message)) || e).replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[pem]")
  .replace(/(0x)?[0-9a-fA-F]{64}/g, "[redacted]").replace(/\b(tk|ws)_[0-9a-f]{48}\b/g, "[redacted]").slice(0, 300);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" } });

export class GatewayState extends DurableObject {
  async core() {
    if (!this._core) {
      const st = this.ctx.storage;
      const store = { get: (k) => st.get(k), put: (k, v) => st.put(k, v), delete: (k) => st.delete(k),
        list: async (p) => [...(await st.list({ prefix: p })).values()] };
      const key = secret(this.env.GATEWAY_KEY);
      const arc = makeArc({ rpc: this.env.ARC_RPC || "https://rpc.testnet.arc.io", chainId: cfg.chain_id, escrow: cfg.escrow,
        abi: cfg.escrow_abi, key });
      const gl = makeGl({ key, judges: cfg.judges, router: cfg.router });
      this._core = new GatewayCore({ cfg, store, arc, gl, dns, f1, openrouterKey: String(this.env.OPENROUTER_API_KEY || "").trim(),
        log: (t) => console.log(t) });
    }
    return this._core;
  }

  async fetch(req) {
    const url = new URL(req.url);
    let core;
    try { core = await this.core(); } catch (e) { this._core = null; return json({ error: "the gateway could not start: " + redact(e) }, 503); }
    const now = () => core.arc.now();
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      if (url.pathname === "/tick") {
        try {
          const out = await core.tick();
          await this.ctx.storage.put("lastTick", { at: Date.now(), out });
          return json(out);
        } catch (e) {
          await this.ctx.storage.put("lastTick", { at: Date.now(), error: redact(e) });
          throw e;
        }
      }
      if (url.pathname === "/email") return json(await core.receiveEmail(body.to, body.raw, await now()));
      const r = await serve(core, cfg, { method: req.method, url: req.url, headers: req.headers, body },
        { lastTick: await this.ctx.storage.get("lastTick") });
      return json(r.body, r.status);
    } catch (e) {
      return json({ error: redact(e) }, 400);
    }
  }
}

const state = (env) => env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
const latin1 = (buf) => { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST",
        "access-control-allow-headers": "content-type,authorization" } });
    }
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (url.pathname.startsWith("/api/circle/")) return circleRoute(req, env, url.pathname.slice("/api/circle/".length));
    return state(env).fetch(req);
  },
  // Cloudflare Email Routing: order-<number>@ and register-<id>@ the mail domain. The raw MIME, as received.
  async email(message, env) {
    if (message.rawSize > 25 * 1024 * 1024) { message.setReject("message too large"); return; }
    const raw = latin1(await new Response(message.raw).arrayBuffer());
    await state(env).fetch("https://gateway/email", { method: "POST", body: JSON.stringify({ to: message.to, raw }) });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(state(env).fetch("https://gateway/tick", { method: "POST" }));
  },
};

/** Circle wallets for buyers: stateless, POST only, nothing stored (as the demo Worker). */
async function circleRoute(req, env, name) {
  if (!env.CIRCLE_API_KEY) return json({ error: "Circle sign-in is not set up" }, 503);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const b = await req.json().catch(() => ({}));
  const c = makeCircle({ apiKey: String(env.CIRCLE_API_KEY).trim(), escrow: cfg.escrow, usdc: cfg.usdc, abi: cfg.escrow_abi });
  const r = await circleApi(c, name, b);
  return json(r.status >= 400 && r.body.error ? { ...r.body, error: redact(r.body.error) } : r.body, r.status);
}
