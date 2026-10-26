// The gateway relayer as one state machine, after the demo Worker's worker/src/core.js.
// Every network call goes through adapters, so the same code runs in the Cloudflare Worker and in the local
// rehearsal (worker/test/rehearsal.mjs):
//   arc   Arc testnet (or anvil): the gateway escrow's events and the relayer's signed transactions
//   gl    GenLayer Bradbury (or the simulated judges): judge steps, verdicts, Lacre attestations, KeyCache, set_merchant
//   dns   the two DoH resolvers (_tenet TXT, DKIM key size)
//   f1    the draft of a store's structure (Llama 3.3 70B through OpenRouter)
//   net   fetch, for the stores' webhooks
//   store persistent key-value storage (a Durable Object, or memory in the rehearsal)
// One tick() runs every minute. It never sends a transaction twice: every Arc transaction is signed and stored before
// it is broadcast, and every Bradbury send is recorded before and after. A verdict, a Lacre record, a key state or a
// store's registered terms count only once their transaction is FINALIZED.
import { verifyMessage, isAddress } from "viem";
import { cj, shaText, fold, orderRef, isoDay, b64, latin1, lower } from "../../tenet/worker/src/util.js";
import { termsHash, render } from "./terms.js";
import { structure as normalize, unsupported, REVIEW } from "./f1.js";
import { split, checkStoreEmail, headersBlob, judgeText, alignedSignature, parseHeaders, signatures, MAX_BODY } from "./mime.js";

const OUTCOME = { REFUND: 1, DENY: 2, INVALID_CLAIM: 3 };
const MAX_ATTEMPTS = 3;
const NO_CONSENSUS_STATUS = new Set(["UNDETERMINED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"]);
const NO_CONSENSUS_RESULT = new Set(["NO_MAJORITY", "MAJORITY_DISAGREE"]);
const DATE = "(20\\d\\d-[01]\\d-[0-3]\\d)\\b";
export const REGISTRATION_PREFIX = "Tenet store registration\n";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function hmac(secret, body) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body))));
}
const judgeOf = (event) => (event === "late" ? "mail" : "subjective");

/** Whether a store email carries the promised date or the delivery date, read with the store's own labels (the same
 *  patterns the email judge uses). My orders turns "It arrived late" off without a delivery date. */
