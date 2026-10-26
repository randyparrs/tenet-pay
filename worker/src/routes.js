// The gateway Worker's API, as one function: the Durable Object (src/index.js) and the page rehearsal
// (test/rehearsal.mjs) serve the same routes with it.
export const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** method, path (with query), headers (a get(name) function), body (parsed JSON): {status, body}. */
export async function serve(core, cfg, { method, url, headers, body }, extra = {}) {
  const u = new URL(url, "https://gateway");
  const now = () => core.arc.now();
  const ok = (b, status = 200) => ({ status, body: b });
  const bearer = () => (/^Bearer (\S+)$/.exec(headers.get("authorization") || "") || [, ""])[1];
  if (u.pathname === "/api/config") {
    const meta = await core.meta();
    return ok({ chain_id: cfg.chain_id, escrow: cfg.escrow, usdc: cfg.usdc, judges: cfg.judges, windows_seconds: cfg.windows_seconds,
      windows_text: cfg.windows_text, limits: cfg.limits, max_amount_cents: cfg.max_amount_cents, mail_domain: cfg.mail_domain,
      paused: meta.paused ? meta.stop : null, last_tick: extra.lastTick || null });
  }
  if (u.pathname === "/api/stores" && method === "POST") return ok(await core.startStore(body, await now()));
  let m = /^\/api\/stores\/(0x[0-9a-fA-F]{40})(?:\/(txt|draft|message|confirm|webhooks))?$/.exec(u.pathname);
  if (m) {
    const [, wallet, op] = m;
    if (!op && method === "GET") { const v = await core.storeView(wallet, await now()); return v ? ok(v) : ok({ error: "no store" }, 404); }
    if (op === "webhooks" && method === "GET") { const v = await core.webhookView(bearer(), wallet); return v ? ok(v) : ok({ error: "unauthorized" }, 401); }
    if (op === "txt") return ok(await core.checkTxt(wallet, await now()));
    if (op === "draft") return ok(await core.draftTerms(wallet, body.policy, await now()));
    if (op === "message") return ok({ message: core.registrationMessage(body.payload || {}) });
    if (op === "confirm") return ok(await core.confirmStore(wallet, body.payload || {}, body.signature, await now()));
  }
  if (u.pathname === "/api/orders" && method === "POST") {
    const auth = /^Bearer (\S+)$/.exec(headers.get("authorization") || "");
    return ok(await core.createOrder(auth ? auth[1] : "", body, await now()));
  }
  if (u.pathname === "/api/orders" && method === "GET") {
    const buyer = u.searchParams.get("buyer") || "";
    if (!ADDR.test(buyer)) return ok({ error: "buyer" }, 400);
    return ok({ orders: await core.ordersOf(buyer), withdrawals: await core.withdrawalsOf(buyer) });
  }
  if ((m = /^\/api\/escrow-terms\/(0x[0-9a-fA-F]{40})$/.exec(u.pathname)) && method === "GET") {
    return ok(await core.escrowTerms(m[1]));
  }
  if ((m = /^\/api\/checkout\/([A-Za-z0-9-]{1,40})$/.exec(u.pathname))) {
    const v = await core.checkout(m[1]);
    return v ? ok(v) : ok({ error: "no such order" }, 404);
  }
  if ((m = /^\/api\/orders\/([A-Za-z0-9-]{1,40})\/resend-paid$/.exec(u.pathname)) && method === "POST") {
    const v = await core.resendPaid(bearer(), m[1], await now());
    return v ? ok(v) : ok({ error: "unauthorized" }, 401);
  }
  if ((m = /^\/api\/orders\/([A-Za-z0-9-]{1,40})$/.exec(u.pathname))) {
    const v = await core.orderView(m[1], await now(), u.searchParams.get("role") === "store" ? "store" : "buyer");
    return v ? ok(v) : ok({ error: "no such order" }, 404);
  }
  return ok({ error: "not found" }, 404);
}
