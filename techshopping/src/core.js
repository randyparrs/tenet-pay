// TechShopping (techshopping.site), the example store of the gateway: an online shop that offers "Pay with Tenet".
// Its server creates each order through Tenet's API with the store's API key, learns that it was paid from
// Tenet's signed webhook, and sends its order emails with Resend to Tenet's address for the order
// (order-<number>@paytenet.site, CM-D3), multipart with a text part and under 12 KB. Which emails depends on the
// product (Randy, 2026-10-20): the earbuds arrive late (confirmation, shipped, delivered the next day UTC), the charger
// is not the one described (confirmation, shipped, delivered on the promised date), the case never arrives
// (confirmation and shipped, no delivery). Adapters: tenet (fetch to Tenet's API), mail (Resend), store (storage).

export const PRODUCTS = {
  earbuds: { name: "Wireless earbuds", price_cents: 300, delivery: "next_day",
    description: "Wireless earbuds TS-E1, black, with charging case, delivered by the estimated date." },
  charger: { name: "USB-C charger 65 W", price_cents: 200, delivery: "on_date",
    description: "USB-C wall charger, 65 W, model TS-C65, with a 1 m cable." },
  case: { name: "Phone case", price_cents: 100, delivery: "none",
    description: "Clear phone case for 6.1 inch phones." },
};
const day = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
const addDay = (d) => new Date(Date.parse(d + "T00:00:00Z") + 86400e3).toISOString().slice(0, 10);
const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc(body)));
}

/** The store's emails: a text part and the same content in HTML (Resend sends both as multipart/alternative). */
export function emailFor(kind, o, dates) {
  const p = PRODUCTS[o.product];
  const head = { confirmed: `Order ${o.n} confirmed`, shipped: `Order ${o.n} shipped`, delivered: `Order ${o.n} delivered` }[kind];
  const lines = {
    confirmed: [`Thanks for your order ${o.n}.`, `${p.name}: USD ${(p.price_cents / 100).toFixed(2)}`, `Total: USD ${(p.price_cents / 100).toFixed(2)}`,
      `Estimated delivery: ${dates.promised}`],
    shipped: [`Your order ${o.n} has shipped with Demo Post, tracking DP${o.n.slice(3)}.`, `Estimated delivery: ${dates.promised}`],
    delivered: [`Your package for order ${o.n} was delivered on ${dates.delivered}.`],
  }[kind];
  const foot = "TechShopping, an example store of the Tenet demo on testnet. No real money is charged.";
  const text = [...lines, "", foot].join("\n") + "\n";
  const html = `<html><body style="font-family:Arial,sans-serif;color:#222"><h2>${head}</h2>${lines.map((l) => `<p>${l}</p>`).join("")}` +
    `<p style="color:#888;font-size:11px">${foot}</p></body></html>`;
  return { subject: head, text, html };
}

export class ShopCore {
  constructor({ cfg, store, tenet, mail, log = () => {} }) {
    Object.assign(this, { cfg, s: store, tenet, mail, log });
  }

  order(n) { return this.s.get("o:" + n); }
  save(o) { return this.s.put("o:" + o.n, o); }

  /** A visitor buys one product: the order is created on Tenet, and the visitor pays on Tenet's checkout page. */
  async buy(product, now) {
    const p = PRODUCTS[product];
    if (!p) throw new Error("unknown product");
    let n;
    do { n = "TS-" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"); } while (await this.order(n));
    const r = await this.tenet("/api/orders", { order_number: n, amount_cents: p.price_cents, description: p.description,
      items: [{ name: p.name, qty: 1, price_cents: p.price_cents }], return_url: `${this.cfg.site_url}/#order/${n}` });
    if (r.error) throw new Error(r.error);
    await this.save({ n, product, createdAt: Number(now), checkout_url: r.checkout_url, email_to: r.email_to, sent: {}, due: [] });
    return { order: n, checkout_url: r.checkout_url };
  }

  /** Tenet's webhook, checked with the store's webhook secret before anything is done with it. */
  async webhook(body, signature, now) {
    if (signature !== "sha256=" + (await hmacHex(this.cfg.webhook_secret, body))) return { status: 401 };
    const ev = JSON.parse(body);
    if (ev.type !== "paid") return { status: 200 };
    const o = await this.order(ev.data.order);
    if (!o || o.paidAt) return { status: 200 };
    o.paidAt = Number(now);
    const promised = day(now);
    o.dates = { promised, delivered: PRODUCTS[o.product].delivery === "next_day" ? addDay(promised) : promised };
    o.due = [{ kind: "confirmed", at: Number(now) }, { kind: "shipped", at: Number(now) }];
    if (PRODUCTS[o.product].delivery === "next_day") o.due.push({ kind: "delivered", at: Date.parse(o.dates.delivered + "T00:05:00Z") / 1000 });
    if (PRODUCTS[o.product].delivery === "on_date") o.due.push({ kind: "delivered", at: Number(now) });
    await this.save(o);
    await this.tick(now);
    return { status: 200 };
  }

  /** Sends the emails that are due (the earbuds' delivery notice comes the next day, UTC). */
  async tick(now) {
    for (const o of await this.s.list("o:")) {
      let changed = false;
      for (const d of o.due) {
        if (o.sent[d.kind] || d.at > now) continue;
        const m = emailFor(d.kind, o, o.dates);
        try {
          await this.mail({ from: this.cfg.from, to: o.email_to, subject: m.subject, text: m.text, html: m.html });
        } catch (e) {
          // Kept on the order and tried again on the next tick; one order's failure does not stop the others.
          o.mail_error = { kind: d.kind, error: String((e && e.message) || e).slice(0, 200), at: Number(now) };
          this.log(`mail ${o.n} ${d.kind}: ${o.mail_error.error}`);
          changed = true;
          break;
        }
        o.sent[d.kind] = Number(now);
        o.mail_error = null;
        changed = true;
      }
      if (changed) await this.save(o);
    }
  }

  /** What the store knows of an order (no secrets): paid, the dates, the emails sent and the last sending error. */
  async status(n) {
    const o = await this.order(n);
    if (!o) return null;
    return { order: o.n, product: o.product, created_at: o.createdAt || null, paid_at: o.paidAt || null, dates: o.dates || null, sent: o.sent,
      due: o.due.map((d) => ({ kind: d.kind, at: d.at })), mail_error: o.mail_error || null, email_to: o.email_to || null,
      checkout_url: o.checkout_url || null };
  }

  /** The test email Tenet asks for at registration, sent the same way as the order emails. */
  async testEmail(to) {
    const text = "This is the test email of TechShopping's registration on Tenet.\nOrder emails come in the same format.\n";
    await this.mail({ from: this.cfg.from, to, subject: "Tenet registration test", text, html: `<p>${text.replace(/\n/g, "<br>")}</p>` });
  }
}