function mailDates(m, x) {
  const text = m.body ? judgeText(m.body) : null;
  if (!text || !x?.profile) return { promised: false, delivered: false };
  const has = (p) => !!p && new RegExp(p).test(text);
  return { promised: has(x.profile.promised_pattern), delivered: has(x.profile.delivery_pattern) };
}
/** The claim as the buyer signed it, without the fields every claim repeats. */
function claimContent(text) {
  let c;
  try { c = JSON.parse(text); } catch { return null; }
  const keep = ["event", "account", "promised", "received", "proof_kind", "proof", "delivered_date", "promised_date", "description"];
  return Object.fromEntries(keep.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
}
/** One registered submission: who, what kind and when; the text of answers and proof, not the bytes of email evidence. */
function submissionView(s) {
  let j = null;
  try { j = JSON.parse(s.raw); } catch { /* the escrow's own markers are not JSON */ }
  const kind = j?.kind || (/"kind":"([a-z_]+)"/.exec(s.raw) || [])[1] || null;
  const party = j?.party || (/"party":"([a-z]+)"/.exec(s.raw) || [])[1] || null;
  const content = kind === "evidence" ? null : typeof j?.content === "string" ? j.content.slice(0, 1000) : j?.content && typeof j.content === "object" ? j.content : null;
  return { kind, party, at: s.at, content };
}

export class GatewayCore {
  // net wraps the global fetch: kept as this.net and called as a method, a bare fetch is an "Illegal invocation" in Workers.
  constructor({ cfg, store, arc, gl, dns, f1, net = (url, init) => fetch(url, init), openrouterKey = "", log = () => {} }) {
    Object.assign(this, { cfg, s: store, arc, gl, dns, f1, net, openrouterKey, log });
  }

  /** The address a store sends an order's emails to. */
  orderAddress(n) {
    return this.cfg.mail_sep === "+" ? `orders+${lower(n)}@${this.cfg.mail_domain}` : `order-${lower(n)}@${this.cfg.mail_domain}`;
  }

  // ---- storage -----------------------------------------------------------------------------------

  async meta() {
    return (await this.s.get("meta")) || { block: null, paused: false, stop: null, failures: 0, confirmed: {} };
  }
  shop(wallet) { return this.s.get("s:" + lower(wallet)); }
  async saveShop(x) { await this.s.put("s:" + lower(x.merchant), x); }
  /** When the store entered its current stage (the panel shows how long each activation stage took); kept from 2026-10-23. */
  stamp(x, now) { x.stages ||= {}; if (!x.stages[x.state]) x.stages[x.state] = Number(now); }
  async shops() { return this.s.list("s:"); }
  order(n) { return this.s.get("o:" + n); }
  async saveOrder(o) { await this.s.put("o:" + o.n, o); }
  async orders() { return (await this.s.list("o:")).sort((a, b) => a.createdAt - b.createdAt); }
  async byRef(ref) { const n = await this.s.get("r:" + lower(ref)); return n ? this.order(n) : null; }
  event(o, at, what, extra = {}) { o.events.push({ at: Number(at), what, ...extra }); }
  pause(meta, reason) { meta.paused = true; meta.stop = reason; this.log("STOP: " + reason); }

  // ---- store registration ------------------------------------

  /** Step 1: a store names its domain and wallet; Tenet answers with the TXT record to publish. */
  async startStore({ domain, wallet }, now) {
    domain = lower(domain || "").trim().replace(/\.$/, "");
    if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error("not a domain name");
    if (!isAddress(wallet || "")) throw new Error("not a wallet address");
    const old = await this.shop(wallet);
    if (old && old.state !== "started") throw new Error("this wallet already has a store (" + old.domain + ")");
    for (const x of await this.shops()) if (x.domain === domain && lower(x.merchant) !== lower(wallet)) throw new Error("this domain is registered by another wallet");
    const id = old?.id || randomHex(6);
    const x = old || { id, merchant: lower(wallet), domain, state: "started", createdAt: Number(now), log: [] };
    this.stamp(x, now);
    await this.saveShop(x);
    await this.s.put("reg:" + id, lower(wallet));
    return this.storeView(wallet, now);
  }

  /** Step 2: the TXT record, through both resolvers. */
  async checkTxt(wallet, now) {
    const x = await this.mustShop(wallet);
    const r = await this.dns.checkOwner(x.domain, x.merchant).catch((e) => ({ ok: false, reason: String(e.message || e), records: [] }));
    x.txt = { ok: r.ok, reason: r.reason, records: r.records, at: Number(now) };
    await this.saveShop(x);
    return this.storeView(wallet, now);
  }

  /** Step 3: the draft of the structure from the pasted policy, always Llama 3.3 70B. */
  async draftTerms(wallet, policy, now) {
    const x = await this.mustShop(wallet);
    if (!x.txt?.ok) throw new Error("publish the TXT record first");
    policy = String(policy || "").trim();
    if (policy.length < 40 || policy.length > 6000) throw new Error("paste the store's refund policy (40 to 6000 characters)");
    const d = await this.f1.draft(policy, this.openrouterKey);
    x.policy = policy;
    x.draft = { structure: d.structure, model: d.model, prompt_sha256: d.prompt_sha256, error: d.error || null, at: Number(now) };
    await this.saveShop(x);
    return { draft: d.structure, review: REVIEW, unsupported: d.structure ? unsupported(d.structure) : [], error: d.error || null,
      note: "A draft only: check every field against your policy, above all the preconditions and the excluded causes, and confirm." };
  }

  /** The message a store signs with its wallet to confirm its registration (EIP-191). */
  registrationMessage(payload) { return REGISTRATION_PREFIX + cj(payload); }

  /** Step 4: the store confirms its terms, signed by its wallet. The API key and the webhook secret are shown once. */
  async confirmStore(wallet, payload, signature, now) {
    const x = await this.mustShop(wallet);
    if (!x.txt?.ok) throw new Error("publish the TXT record first");
    if (x.state !== "started") throw new Error("this store is already confirmed");
    const ok = await verifyMessage({ address: x.merchant, message: this.registrationMessage(payload), signature }).catch(() => false);
    if (!ok) throw new Error("the signature is not from the store's wallet");
    const meta = await this.meta();
    const day = isoDay(now);
    if ((meta.confirmed[day] || 0) >= this.cfg.limits.stores_per_day) throw new Error("the gateway takes 5 new stores a day; try tomorrow");
    const s = normalize(payload.structure);
    if (!s || cj(s) !== cj(payload.structure)) throw new Error("the structure is not in the confirmed form");
    const no = unsupported(s);
    if (no.length) throw new Error("the judges do not support yet: " + no.join("; "));
    const hold = Number(payload.hold_days);
    if (!Number.isInteger(hold) || hold < 7 || hold > 180) throw new Error("hold days from 7 to 180");
    const label = (v, need) => {
      const t = String(v || "");
      if ((need && !t.trim()) || t.length > 40 || /[\r\n]/.test(t)) throw new Error("a label is one line of up to 40 characters");
      return t;
    };
    const promised = label(payload.promised_label, true), delivered = label(payload.delivery_label, false);
    const prefix = String(payload.order_prefix || ""), digits = Number(payload.order_digits);
    if (!/^[A-Za-z][A-Za-z0-9-]{0,7}$/.test(prefix) || !Number.isInteger(digits) || digits < 4 || digits > 10) {
      throw new Error("order numbers: a prefix of 1 to 8 letters, digits or dashes, then 4 to 10 digits");
    }
    if (!/^https:\/\/[^\s]+$/.test(String(payload.webhook_url || ""))) throw new Error("the webhook URL has to be https");
    const apiKey = "tk_" + randomHex(24), secret = "ws_" + randomHex(24);
    x.structure = s;
    x.hold_days = hold;
    x.labels = { promised, delivered };
    x.profile = { domain: x.domain, order_pattern: `\\b${escapeRe(prefix)}\\d{${digits}}\\b`,
      promised_pattern: `(?:${escapeRe(promised.trim())} ?)${DATE}`, delivery_pattern: delivered.trim() ? `(?:${escapeRe(delivered.trim())} ?)${DATE}` : "" };
    x.order_prefix = prefix;
    x.order_digits = digits;
    x.webhook_url = payload.webhook_url;
    x.webhook_secret = secret;
    x.api_key_hash = shaText(apiKey);
    x.terms_hash = await termsHash(s, hold, this.cfg.windows_text);
    x.state = "test_email";
    x.confirmedAt = Number(now);
    this.stamp(x, now);
    meta.confirmed[day] = (meta.confirmed[day] || 0) + 1;
    await this.s.put("k:" + x.api_key_hash, x.merchant);
    await this.saveShop(x);
    await this.s.put("meta", meta);
    return { ...(await this.storeView(wallet, now)), api_key: apiKey, webhook_secret: secret,
      shown_once: "Keep the API key and the webhook secret now: Tenet keeps only the API key's hash." };
  }

  async mustShop(wallet) {
    const x = await this.shop(wallet || "");
    if (!x) throw new Error("no store for this wallet");
    return x;
  }

  // ---- emails (Cloudflare Email Routing) ------------------------------------------------------------

  /** A message to the gateway's addresses: register-<id>@ or order-<number>@ (the store's order emails). */
  async receiveEmail(to, raw, now) {
    const local = lower(to).split("@")[0];
    let m;
    // Two address forms (cfg.mail_sep): order-<n>@ (a catch-all on an apex domain) or orders+<n>@ (plus addressing
    // on a subdomain, where Email Routing takes only literal addresses)
    if ((m = /^register[-+]([0-9a-f]{12})$/.exec(local))) return this.registrationEmail(m[1], raw, now);
    if ((m = /^orders?[-+]([a-z0-9-]{1,40})$/.exec(local))) return this.orderEmail(m[1], raw, now);
    return { ignored: "unknown address" };
  }

  async registrationEmail(id, raw, now) {
    const wallet = await this.s.get("reg:" + id);
    const x = wallet && (await this.shop(wallet));
    if (!x || x.state !== "test_email") return { ignored: "no store waiting for a test email at this address" };
    const c = checkStoreEmail(raw);
    if (c.domain && c.domain !== x.domain) c.problems.push(`signed by ${c.domain}, not by ${x.domain}`);
    let bits = 0;
    if (!c.problems.length) {
      bits = await this.dns.dkimBits(x.domain, c.selector).catch(() => 0);
      if (bits < 1024) c.problems.push("the DKIM key could not be read through both resolvers, or it is under 1024 bits");
    }
    x.test = { ok: !c.problems.length, problems: c.problems, selector: c.selector, multipart: c.multipart, text_part: c.text_part,
      body_bytes: c.body_bytes, at: Number(now) };
    if (x.test.ok) {
      x.selector = c.selector;
      x.profile.selector = c.selector;
      x.profile.min_key_bits = bits >= 2048 ? 2048 : 1024;
      x.state = "key";
      this.stamp(x, now);
    }
    await this.saveShop(x);
    return { test: x.test };
  }

  async orderEmail(localNumber, raw, now) {
    const n = await this.s.get("ol:" + localNumber);
    const o = n && (await this.order(n));
    if (!o) return { ignored: "no such order" };
    const x = await this.shop(o.merchant);
    const sig = alignedSignature(raw);
    if (sig.domain !== x.domain || sig.selector !== x.selector) {
      this.event(o, now, "An email to this order's address that the store did not sign was ignored", { net: "store" });
      await this.saveOrder(o);
      return { ignored: "not signed by the store" };
    }
    const { head, body } = split(raw);
    const fields = parseHeaders(head);
    const tags = signatures(fields).find((s) => s.d === sig.domain && s.s === sig.selector).tags;
    const subject = (fields.find(([k]) => k.trim().toLowerCase() === "subject") || ["", ""])[1].replace(/\r\n/g, "").trim().slice(0, 120);
    const id = shaText(raw).slice(2, 14);
    if (o.mails.some((m) => m.id === id)) return { ignored: "already received" };
    const mail = { id, subject, receivedAt: Number(now), body_bytes: body.length, bh: (tags.bh || "").replace(/\s+/g, ""),
      attempts: [], record: null };
    if (body.length > MAX_BODY) {
      mail.state = "too_large";
      this.event(o, now, `Store email received, over 12 KB: the judge ignores it (${subject})`, { net: "store" });
    } else {
      mail.state = "attesting";
      mail.blob = headersBlob(raw, sig.domain, sig.selector);
      mail.body = body;
      mail.readable = judgeText(body) !== null;
      this.event(o, now, `Store email received: ${subject}`, { net: "store" });
    }
    o.mails.push(mail);
    await this.saveOrder(o);
    return { mail: mail.id, state: mail.state };
  }

  // ---- orders (the store's server, with its API key) ------------------------------------------------

  async shopByKey(apiKey) {
    const w = await this.s.get("k:" + shaText(String(apiKey || "")));
    return w ? this.shop(w) : null;
  }

  /** The store creates the order it wants paid; the checkout page shows exactly this. */
  async createOrder(apiKey, b, now) {
    const x = await this.shopByKey(apiKey);
    if (!x) throw new Error("unknown API key");
    if (x.state !== "active") {
      throw new Error(x.key?.activeAt ? `Pending activation: the store's DKIM key is active from ${new Date(x.key.activeAt * 1000).toISOString()}`
        : "the store is not active yet");
    }
    const n = String(b.order_number || "");
    if (!new RegExp(`^${x.profile.order_pattern.replace(/^\\b|\\b$/g, "")}$`).test(n)) throw new Error("the order number does not follow the store's format");
    if (await this.order(n)) throw new Error("this order number already exists");
    const amount = Number(b.amount_cents);
    if (!Number.isInteger(amount) || amount < 1 || amount > this.cfg.max_amount_cents) throw new Error(`amount from 1 to ${this.cfg.max_amount_cents} cents`);
    const description = String(b.description || "").slice(0, 300);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 20).map((i) => ({ name: String(i.name || "").slice(0, 80),
      qty: Math.max(1, Math.min(99, Number(i.qty) || 1)), price_cents: Math.max(0, Number(i.price_cents) || 0) }));
    const returnUrl = /^https:\/\/[^\s]+$/.test(String(b.return_url || "")) ? b.return_url : null;
    const o = { n, ref: orderRef(n), merchant: x.merchant, amount: amount * 1e4, description, items, return_url: returnUrl,
      createdAt: Number(now), events: [], subs: [], steps: [], mails: [], logs: [] };
    await this.saveOrder(o);
    await this.s.put("r:" + lower(o.ref), n);
    await this.s.put("ol:" + lower(n), n);
    return { order: n, checkout_url: `${this.cfg.site_url}/#pay/${encodeURIComponent(n)}`, email_to: this.orderAddress(n) };
  }

  /** What the checkout page needs; it renders the terms from the structure and checks their hash itself. */
  async checkout(n) {
    const o = await this.order(n);
    if (!o) return null;
    const x = await this.shop(o.merchant);
    return { order: o.n, ref: o.ref, merchant: o.merchant, domain: x.domain, amount_cents: o.amount / 1e4, description: o.description,
      items: o.items, return_url: o.return_url, paid: !!o.paidAt, paid_at: o.paidAt || null, pay_tx: o.payTx || null,
      store_notified_at: o.notifiedAt || null, chain_id: this.cfg.chain_id, escrow: this.cfg.escrow, usdc: this.cfg.usdc,
      terms: { structure: x.structure, hold_days: x.hold_days, windows: this.cfg.windows_text, terms_hash: x.terms_hash } };
  }

  // ---- the tick -------------------------------------------------------------------------------------

  async tick() {
    const meta = await this.meta();
    if (meta.paused) return { paused: meta.stop };
    const now = await this.arc.now();
    await this.resolveArc(meta);
    await this.scan(meta, now);
    await this.s.put("meta", meta);
    const budget = { relayer: 6, gl: 3 };
    for (const x of await this.shops()) {
      if (meta.paused) break;
      if (["key", "key_pending", "judges", "escrow"].includes(x.state)) {
        try { await this.registerStep(x, now, budget, meta); } finally { this.stamp(x, now); await this.saveShop(x); }
      }
    }
    for (const o of await this.orders()) {
      if (meta.paused) break;
      if (o.settled) continue;
      try { await this.stepOrder(o, now, budget, meta); } finally { await this.saveOrder(o); }
    }
    await this.webhooks(now);
    await this.s.put("meta", meta);
    return { now, paused: meta.paused ? meta.stop : null };
  }

  // ---- Arc transactions: signed and stored first, then broadcast ---------------------------------------

  async send(meta, o, fn, args, label) {
    if (await this.s.get("tx:relayer")) return false;
    let prep;
    try {
      prep = await this.arc.prepare(fn, args);
    } catch (e) {
      meta.failures = (meta.failures || 0) + 1;
      this.log(`NOT SENT ${label} ${o?.n || ""}: ${e.message}`);
      if (meta.failures >= 2) this.pause(meta, `two transactions in a row would revert (${label}: ${e.message})`);
      return false;
    }
    await this.s.put("tx:relayer", { ...prep, order: o?.n || null, label, fn });
    await this.arc.broadcast(prep.raw);
    if (o?.events) this.event(o, await this.arc.now(), label, { tx: prep.hash, net: "arc" });
    const r = await this.arc.waitReceipt(prep.hash, 10_000);
    if (r) await this.settleArc(meta, { ...prep, label }, r);
    return prep.hash;
  }

  async settleArc(meta, p, r) {
    await this.s.delete("tx:relayer");
    if (r.status !== "success") {
      meta.failures = (meta.failures || 0) + 1;
      this.log(`REVERTED ${p.label}: ${p.hash}`);
      if (meta.failures >= 2) this.pause(meta, `two transactions in a row reverted (${p.label})`);
    } else meta.failures = 0;
  }

  async resolveArc(meta) {
    const p = await this.s.get("tx:relayer");
    if (!p) return;
    let r = await this.arc.receipt(p.hash);
    if (!r) { await this.arc.broadcast(p.raw); r = await this.arc.receipt(p.hash); if (!r) return; }
    await this.settleArc(meta, p, r);
  }

  /** A Bradbury send, recorded before it is made; null if the budget is spent. */
  async glSend(rec, budget, fn, save) {
    if (budget.gl <= 0) return null;
    const at = { startedAt: Number(await this.arc.now()), tx: null };
    rec.attempts = [...(rec.attempts || []), at];
    await save();
    budget.gl--;
    try { at.tx = await fn(); } catch (e) { at.error = String(e.message || e).slice(0, 200); }
    return at;
  }

  // ---- registration on chain: KeyCache, then the two judges, then the escrow ----------------------------

  async registerStep(x, now, budget, meta) {
    const save = () => this.saveShop(x);
    x.key ||= { attempts: [] };
    if (x.state === "key") {
      // register_key is open to anyone; a key already in the KeyCache is reused as it is.
      const ks = await this.gl.keyStatus(x.domain, x.selector, true);
      if (ks && ks.state === "active") { x.state = "judges"; return; }
      if (ks && ks.state === "pending" && ks.first_seen) {
        x.key.activeAt = Math.floor(Date.parse(ks.first_seen) / 1000) + 86400;
        x.state = "key_pending";
        return;
      }
      const last = x.key.attempts[x.key.attempts.length - 1];
      if (last && !last.done) {
        const st = last.tx ? await this.gl.status(last.tx) : null;
        if (!(last.tx ? st && st.done : now - last.startedAt >= 900)) return;
        last.done = true;
        if (x.key.attempts.length >= MAX_ATTEMPTS) { x.state = "failed"; x.failure = "the DKIM key could not be registered in Lacre's KeyCache"; }
        return; // read the key state on the next tick
      }
      await this.glSend(x.key, budget, () => this.gl.registerKey(x.domain, x.selector), save);
      return;
    }
    if (x.state === "key_pending") {
      if (now < x.key.activeAt + 60) return;
      x.key.confirm ||= { attempts: [] };
      const c = x.key.confirm, last = c.attempts[c.attempts.length - 1];
      if (last && !last.done) {
        const st = last.tx ? await this.gl.status(last.tx) : null;
        if (!(last.tx ? st && st.done : now - last.startedAt >= 900)) return;
        last.done = true;
        const ks = await this.gl.keyStatus(x.domain, x.selector, true);
        if (ks && ks.state === "active") { x.state = "judges"; x.key.activatedAt = ks.activated_at || null; }
        else if (c.attempts.length >= MAX_ATTEMPTS) { x.state = "failed"; x.failure = "confirm_key did not activate the DKIM key"; }
        return;
      }
      await this.glSend(c, budget, () => this.gl.confirmKey(x.domain, x.selector), save);
      return;
    }
    if (x.state === "judges") {
      x.judges ||= { mail: { attempts: [] }, subjective: { attempts: [] } };
      const terms = cj({ domain: x.domain, structure: x.structure, profile: x.profile, terms_hash: x.terms_hash });
      for (const kind of ["mail", "subjective"]) {
        const j = x.judges[kind];
        if (j.done) continue;
        const last = j.attempts[j.attempts.length - 1];
        if (last && !last.done) {
          const st = last.tx ? await this.gl.status(last.tx) : null;
          if (!(last.tx ? st && st.done : now - last.startedAt >= 900)) return;
          last.done = true;
          const got = await this.gl.getMerchant(kind, x.merchant, x.terms_hash, true);
          if (got && JSON.parse(got).terms_hash === x.terms_hash) { j.done = true; continue; }
          if (j.attempts.length >= MAX_ATTEMPTS) { x.state = "failed"; x.failure = `set_merchant on the ${kind} judge did not register`; }
          return;
        }
        await this.glSend(j, budget, () => this.gl.setMerchant(kind, x.merchant, terms), save);
        return;
      }
      x.state = "escrow";
    }
    if (x.state === "escrow") {
      const t = await this.arc.merchantTerms(x.merchant);
      if (t.terms_hash === x.terms_hash && t.hold_seconds === x.hold_days * 86400) {
        x.state = "active";
        x.activeSince = Number(now);
        await this.queueWebhook(x, "store_active", { domain: x.domain, terms_hash: x.terms_hash }, now);
        return;
      }
      if (budget.relayer > 0 && !x.escrowTx) {
        const h = await this.send(meta, null, "setMerchantTerms", [x.merchant, x.hold_days * 86400, x.terms_hash], "Store terms registered on the escrow");
        if (h) { budget.relayer--; x.escrowTx = h; }
      } else if (x.escrowTx && !(await this.s.get("tx:relayer"))) {
        x.escrowTx = null; // mined but the terms are not there: send again next tick
      }
    }
  }

  // ---- events of the gateway escrow --------------------------------------------------------------------

  async scan(meta, now) {
    const latest = await this.arc.latestBlock();
    let from = meta.block == null ? (this.cfg.deploy_block ?? 0) : meta.block + 1;
    while (from <= latest) {
      const to = Math.min(latest, from + 9_999);
      for (const ev of await this.arc.logs(from, to)) await this.apply(ev, now);
      meta.block = to;
      from = to + 1;
    }
  }

  async apply(ev, now) {
    const a = ev.args;
    if (ev.name === "Withdrawn") { await this.withdrawn(ev); return; }
    let o = await this.byRef(a.orderRef);
    const id = `${ev.tx}:${ev.index}`;
    if (o && (o.logs || []).includes(id)) return;
    if (ev.name === "OrderPaid") {
      const x = await this.shop(a.merchant);
      if (!x) return; // not a gateway store
      if (!o) { // paid without an order of the store: the store refunds it from its panel
        o = { n: "unknown-" + lower(a.orderRef).slice(2, 12), ref: lower(a.orderRef), merchant: lower(a.merchant), description: "", items: [],
          createdAt: Number(ev.time), events: [], subs: [], steps: [], mails: [], logs: [], unknown: true };
        await this.s.put("r:" + lower(o.ref), o.n);
      }
      Object.assign(o, { buyer: lower(a.buyer), paidAt: Number(ev.time), paidAmount: Number(a.amount), termsHash: lower(a.termsHash), payTx: ev.tx });
      this.event(o, ev.time, "Paid into the escrow", { tx: ev.tx, net: "arc" });
      const why = o.unknown ? "the store never created this order" : lower(a.merchant) !== o.merchant ? "paid to another store"
        : Number(a.amount) !== o.amount ? "a different amount" : lower(a.termsHash) !== x.terms_hash ? "other terms" : null;
      if (why) o.unexpected = why;
      await this.queueWebhook(x, why ? "unexpected_payment" : "paid", { order: o.n, buyer: o.buyer, tx: ev.tx, reason: why }, now);
    } else if (!o) {
      return;
    } else if (ev.name === "ClaimOpened") {
      let event = "?";
      try { event = JSON.parse(a.claim).event; } catch { /* the judge gives INVALID_CLAIM */ }
      o.claim = { text: a.claim, hash: lower(a.claimHash), chain: lower(a.chain), at: Number(ev.time), event, judge: judgeOf(event) };
      o.judged = lower(a.chain);
      this.event(o, ev.time, "Claim opened by the buyer", { tx: ev.tx, net: "arc" });
      await this.queueWebhook(await this.shop(o.merchant), "claim_opened", { order: o.n, event, tx: ev.tx }, now);
    } else if (ev.name === "Submitted") {
      const raw = a.submission;
      o.subs.push({ raw, chain: lower(a.chain), by: lower(a.by), at: Number(ev.time) });
      const kind = (() => { try { return JSON.parse(raw).kind; } catch { return "?"; } })();
      const who = lower(a.by) === o.buyer ? "buyer" : lower(a.by) === o.merchant ? "store" : "anyone";
      this.event(o, ev.time, `Registered: ${kind.replace(/_/g, " ")} (${who})`, { tx: ev.tx, net: "arc" });
    } else if (ev.name === "ProofRequested") {
      o.proofRequestedAt = Number(ev.time);
      this.event(o, ev.time, "Proof requested from the buyer", { tx: ev.tx, net: "arc" });
    } else if (ev.name === "VerdictProposed") {
      o.proposed = { outcome: Number(a.outcome), cents: Number(a.refundCents), after: Number(a.executeAfter) };
      this.event(o, ev.time, "Verdict proposed on Arc", { tx: ev.tx, net: "arc" });
    } else if (ev.name === "OrderSettled") {
      o.settled = { refund: Number(a.refund), released: Number(a.released), verdictRef: lower(a.verdictRef), tx: ev.tx, at: Number(ev.time) };
      this.event(o, ev.time, "Settled on Arc", { tx: ev.tx, net: "arc" });
      await this.queueWebhook(await this.shop(o.merchant), "settled", { order: o.n, refund: o.settled.refund, released: o.settled.released, tx: ev.tx }, now);
    } else {
      return;
    }
    o.logs = [...(o.logs || []), id];
    await this.saveOrder(o);
  }

  // ---- one order -------------------------------------------------------------------------------------

  has(o, kind, party) { return o.subs.some((s) => s.raw.endsWith(`"kind":"${kind}","party":"${party}"}`)); }

  async stepOrder(o, now, budget, meta) {
    await this.attestMails(o, now, budget);
    if (!o.claim || o.unexpected) return;
    const w = this.cfg.windows_seconds;
    const has = (k, p) => this.has(o, k, p);
    const lastFinal = [...o.steps].reverse().find((s) => s.final)?.final;
    // The store's response window: for the subjective judge always; for the email judge only while it waits for a
    // readable email (an unreadable email never harms the buyer).
    const waitsStore = o.claim.judge === "subjective" || lastFinal?.reason === "store email unreadable";
    if (waitsStore && !has("response", "merchant") && !has("no_response", "escrow") && now >= o.claim.at + w.response && !o.marked && budget.relayer > 0) {
      if (await this.send(meta, o, "markNoResponse", [o.ref], "No-response marker after the window")) { budget.relayer--; o.marked = true; }
    }
    if (has("closing_open", "escrow")) {
      const opened = o.subs.find((s) => s.raw.endsWith('"kind":"closing_open","party":"escrow"}')).at;
      const both = has("closing_response", "merchant") && (has("closing_proof", "buyer") || has("closing_statement", "buyer"));
      if (!both && !has("closing_timeout", "escrow") && now >= opened + w.closing && !o.closingMarked && budget.relayer > 0) {
        if (await this.send(meta, o, "markClosingTimeout", [o.ref], "Closing round timed out")) { budget.relayer--; o.closingMarked = true; }
      }
    }
    const cur = o.steps[o.steps.length - 1];
    if (cur && !cur.final) { await this.follow(o, cur, meta, now, budget); return; }
    if (cur && cur.final && !cur.acted) { await this.act(o, cur, meta, budget, now); return; }
    if (o.proposed && !o.executed && now >= o.proposed.after && budget.relayer > 0) {
      if (await this.send(meta, o, "executeVerdict", [o.ref], "Verdict executed")) { budget.relayer--; o.executed = true; }
      return;
    }
    if (o.proofRequestedAt && !has("proof", "buyer") && now >= o.proofRequestedAt + w.proof && !o.unproven && budget.relayer > 0) {
      if (await this.send(meta, o, "releaseUnproven", [o.ref], "Released to the store: proof not provided")) { budget.relayer--; o.unproven = true; }
      return;
    }
    if (!o.proposed && this.ready(o, now, has) && budget.gl > 0) await this.judge(o, meta, budget, now);
  }

  pending(o) {
    const chains = [o.claim.chain, ...o.subs.map((s) => s.chain)];
    const i = chains.indexOf(o.judged);
    return i < 0 ? null : o.subs.slice(i).map((s) => s.raw);
  }

  ready(o, now, has) {
    const p = this.pending(o);
    if (!p) return false;
    if (o.claim.judge === "mail") {
      // the first step needs at least one email; later steps run on each new registration, a minute after the last
      if (!p.length) return false;
      return now - o.subs[o.subs.length - 1].at >= 60;
    }
    if (!p.length) return false;
    if (o.proofRequestedAt) return has("proof", "buyer");
    if (has("closing_open", "escrow")) {
      const both = has("closing_response", "merchant") && (has("closing_proof", "buyer") || has("closing_statement", "buyer"));
      return both || has("closing_timeout", "escrow");
    }
    return has("response", "merchant") || has("no_response", "escrow");
  }

  async judge(o, meta, budget, now) {
    const pend = this.pending(o);
    let cur = o.judged;
    for (const raw of pend) cur = fold(cur, raw);
    const onArc = await this.arc.getOrder(o.ref);
    if (lower(onArc.chain) !== cur || lower(onArc.claimHash) !== shaText(o.claim.text)) {
      this.pause(meta, `${o.n}: what was registered does not fold to the escrow chain`);
      return;
    }
    const n = o.steps.filter((s) => s.final).length + 1;
    let st = o.steps.find((s) => s.n === n && !s.final);
    if (!st) { st = { n, from: o.judged, to: cur, count: pend.length, attempts: [] }; o.steps.push(st); }
    if (st.attempts.length >= MAX_ATTEMPTS) return; // left to the escrow's stall release
    const step = cj({ chain: o.judged, submissions: pend });
    const at = await this.glSend(st, budget, () => this.gl.sendJudge(o.claim.judge, o.claim.text, step), () => this.saveOrder(o));
    if (at?.tx) this.event(o, now, `Step ${n} sent to the judge, attempt ${st.attempts.length}`, { tx: at.tx, net: "bradbury" });
  }

  async follow(o, st, meta, now, budget) {
    const at = st.attempts[st.attempts.length - 1];
    if (!at) return;
    const status = at.tx ? await this.gl.status(at.tx) : null;
    const final = status && status.status === "FINALIZED" ? await this.gl.verdict(o.claim.judge, st.to, true) : null;
    if (final && final.outcome && final.outcome !== "NO_CONSENSUS") {
      if (lower(final.chain) !== st.to || lower(final.claim_hash) !== o.claim.hash) {
        this.pause(meta, `${o.n} step ${st.n}: the verdict is for another chain or claim`);
        return;
      }
      st.final = final;
      at.result = "accepted";
      o.judged = st.to;
      this.event(o, now, `Step ${st.n} final: ${final.outcome} ${(final.refund_cents / 100).toFixed(2)} USDC (${final.reason})`, { tx: at.tx, net: "bradbury" });
      await this.queueWebhook(await this.shop(o.merchant), "verdict", { order: o.n, step: st.n, outcome: final.outcome,
        refund_cents: final.refund_cents, reason: final.reason, action: final.action }, now);
      return;
    }
    if (status && !status.done) {
      const stuck = NO_CONSENSUS_STATUS.has(status.status) || NO_CONSENSUS_RESULT.has(status.result);
      at.noConsensusAt = stuck ? at.noConsensusAt || status.lastVote || Number(now) : null;
    }
    if (!st.decided) {
      const nf = await this.gl.verdict(o.claim.judge, st.to, false);
      if (nf && nf.outcome && nf.outcome !== "NO_CONSENSUS") {
        st.decided = { outcome: nf.outcome, refund_cents: nf.refund_cents, reason: nf.reason, action: nf.action };
      }
    }
    const over = at.tx ? !!(status && status.done) : now - at.startedAt >= 900;
    if (over) {
      at.result = at.tx ? `no consensus (${status.result || status.status}), resent` : "not sent";
      st.decided = null;
      if (st.attempts.length < MAX_ATTEMPTS && budget.gl > 0 && this.pending(o)) await this.judge(o, meta, budget, now);
    }
  }

  async act(o, st, meta, budget) {
    const v = st.final;
    const onArc = await this.arc.getOrder(o.ref);
    if (lower(onArc.chain) !== lower(v.chain) || lower(onArc.claimHash) !== lower(v.claim_hash)) {
      if (o.settled || onArc.state !== 1) { st.acted = true; return; } // 1 = Open: settled since, nothing to take to Arc
      this.pause(meta, `${o.n}: the escrow changed since the verdict`);
      return;
    }
    // Already on Arc (a restart after the broadcast and before this step was saved): the escrow's events say so.
    if ((v.action === "decide" && o.proposed) || (v.action === "request_proof" && o.proofRequestedAt)
        || (v.action === "open_closing_round" && this.has(o, "closing_open", "escrow"))) { st.acted = true; return; }
    if (budget.relayer <= 0) return;
    const tx = st.attempts[st.attempts.length - 1].tx;
    let ok = false;
    if (v.action === "open_closing_round") ok = await this.send(meta, o, "openClosingRound", [o.ref], "Closing round opened");
    else if (v.action === "request_proof") ok = await this.send(meta, o, "requestProof", [o.ref], "Proof requested");
    else if (v.action === "decide" && OUTCOME[v.outcome]) {
      ok = await this.send(meta, o, "proposeVerdict", [o.ref, OUTCOME[v.outcome], v.refund_cents, v.claim_hash, v.chain,
        "0x" + tx.slice(2).padStart(64, "0").slice(-64)], "Verdict proposed");
    } else { st.acted = true; return; } // "wait": nothing to take to Arc
    if (ok) { budget.relayer--; st.acted = true; }
  }

  // ---- the store's order emails on Lacre -------------------------------------------------------------

  async attestMails(o, now, budget) {
    for (const m of o.mails) {
      if (m.state !== "attesting") continue;
      const a = m.attempts[m.attempts.length - 1];
      if (a && !a.done) {
        const st = a.tx ? await this.gl.status(a.tx) : null;
        const rid = st && st.status === "FINALIZED" ? await this.gl.findRecord(m.bh, true) : null;
        if (rid != null) {
          m.record = String(rid);
          m.state = "attested";
          a.done = true;
          this.event(o, now, `Store email attested on Lacre: record ${rid} (${m.subject})`, { tx: a.tx, net: "lacre" });
          continue;
        }
        if (!(a.tx ? st && st.done : now - a.startedAt >= 900)) continue;
        a.done = true;
      }
      if (m.attempts.length >= MAX_ATTEMPTS) { m.state = "not_attested"; continue; }
      const x = await this.shop(o.merchant);
      // the body goes along only for the rehearsal's simulated Lacre, which checks the signature; Lacre takes the blob
      const at = await this.glSend(m, budget, () => this.gl.attest(m.blob, x.domain, x.selector, m.body), () => this.saveOrder(o));
      if (at?.tx) this.event(o, now, `Store email sent to Lacre (${m.subject})`, { tx: at.tx, net: "lacre" });
    }
  }

  evidence(m) {
    return cj({ party: "buyer", kind: "evidence", content: { record_id: String(m.record), body_b64: b64(latin1(m.body)) } });
  }

  // ---- webhooks (HMAC-SHA256 with the store's secret) -------------------------------------------------

  async queueWebhook(x, type, data, now) {
    if (!x?.webhook_url) return;
    const id = randomHex(8);
    await this.s.put("w:" + id, { id, url: x.webhook_url, merchant: x.merchant, body: cj({ type, data, at: Number(now) }), tries: 0, next: Number(now) });
  }

  async webhooks(now) {
    for (const h of (await this.s.list("w:")).slice(0, 10)) {
      if (h.next > now) continue;
      const x = await this.shop(h.merchant);
      let ok = false;
      const seen = { at: Number(now), id: h.id, type: JSON.parse(h.body).type, url: h.url, try: h.tries, status: null, response: "", error: null };
      try {
        const r = await this.net(h.url, { method: "POST", body: h.body, headers: { "content-type": "application/json",
          "x-tenet-signature": "sha256=" + (await hmac(x.webhook_secret, h.body)) } });
        ok = r.status >= 200 && r.status < 300;
        seen.status = r.status;
        seen.response = typeof r.text === "function" ? String(await r.text().catch(() => "")).slice(0, 300) : "";
      } catch (e) { ok = false; seen.error = String((e && e.message) || e).slice(0, 300); }
      await this.webhookSeen(h.merchant, seen);
      if (ok && seen.type === "paid") await this.markNotified(JSON.parse(h.body).data?.order, now);
      if (ok || h.tries >= 5) await this.s.delete("w:" + h.id);
      else await this.s.put("w:" + h.id, { ...h, tries: h.tries + 1, next: Number(now) + 60 * 2 ** h.tries });
    }
  }

  /** The checkout shows when the store heard of the payment: the first "paid" notice its webhook accepted. */
  async markNotified(n, now) {
    const o = n ? await this.order(n) : null;
    if (!o || o.notifiedAt) return;
    o.notifiedAt = Number(now);
    await this.saveOrder(o);
  }

  /** A store's terms as the escrow holds them, read on Arc by the Worker: the checkout's fallback when the visitor's
   *  browser cannot reach the RPC (the page still hashes the text it shows and compares). */
  async escrowTerms(merchant) {
    return this.arc.merchantTerms(merchant);
  }

  /** Every delivery attempt, the last 30 per store: when, where, the HTTP status, the start of the answer or the error. */
  async webhookSeen(merchant, seen) {
    const k = "wl:" + lower(merchant);
    await this.s.put(k, [...((await this.s.get(k)) || []), seen].slice(-30));
    this.log(`webhook ${seen.type} ${seen.url} try ${seen.try}: ${seen.status ?? seen.error}`);
  }

  /** What a store's webhooks look like from the gateway: the URL kept at registration, the attempts and what is queued.
   *  Only for the store itself: null unless the API key is the one of this wallet's store. */
  async webhookView(apiKey, wallet) {
    const x = await this.shopByKey(apiKey);
    if (!x || x.merchant !== lower(wallet)) return null;
    const queued = (await this.s.list("w:")).filter((h) => h.merchant === x.merchant).map((h) => ({ id: h.id, type: JSON.parse(h.body).type, tries: h.tries, next: h.next }));
    return { url: x.webhook_url || null, attempts: (await this.s.get("wl:" + x.merchant)) || [], queued };
  }

  /** The store asks, with its API key, for the "paid" notice of one of its paid orders again (a lost webhook). */
  async resendPaid(apiKey, n, now) {
    const x = await this.shopByKey(apiKey);
    if (!x) return null;
    const o = await this.order(n);
    if (!o || o.merchant !== x.merchant) throw new Error("no such order for this store");
    if (!o.paidAt || o.unknown) throw new Error("the order is not paid");
    await this.queueWebhook(x, "paid", { order: o.n, buyer: o.buyer, tx: o.payTx, reason: null }, now);
    return { queued: true, order: o.n };
  }

  // ---- what the pages show ---------------------------------------------------------------------------

  async storeView(wallet, now) {
    const x = await this.shop(wallet);
    if (!x) return null;
    const out = { merchant: x.merchant, domain: x.domain, state: x.state, failure: x.failure || null,
      txt: { name: `_tenet.${x.domain}`, value: `tenet-merchant=${x.merchant}`, check: x.txt || null },
      test_address: this.cfg.mail_sep === "+" ? `register+${x.id}@${this.cfg.mail_domain}` : `register-${x.id}@${this.cfg.mail_domain}`, test: x.test || null, selector: x.selector || null,
      terms: x.structure ? { structure: x.structure, hold_days: x.hold_days, labels: x.labels, terms_hash: x.terms_hash,
        text: render(x.structure, x.hold_days, this.cfg.windows_text), min_key_bits: x.profile?.min_key_bits || null } : null,
      draft: x.draft || null, active_at: x.key?.activeAt || null, active_since: x.activeSince || null,
      confirmed_at: x.confirmedAt || null, stages: x.stages || null };
    if (["key", "key_pending", "judges", "escrow"].includes(x.state)) {
      out.pending = x.key?.activeAt
        ? `Pending activation: the store's DKIM key is in Lacre's 24-hour quarantine until ${new Date(x.key.activeAt * 1000).toISOString().replace(".000", "")}; orders can be created after that.`
        : "Pending activation: registering the store's DKIM key in Lacre's KeyCache.";
    }
    if (x.state === "active") {
      const mine = (await this.orders()).filter((o) => o.merchant === x.merchant);
      out.orders = await Promise.all(mine.slice(-50).map((o) => this.orderView(o.n, now, "store")));
    }
    return out;
  }

  /** A wallet's withdrawals from the escrow (My orders tells which refunds are still waiting in the escrow). */
  async withdrawn(ev) {
    const k = "wd:" + lower(ev.args.account);
    const list = (await this.s.get(k)) || [];
    const id = `${ev.tx}:${ev.index}`;
    if (list.some((w) => w.id === id)) return;
    list.push({ id, at: Number(ev.time), amount: Number(ev.args.amount), token: lower(ev.args.token), tx: ev.tx });
    await this.s.put(k, list.slice(-50));
  }
  async withdrawalsOf(address) {
    return ((await this.s.get("wd:" + lower(address))) || []).map(({ at, amount, tx }) => ({ at, amount, tx }));
  }

  async ordersOf(address) {
    const a = lower(address);
    return (await this.orders()).filter((o) => o.buyer === a).slice(-50).map((o) => ({ order: o.n, paid_at: o.paidAt || null, merchant: o.merchant }));
  }

  /** One order for My orders (role buyer) or for the store panel (role store): what happened and the next action. */
  async orderView(n, now, role = "buyer") {
    const o = await this.order(n);
    if (!o) return null;
    const x = await this.shop(o.merchant);
    const w = this.cfg.windows_seconds;
    const out = { order: o.n, ref: o.ref, merchant: o.merchant, domain: x?.domain, description: o.description, items: o.items,
      amount_cents: o.amount ? o.amount / 1e4 : (o.paidAmount || 0) / 1e4, buyer: o.buyer || null, paid: !!o.paidAt, paid_at: o.paidAt || null,
      store_notified_at: o.notifiedAt || null,
      // Tenet's own address for this order, where the store sends its emails (no other address is ever shown).
      mail_to: this.orderAddress(o.n),
      unexpected: o.unexpected || null, events: o.events, claim: o.claim ? { event: o.claim.event, judge: o.claim.judge, at: o.claim.at } : null,
      steps: o.steps.map((s) => ({ n: s.n, decided: s.decided || null, final: s.final ? { outcome: s.final.outcome, refund_cents: s.final.refund_cents,
        reason: s.final.reason, action: s.final.action } : null, attempts: s.attempts.map((a) => ({ tx: a.tx, result: a.result || "pending",
        no_consensus_at: a.noConsensusAt || null })) })),
      mails: o.mails.map((m) => ({ id: m.id, subject: m.subject, state: m.state, readable: m.readable ?? null, record: m.record,
        body_bytes: m.body_bytes, tx: m.attempts[m.attempts.length - 1]?.tx || null, received_at: m.receivedAt || null, dates: mailDates(m, x) })),
      settled: o.settled || null, next: null,
      // What the buyer and the store registered on the escrow (already public there). Email evidence shows its kind only.
      claim_content: o.claim ? claimContent(o.claim.text) : null,
      submissions: o.subs.map((s) => submissionView(s)),
      proof_requested_at: o.proofRequestedAt || null,
      windows_seconds: w };
    if (!o.paidAt || o.settled) return out;
    const subs = o.subs.map((s) => s.raw);
    const has = (k, p) => this.has(o, k, p);
    if (role === "store") {
      if (o.unexpected) out.next = { action: "refund", text: `This payment does not match an order of the store (${o.unexpected}): refund it in full.` };
      else if (o.claim && o.claim.judge === "subjective" && !has("response", "merchant") && !has("no_response", "escrow") && now < o.claim.at + w.response) {
        out.next = { action: "respond", kind: "response", until: o.claim.at + w.response, max: this.cfg.limits.panel_chars };
      } else if (has("closing_open", "escrow") && !has("closing_response", "merchant") && !has("closing_timeout", "escrow")) {
        out.next = { action: "respond", kind: "closing_response", max: this.cfg.limits.panel_chars };
      } else if (o.claim && o.claim.judge === "mail" && o.steps.some((s) => s.final?.reason === "store email unreadable") && !has("no_response", "escrow")) {
        out.next = { action: "send_readable_email", until: o.claim.at + w.response,
          text: `Send a readable email (multipart with a text part) to ${this.orderAddress(o.n)} before the window closes.` };
      }
      return out;
    }
    if (o.unexpected) { out.next = { action: "wait", text: "The store has to refund this payment." }; return out; }
    const attested = o.mails.filter((m) => m.state === "attested");
    if (!o.claim) {
      const claimedAt = Math.max(Number(now) - 60, o.paidAt);
      out.next = { action: "claim", claimed_at: claimedAt, events: x.structure.rules.map((r) => r.event)
        .filter((e) => ["late", "not_as_described", "not_delivered"].includes(e)),
        base: { v: "claim-v1", order_ref: o.ref, order_number: o.n, buyer: o.buyer, merchant: o.merchant, amount_cents: o.amount / 1e4,
          paid_at: o.paidAt, claimed_at: claimedAt, terms_hash: o.termsHash },
        limits: { account: this.cfg.limits.account_chars, field: this.cfg.limits.field_chars },
        evidence: attested.map((m) => this.evidence(m)) };
      return out;
    }
    const missing = o.claim.judge === "mail" ? attested.map((m) => this.evidence(m)).filter((r) => !subs.includes(r)) : [];
    if (missing.length) out.next = { action: "submit", submissions: missing };
    else if (o.proofRequestedAt && !has("proof", "buyer") && now < o.proofRequestedAt + w.proof) out.next = { action: "proof", until: o.proofRequestedAt + w.proof };
    else if (has("closing_open", "escrow") && !has("closing_proof", "buyer") && !has("closing_statement", "buyer") && !has("closing_timeout", "escrow")) out.next = { action: "closing" };
    else out.next = { action: "wait", text: "The store and the judge are working on it." };
    return out;
  }
}
