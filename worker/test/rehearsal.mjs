// CM8: local rehearsal of the gateway. No network, no real keys, nothing on any chain:
//   Arc       anvil, with the gateway escrow (evm/out-demo, the 5-minute build, CM-D9) and a test USDC at Arc's address
//   Bradbury  tests/gw_gl_stub.py: the gateway judges as built, in Lacre's simulated SDK, with a KeyCache and a
//             Lacre Verifier
//   DNS       a DoH stand-in that both resolvers answer from (the _tenet TXT and the store's DKIM key)
//   OpenRouter a stand-in that answers the F1 prompt with the store's structure
//   Email     the example store's emails, built as Resend sends them (multipart/alternative, a text part) and signed
//             with a throwaway DKIM key for techshopping.site plus a second signature by amazonses.com
// The gateway Worker's core and Arc adapter run as they are; TechShopping's server core too.
//
//   node worker/test/rehearsal.mjs            (from the repository root; needs anvil and local.env for LACRE_DIR)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import vm from "node:vm";
import { createPublicClient, createWalletClient, http, defineChain, stringToHex, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GatewayCore } from "../src/core.js";
import { serve } from "../src/routes.js";
import { makeArc } from "../src/arc.js";
import * as realDns from "../src/dns.js";
import * as f1 from "../src/f1.js";
import { termsHash, render } from "../src/terms.js";
import { ShopCore, PRODUCTS as SHOP_PRODUCTS } from "../../techshopping/src/core.js";
import { cj, orderRef } from "../../tenet/worker/src/util.js";
import { makeCheckout } from "./checkout-page.mjs";
import { makeShopPage } from "./techshopping-page.mjs";
import { makeOrdersPage } from "./orders-page.mjs";
import { makeMerchantsPage } from "./merchants-page.mjs";

const ROOT = new URL("../../", import.meta.url);
const P = (rel) => new URL(rel, ROOT);
mkdirSync(new URL("results/", ROOT), { recursive: true });
const T = (rel) => new URL(rel, new URL("tenet/", ROOT));
const HOME = process.env.USERPROFILE || process.env.HOME;
const ANVIL_HOME = `${HOME}/.foundry/bin/anvil${process.platform === "win32" ? ".exe" : ""}`;
const ANVIL = process.env.ANVIL || (existsSync(ANVIL_HOME) ? ANVIL_HOME : "anvil");
const PY = process.env.VENV_PY || "python";
const USDC = "0x3600000000000000000000000000000000000000";
const K = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"];
const [OWNER, GUARDIAN, GATEWAY, STORE, B1, B2, B3, B4] = K.map((k) => privateKeyToAccount(k));
const STORE2 = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"); // anvil account 8
const TS = "techshopping.site", SEL = "resend";
const WEBHOOK = "https://techshopping.site/api/tenet-webhook";
const POLICY = "TechShopping refunds. If your order arrives after the estimated delivery date, you get 50% of the order total back; " +
  "claim within 30 days of delivery. If the item is damaged, wrong or not as described, you get a full refund; claim within 30 days " +
  "of delivery. If your order never arrives, you get a full refund.";
const TS_STRUCT = f1.structure({ clear: true, day_type: "calendar", preconditions: [], seller_wait_hours: 0, seller_types: "any",
  excluded_payments: [], category_exclusions: false, excluded_causes: [], rules: [
    { event: "late", wait_from: "none", wait_days: 0, deadline_from: "delivery", deadline_days: 30, late_grace_days: 0, refund_percent: 50 },
    { event: "not_as_described", wait_from: "none", wait_days: 0, deadline_from: "delivery", deadline_days: 30, late_grace_days: 0, refund_percent: 100 },
    { event: "not_delivered", wait_from: "none", wait_days: 0, deadline_from: "none", deadline_days: 0, late_grace_days: 0, refund_percent: 100 }] });

const lines = [];
const say = (t) => { console.log(t); lines.push(t); };
let failed = 0;
const check = (cond, what) => { say(`${cond ? "ok  " : "BAD "} ${what}`); if (!cond) failed++; };
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- DKIM signing as Resend does it (relaxed/relaxed), for the rehearsal's store ----------------------------------
const canonHeader = (name, value) => name.trim().toLowerCase() + ":" + value.replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim() + "\r\n";
function canonBody(body) {
  const ls = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/, ""));
  while (ls.length && !ls[ls.length - 1]) ls.pop();
  return ls.length ? ls.join("\r\n") + "\r\n" : "";
}
function dkim(key, domain, selector, headers, names, body, t) {
  const bh = createHashB64(canonBody(body));
  const tags = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; t=${t}; h=${names.map((n) => n.toLowerCase()).join(":")}; bh=${bh}; b=`;
  const data = names.map((n) => canonHeader(n, " " + headers[n])).join("") + canonHeader("DKIM-Signature", " " + tags).replace(/\r\n$/, "");
  const s = createSign("RSA-SHA256");
  s.update(Buffer.from(data, "latin1"));
  return `DKIM-Signature: ${tags}${s.sign(key).toString("base64")}\r\n`;
}
import { createHash } from "node:crypto";
function createHashB64(s) { return createHash("sha256").update(Buffer.from(s, "latin1")).digest("base64"); }

function buildMime({ from, to, subject, text, html, t, keys, textOnly = false, pad = 0, domain = TS }) {
  const b = "----_NmP-" + randomBytes(8).toString("hex") + "-Part_1";
  const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
  const big = pad ? "\r\n" + ("Accessory list line for a large store email, model TS-A0000, black, qty 1, USD 0.10.\r\n").repeat(Math.ceil(pad / 86)) : "";
  const body = textOnly ? crlf(text) + big
    : `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${crlf(text)}${big}\r\n` +
      `--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${crlf(html)}\r\n--${b}--\r\n`;
  const headers = { From: from, To: to, Subject: subject, Date: new Date(t * 1000).toUTCString().replace("GMT", "+0000"),
    "Message-ID": `<${randomBytes(8).toString("hex")}@email.amazonses.com>`, "MIME-Version": "1.0",
    "Content-Type": textOnly ? "text/plain; charset=utf-8" : `multipart/alternative; boundary="${b}"` };
  const names = ["From", "To", "Subject", "Date", "Message-ID", "MIME-Version", "Content-Type"];
  const sig1 = dkim(keys.store, domain, SEL, headers, names, body, t);
  const sig2 = dkim(keys.ses, "amazonses.com", "ug7nbtf4", headers, names, body, t);
  return sig1 + sig2 + names.map((n) => `${n}: ${headers[n]}\r\n`).join("") + "\r\n" + body;
}

async function main() {
  const port = await freePort(), stubPort = await freePort();
  const store = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 });
  const ses = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 });
  const gb = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const nHex = Buffer.from(store.publicKey.export({ format: "jwk" }).n, "base64url").toString("hex");
  const anvil = spawn(ANVIL, ["--port", String(port), "--chain-id", "5042002", "--silent"], { stdio: "ignore" });
  const stub = spawn(PY, ["tenet/tools/lacre_boot.py", "tests/gw_gl_stub.py", String(stubPort), GATEWAY.address.toLowerCase(), TS, SEL, nHex, "65537"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((res, rej) => { stub.stdout.on("data", (x) => String(x).includes("READY") && res()); stub.on("exit", (c) => rej(new Error("stub exited " + c))); });
    await run(`http://127.0.0.1:${port}`, stubPort, { store: store.privateKey, ses: ses.privateKey, gb: gb.privateKey,
      gbSpki: gb.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      spki: store.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  } finally {
    anvil.kill();
    stub.kill();
  }
  say(failed ? `GATEWAY REHEARSAL FAIL (${failed})` : "GATEWAY REHEARSAL PASS");
  writeFileSync(P("results/gateway-rehearsal.txt"), lines.join("\n") + "\n");
  process.exit(failed ? 1 : 0);
}

async function run(url, stubPort, keys) {
  const chain = defineChain({ id: 5042002, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const rpc = (method, params) => pub.request({ method, params });
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(url) });
  const wait = async (h) => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("reverted " + h); return r; };
  const warp = async (s) => { await rpc("evm_increaseTime", [Number(s)]); await rpc("evm_mine", []); };
  const now = async () => Number((await pub.getBlock()).timestamp);

  const stable = JSON.parse(readFileSync(T("evm/out/RefundEscrow.t.sol/Stable.json"), "utf8"));
  const art = JSON.parse(readFileSync(T("evm/out-demo/RefundEscrow.sol/RefundEscrow.json"), "utf8"));
  const ow = wallet(OWNER);
  let r = await wait(await ow.deployContract({ abi: stable.abi, bytecode: stable.bytecode.object, args: ["USDC"] }));
  await rpc("anvil_setCode", [USDC, await pub.getCode({ address: r.contractAddress })]);
  for (const b of [B1, B2, B3, B4, STORE]) await wait(await ow.writeContract({ address: USDC, abi: stable.abi, functionName: "mint", args: [b.address, 50_000_000n] }));
  r = await wait(await ow.deployContract({ abi: art.abi, bytecode: art.bytecode.object,
    args: [OWNER.address, GATEWAY.address, GUARDIAN.address, [USDC], [5_000_000n], 120n] }));
  const escrow = r.contractAddress;
  const cfg = JSON.parse(readFileSync(P("worker/src/gateway-data.json"), "utf8"));
  Object.assign(cfg, { escrow, deploy_block: Number(r.blockNumber), judges: { mail: "mail", subjective: "subjective" } });
  const esc = (fn, args) => pub.readContract({ address: escrow, abi: art.abi, functionName: fn, args });

  // ---- adapters -------------------------------------------------------------------------------------------
  const mem = (m) => ({ get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { m.delete(k); }, list: async (p) => [...m.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v)) });
  const gwMem = new Map(), shopMem = new Map();
  const stubCall = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${stubPort}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    return out;
  };
  let arcRef;
  const t = async () => arcRef.now();
  const gl = {
    sendJudge: async (kind, claim, step) => (await stubCall("/judge", { kind, claim, step, when: await t(), sender: GATEWAY.address })).tx,
    setMerchant: async (kind, merchant, terms) => (await stubCall("/set_merchant", { kind, merchant, terms, when: await t(), sender: GATEWAY.address })).tx,
    getMerchant: async (kind, merchant, terms_hash, final) => (await stubCall("/get_merchant", { kind, merchant, terms_hash, final })).terms,
    status: (tx) => stubCall("/status", { tx }),
    verdict: async (kind, ch, final) => (await stubCall("/verdict", { kind, chain: ch, final })).verdict,
    attest: async (blob, domain, selector, body) => (await stubCall("/attest", { blob, domain, selector, raw: blob + "\r\n" + body, requester: GATEWAY.address })).tx,
    findRecord: async (bh, final) => (await stubCall("/record", { bh, final })).record,
    registerKey: async (d, s) => (await stubCall("/register_key", { domain: d, selector: s, when: await t() })).tx,
    confirmKey: async (d, s) => (await stubCall("/confirm_key", { domain: d, selector: s, when: await t() })).tx,
    keyStatus: async (d, s) => (await stubCall("/key_status", { domain: d, selector: s })).status,
  };
  const txt = new Map([[`${SEL}._domainkey.${TS}`, [`v=DKIM1; k=rsa; p=${keys.spki}`]], [`${SEL}._domainkey.gadgetbox.site`, [`v=DKIM1; k=rsa; p=${keys.gbSpki}`]]]);
  const doh = async (u) => {
    const name = new URL(u).searchParams.get("name");
    return { status: 200, json: async () => ({ Status: 0, Answer: (txt.get(name) || []).map((d) => ({ type: 16, data: `"${d}"` })) }) };
  };
  const dns = { checkOwner: (d, w) => realDns.checkOwner(d, w, doh), dkimBits: (d, s) => realDns.dkimBits(d, s, doh) };
  let drafts = 0;
  const openrouter = async (_u, init) => {
    drafts++;
    const prompt = JSON.parse(init.body).messages[0].content;
    const read = prompt.includes("contact us first") ? { ...TS_STRUCT, preconditions: ["contact_seller"], excluded_causes: ["customs"] }
      : prompt.includes("arrives after the estimated delivery date") ? TS_STRUCT : {};
    return { status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(read) } }] }) };
  };
  const fone = { draft: (p, k) => f1.draft(p, k, openrouter) };
  const hooks = [];
  let shop;
  const net = async (u, init) => {
    hooks.push({ url: u, body: init.body, sig: init.headers["x-tenet-signature"] });
    if (u !== WEBHOOK) return { status: 404 };
    return { status: (await shop.webhook(init.body, init.headers["x-tenet-signature"], await t())).status };
  };
  let failBroadcast = false;
  let core;
  const makeCore = () => {
    const arc = makeArc({ rpc: url, chainId: 5042002, escrow, abi: art.abi, key: K[2] });
    const real = arc.broadcast;
    arc.broadcast = async (raw) => { if (failBroadcast) { failBroadcast = false; throw new Error("simulated crash before broadcast"); } return real(raw); };
    arcRef = arc;
    return new GatewayCore({ cfg, store: mem(gwMem), arc, gl, dns, f1: fone, net, openrouterKey: "test", log: (x) => say("   gateway: " + x) });
  };
  core = makeCore();
  const tick = async (n = 1, step = 0) => {
    for (let i = 0; i < n; i++) {
      if (step) await warp(step);
      try { await core.tick(); } catch (e) { if (!/simulated crash/.test(e.message)) throw e; say("   (crash simulated: the gateway Worker restarts)"); core = makeCore(); }
      await shop.tick(await t());
    }
  };
  let apiKey = "";
  const sentMail = [];
  const mail = async (m) => {
    const raw = buildMime({ ...m, t: await t(), keys });
    sentMail.push({ to: m.to, subject: m.subject, bytes: raw.length });
    return core.receiveEmail(m.to, raw, await t());
  };
  shop = new ShopCore({ cfg: { site_url: "https://techshopping.site", from: "TechShopping Orders <orders@techshopping.site>", webhook_secret: "" },
    store: mem(shopMem), mail, tenet: async (_p, body) => { try { return await core.createOrder(apiKey, body, await t()); } catch (e) { return { error: e.message }; } } });

  // ---- registration (CM4, CM17, CM-D2, CM-D4, CM-D13, CM-D14) --------------------------------------
  let v = await core.startStore({ domain: TS, wallet: STORE.address }, await t());
  check(v.txt.name === "_tenet.techshopping.site" && v.txt.value === "tenet-merchant=" + STORE.address.toLowerCase(),
    `CM4 the store gets the TXT to publish: ${v.txt.name} = ${v.txt.value}`);
  v = await core.checkTxt(STORE.address, await t());
  check(v.txt.check && !v.txt.check.ok && /no tenet-merchant record/.test(v.txt.check.reason), `CM4 no TXT yet: refused (${v.txt.check?.reason})`);
  txt.set("_tenet." + TS, ["tenet-merchant=" + GUARDIAN.address.toLowerCase()]);
  v = await core.checkTxt(STORE.address, await t());
  check(!v.txt.check.ok && /names another wallet/.test(v.txt.check.reason), "CM4 a TXT with another wallet: refused");
  txt.set("_tenet." + TS, ["tenet-merchant=" + STORE.address.toLowerCase()]);
  v = await core.checkTxt(STORE.address, await t());
  check(v.txt.check.ok, "CM4 the TXT with the store's wallet, the same through both resolvers: accepted");
  const d = await core.draftTerms(STORE.address, POLICY, await t());
  check(cj(d.draft) === cj(TS_STRUCT) && d.review.join() === "preconditions,excluded_causes" && drafts === 1,
    "CM4 the F1 draft comes from the fixed model's reading, with preconditions and excluded causes flagged for review");
  const payload = { structure: d.draft, promised_label: "Estimated delivery:", delivery_label: "delivered on", order_prefix: "TS-", order_digits: 6,
    hold_days: 30, webhook_url: WEBHOOK };
  const signReg = (p, who = STORE) => wallet(who).signMessage({ message: core.registrationMessage(p) });
  let err = await core.confirmStore(STORE.address, payload, await signReg(payload, B1), await t()).catch((e) => e.message);
  check(/not from the store's wallet/.test(err), "CM4 a confirmation signed by another wallet: refused");
  const withPre = { ...payload, structure: { ...d.draft, preconditions: ["contact_seller"] } };
  err = await core.confirmStore(STORE.address, withPre, await signReg(withPre), await t()).catch((e) => e.message);
  check(/do not support yet: preconditions/.test(err), `CM4 a structure with preconditions cannot be registered (${err.slice(0, 70)})`);
  const conf = await core.confirmStore(STORE.address, payload, await signReg(payload), await t());
  apiKey = conf.api_key;
  shop.cfg.webhook_secret = conf.webhook_secret;
  check(/^tk_/.test(apiKey) && conf.state === "test_email" && !JSON.stringify(gwMem.get("s:" + STORE.address.toLowerCase())).includes(apiKey),
    "CM4 the API key is shown once and Tenet keeps only its hash");
  err = await core.createOrder(apiKey, { order_number: "TS-000001", amount_cents: 100 }, await t()).catch((e) => e.message);
  check(/not active/.test(err), "an order before the store is active: refused");
  // CM17: the test email
  const testTo = conf.test_address;
  await core.receiveEmail(testTo, buildMime({ from: "TechShopping Orders <orders@techshopping.site>", to: testTo, subject: "test", text: "Hello\n",
    html: "", t: await t(), keys, textOnly: true }), await t());
  v = await core.storeView(STORE.address, await t());
  check(v.test && !v.test.ok && v.test.problems.some((p) => /multipart/.test(p)) && v.state === "test_email",
    `CM17 a text-only test email: not approved, the page says why (${v.test?.problems.join("; ")})`);
  await shop.testEmail(testTo);
  v = await core.storeView(STORE.address, await t());
  check(v.test.ok && v.selector === "resend" && v.state === "key", "CM17 the test email from the store's system, multipart with a text part, signed for techshopping.site: approved");
  check(v.terms.min_key_bits === 1024, "CM-D14 min_key_bits in the store's terms from its DKIM key (1024 bits, as Resend's)");
  await tick(5, 30);
  v = await core.storeView(STORE.address, await t());
  check(v.state === "key_pending" && /Pending activation/.test(v.pending) && v.active_at,
    `CM-D13 register_key sent by the gateway; the panel shows "${v.pending}"`);
  err = await core.createOrder(apiKey, { order_number: "TS-000001", amount_cents: 100 }, await t()).catch((e) => e.message);
  check(/^Pending activation/.test(err), `CM-D13 no orders while the key is in quarantine (${err})`);
  await warp(Math.max(0, v.active_at + 120 - (await t())));
  await tick(12, 15);
  v = await core.storeView(STORE.address, await t());
  const onEscrow = await esc("merchantTermsHash", [STORE.address]);
  check(v.state === "active" && onEscrow.toLowerCase() === v.terms.terms_hash, `registration: KeyCache active, both judges and the escrow registered (${v.state})`);
  for (const kind of ["mail", "subjective"]) {
    const got = await gl.getMerchant(kind, STORE.address.toLowerCase(), v.terms.terms_hash, true);
    check(got && JSON.parse(got).terms_hash === v.terms.terms_hash, `registration: the ${kind} judge keeps the store's terms under their hash`);
  }
  check(hooks.some((h) => JSON.parse(h.body).type === "store_active"), "webhook: store_active sent to the store, signed");

  // ---- CM14: the checkout page renders the terms and checks their hash ---------------------------------------
  const pageCheck = async (co) => {
    const h = await termsHash(co.terms.structure, co.terms.hold_days, co.terms.windows);
    const chainHash = String(await esc("merchantTermsHash", [co.merchant])).toLowerCase();
    return h === co.terms.terms_hash && h === chainHash;
  };

  // ---- buyer and store actions -------------------------------------------------------------------------------
  const pay = async (who, co) => {
    const w = wallet(who);
    await wait(await w.writeContract({ address: USDC, abi: stable.abi, functionName: "approve", args: [escrow, BigInt(co.amount_cents) * 10_000n] }));
    await wait(await w.writeContract({ address: escrow, abi: art.abi, functionName: "pay", args: [co.ref, co.merchant, USDC,
      BigInt(co.amount_cents) * 10_000n, BigInt(co.terms.hold_days * 86400), co.terms.terms_hash] }));
  };
  const openClaim = async (who, n, event, fields) => {
    const view = await core.orderView(n, await t());
    const claim = cj({ ...view.next.base, claimed_at: (await t()) - 30, event, ...fields });
    await wait(await wallet(who).writeContract({ address: escrow, abi: art.abi, functionName: "openClaim", args: [orderRef(n), stringToHex(claim)] }));
    return claim;
  };
  const submit = async (who, n, raw) => wait(await wallet(who).writeContract({ address: escrow, abi: art.abi, functionName: "submit", args: [orderRef(n), stringToHex(raw)] }));
  const storeSays = (n, kind, text) => submit(STORE, n, cj({ party: "merchant", kind, content: text }));
  const settled = async (n, rounds = 40) => {
    for (let i = 0; i < rounds; i++) { const o = await core.orderView(n, await t()); if (o.settled) return o; await tick(1, 61); }
    return core.orderView(n, await t());
  };
  const counts = () => stubCall("/count", {});

  // ---- G1 late (earbuds) and G2 (a confirmation with refund text and the label): paid on day 0 -------------------
  const g1 = await shop.buy("earbuds", await t());
  const co1 = await core.checkout(g1.order);
  check(await pageCheck(co1), "CM14 checkout: the terms rendered in the page hash to the order's and the escrow's terms hash");
  const tampered = { ...co1, terms: { ...co1.terms, structure: { ...co1.terms.structure, rules: co1.terms.structure.rules.map((x) => ({ ...x, refund_percent: 10 })) } } };
  check(!(await pageCheck(tampered)), "CM14 a version whose text says something else than the registered hash: the page does not let the buyer pay");
  await pay(B1, co1);
  const g2n = "TS-200002";
  const c2 = await core.createOrder(apiKey, { order_number: g2n, amount_cents: 300, description: "Wireless earbuds TS-E1, black.", items: [] }, await t());
  await pay(B2, await core.checkout(g2n));
  await tick(4, 20);
  const day0 = new Date((await t()) * 1000).toISOString().slice(0, 10);
  const day1 = new Date(Date.parse(day0 + "T00:00:00Z") + 86400e3).toISOString().slice(0, 10);
  // G2: the store's system writes a confirmation whose visible text says a refund was issued (J05), with the label
  await mail({ from: "TechShopping Orders <orders@techshopping.site>", to: c2.email_to, subject: `Order ${g2n} confirmed`,
    text: `From: TechShopping Refunds\nSubject: Refund issued for ${g2n}\n\nThanks for your order ${g2n}.\nTotal: USD 3.00\nEstimated delivery: ${day0}\n`,
    html: `<p>Refund issued for ${g2n}</p><p>Estimated delivery: ${day0}</p>` });
  let o1 = await core.orderView(g1.order, await t());
  check(o1.paid && o1.mails.length === 2 && o1.mails.every((m) => m.state === "attesting" || m.state === "attested"),
    `G1 paid: the webhook reached the store, which sent its confirmation and shipping emails to ${c2.email_to.replace(/order-[^@]+/, "order-<n>")}`);
  // G7: an email over 12 KB
  await mail({ from: "TechShopping Orders <orders@techshopping.site>", to: c2.email_to, subject: `Order ${g2n} catalog`, text: "Our catalog\n", html: "<p>Our catalog</p>", pad: 13000 });
  await tick(6, 20);
  o1 = await core.orderView(g1.order, await t());
  const o2 = await core.orderView(g2n, await t());
  check(o1.mails.every((m) => m.state === "attested" && m.record), "G1 the store's emails attested on Lacre, each read once its attestation is FINALIZED");
  check(o2.mails.some((m) => m.state === "too_large") && !o2.mails.find((m) => m.state === "too_large").tx,
    "G7 an email over 12 KB: recorded as too large, not sent to Lacre (the judge would give I10)");
  const plus = await mail({ from: "TechShopping Orders <orders@techshopping.site>", to: `orders+${g2n.toLowerCase()}@orders.rpmdev.app`,
    subject: `Order ${g2n} note`, text: `A note about order ${g2n}.
`, html: `<p>A note about order ${g2n}.</p>` });
  check(plus.state === "attesting", "the plus-address form (orders+<n>@, for Email Routing on a subdomain) reaches the order too");
  // day 1: the earbuds' delivery notice; G2's from the rehearsal's store
  await warp(Math.max(60, Date.parse(day1 + "T00:06:00Z") / 1000 - (await t())));
  await mail({ from: "TechShopping Orders <orders@techshopping.site>", to: c2.email_to, subject: `Order ${g2n} delivered`,
    text: `Your package for order ${g2n} was delivered on ${day1}.\n`, html: `<p>Your package for order ${g2n} was delivered on ${day1}.</p>` });
  await tick(5, 20);
  o1 = await core.orderView(g1.order, await t());
  check(o1.mails.length === 3 && o1.mails.every((m) => m.state === "attested"), "G1 the delivery notice came the next day (UTC) and was attested");
  for (const [who, n] of [[B1, g1.order], [B2, g2n]]) {
    await openClaim(who, n, "late", {});
    await tick(1, 5);
    const view = await core.orderView(n, await t());
    for (const s of view.next.submissions) await submit(who, n, s);
  }
  // restart: a crash before a broadcast, in the middle of G1 and G2
  failBroadcast = true;
  const g1v = await settled(g1.order), g2v = await settled(g2n);
  check(g1v.settled?.refund === 1_500_000, `G1 late: REFUND 1.50 USDC, 50% for 1 day late (${g1v.steps.map((s) => s.final?.outcome + " " + s.final?.reason).join(", ")})`);
  check(g2v.settled?.refund === 1_500_000, "G2 a confirmation read as refund_issued keeps its promised date by the label: REFUND 1.50 USDC");

  // ---- G3 to G6 (paths of the subjective judge) ----------------------------------------------------------------
  const claimNad = (n, proof) => ({ description: PRODUCTS_DESC.charger, account: "The charger in the box is a 20 W one, not 65 W.",
    promised: "65 W", received: "20 W", proof_kind: proof ? "label" : "", proof: proof ? "TS-C20 20W" : "", delivered_date: day1 });
  const run3 = async (who, product, event, fields, store) => {
    const b = await shop.buy(product, await t());
    await pay(who, await core.checkout(b.order));
    await tick(3, 20);
    await openClaim(who, b.order, event, fields(b.order));
    if (store) await store(b.order);
    return b.order;
  };
  const g3 = await run3(B3, "charger", "not_as_described", (n) => claimNad(n, true), (n) => storeSays(n, "response", "We are sorry, we sent the wrong charger. A refund is fine."));
  const g3v = await settled(g3);
  check(g3v.settled?.refund === 2_000_000, `G3 not as described, the store admits in free text: REFUND 2.00 USDC (${g3v.steps.map((s) => s.final?.outcome).join(", ")})`);
  const g4 = await run3(B4, "charger", "not_as_described", (n) => claimNad(n, false), (n) => storeSays(n, "response", "Our test report for this unit, serial TS-C65-0042, shows 65 W."));
  for (let i = 0; i < 10; i++) { const o = await core.orderView(g4, await t()); if (o.next?.action === "closing") break; await tick(1, 30); }
  await submit(B4, g4, cj({ party: "buyer", kind: "closing_proof", content: { proof_kind: "label", proof: "TS-C20 20W" } }));
  await storeSays(g4, "closing_response", "The serial TS-C65-0042 on the box belongs to a 65 W unit.");
  const g4v = await settled(g4);
  check(g4v.settled && g4v.settled.refund === 0 && g4v.settled.released === 2_000_000,
    `G4 not as described, the store disputes with a fact twice: DENY, 2.00 USDC to the store (${g4v.steps.map((s) => s.final?.outcome + " " + s.final?.action).join(", ")})`);
  const g5 = await run3(B1, "case", "not_delivered", (n) => ({ account: "The case never arrived.", promised_date: day1 }), null);
  const g5v = await settled(g5);
  check(g5v.settled?.refund === 1_000_000 && g5v.events.some((e) => /No-response marker/.test(e.what)),
    "G5 not delivered, the store says nothing: no-response marker after the window, REFUND 1.00 USDC");
  const g6 = await run3(B2, "charger", "not_as_described", (n) => claimNad(n, false), (n) => storeSays(n, "response", "We only sell what we list."));
  const g6v = await settled(g6);
  check(g6v.settled && g6v.settled.refund === 0 && g6v.events.some((e) => /proof not provided/.test(e.what)),
    "G6 proof requested and never sent: released to the store after the proof window");

  // ---- G8: a payment without an order of the store ---------------------------------------------------------------
  const ghost = "TS-999999";
  await pay(B3, { ref: orderRef(ghost), merchant: STORE.address, amount_cents: 100, terms: co1.terms });
  await tick(2, 20);
  const panel = await core.storeView(STORE.address, await t());
  const gh = panel.orders.find((x) => x.ref === orderRef(ghost));
  check(gh && gh.unexpected && gh.next?.action === "refund", `G8 the store panel shows the unknown payment with Refund (${gh?.unexpected})`);
  await wait(await wallet(STORE).writeContract({ address: escrow, abi: art.abi, functionName: "merchantRefund", args: [orderRef(ghost)] }));
  await tick(2, 20);
  const ghv = (await core.storeView(STORE.address, await t())).orders.find((x) => x.ref === orderRef(ghost));
  check(ghv?.settled?.refund === 1_000_000, "G8 the store refunds it in full from its wallet (merchantRefund, no GEN)");

  // ---- across the run ----------------------------------------------------------------------------------------
  const all = [g1.order, g2n, g3, g4, g5, g6];
  let dup = 0;
  for (const n of all) {
    const o = await core.orderView(n, await t());
    for (const label of ["Verdict proposed", "Verdict executed", "No-response marker after the window", "Closing round opened", "Proof requested"]) {
      if (o.events.filter((e) => e.what === label && e.net === "arc").length > 1) dup++;
    }
    const sum = o.settled ? o.settled.refund + o.settled.released : -1;
    check(sum === o.amount_cents * 10_000, `CM10 ${n}: refund + released = ${o.amount_cents / 100} USDC to the cent`);
  }
  check(dup === 0 && lines.some((l) => /crash simulated/.test(l)), "CM8 a crash before a broadcast: the Worker restarts and goes on without sending a transaction twice");
  const c = await counts();
  check(c.early_final_reads === 0, `every verdict, Lacre record, key state and store terms used was read with its transaction FINALIZED (early reads: ${c.early_final_reads})`);
  check(!c.unknown_prompts.length, `the simulated committee had an answer for every question the judges asked (${c.unknown_prompts.length} without)`);
  check(c.tx_errors.length === 0, `no judge transaction ended in an error (${JSON.stringify(c.tx_errors).slice(0, 120)})`);
  const signedOk = hooks.filter((h) => h.url === WEBHOOK).length;
  check(signedOk >= 7 && hooks.every((h) => /^sha256=[0-9a-f]{64}$/.test(h.sig)), `webhooks: ${signedOk} sent to the store, each signed with HMAC-SHA256`);
  const forged = await shop.webhook(JSON.stringify({ type: "paid", data: { order: g1.order } }), "sha256=" + "0".repeat(64), await t());
  check(forged.status === 401, "CM5 a webhook with a wrong signature is refused by the store");
  check(sentMail.every((m) => m.bytes < 12288 + 2000 || /catalog/.test(m.subject)), "TechShopping's emails stay under 12 KB of body");

  // ---- the store's webhook log and the resend of a lost "paid" notice: only with the store's API key ---------------
  const api = (method, url, key) => serve(core, cfg, { method, url, body: {},
    headers: { get: (k) => (k.toLowerCase() === "authorization" && key ? "Bearer " + key : null) } });
  const whUrl = `/api/stores/${STORE.address}/webhooks`;
  const noKey = await api("GET", whUrl), badKey = await api("GET", whUrl, "tk_" + "0".repeat(48));
  const otherWallet = await api("GET", `/api/stores/${B2.address}/webhooks`, apiKey);
  check([noKey, badKey, otherWallet].every((r) => r.status === 401 && JSON.stringify(r.body) === '{"error":"unauthorized"}'),
    "webhook log: without the store's API key (none, a wrong one, or the key of another store's wallet) the answer is 401 and nothing else");
  const view = await api("GET", whUrl, apiKey);
  check(view.status === 200 && view.body.url === WEBHOOK && view.body.attempts.length > 0 && view.body.attempts.every((a) => a.url === WEBHOOK && a.status === 200),
    `webhook log: with the store's API key, the URL kept at registration and every attempt (${view.body.attempts?.length}, all 200)`);
  const resendNoKey = await api("POST", `/api/orders/${g2n}/resend-paid`);
  const resendOther = await api("POST", "/api/orders/TS-999999/resend-paid", apiKey).catch((e) => ({ error: e.message }));
  check(resendNoKey.status === 401 && /no such order/.test(resendOther.error || ""), "resend of a paid notice: 401 without the API key; refused for an order that is not the store's");
  const hooksBefore = hooks.length;
  const resent = await api("POST", `/api/orders/${g2n}/resend-paid`, apiKey);
  await tick(1, 5);
  const again = hooks.slice(hooksBefore).filter((h) => JSON.parse(h.body).type === "paid" && JSON.parse(h.body).data.order === g2n);
  const last = (await api("GET", whUrl, apiKey)).body.attempts.at(-1);
  check(resent.status === 200 && resent.body.queued && again.length === 1 && last.type === "paid" && last.status === 200,
    "resend of a paid notice: with the API key it is queued, sent once on the next tick and logged");

  // ---- the readings the checkout uses ---------------------------------
  const coView = (await api("GET", `/api/checkout/${g2n}`)).body;
  const firstPaid = hooks.find((h) => JSON.parse(h.body).type === "paid" && JSON.parse(h.body).data.order === g2n);
  check(coView.paid && /^0x[0-9a-f]{64}$/.test(coView.pay_tx || "") && Number.isInteger(coView.store_notified_at) && !!firstPaid,
    "checkout view: paid order with its pay tx and the time the store's webhook accepted the paid notice");
  const unpaid = await core.createOrder(apiKey, { order_number: "TS-200099", amount_cents: 100, description: "x", items: [] }, await t());
  check(!!unpaid.checkout_url && (await api("GET", "/api/checkout/TS-200099")).body.store_notified_at === null,
    "checkout view: an unpaid order has no store notice yet");
  const regHash = (await core.storeView(STORE.address, await t())).terms.terms_hash;
  const et = await api("GET", `/api/escrow-terms/${STORE.address}`);
  check(et.status === 200 && et.body.terms_hash === regHash && et.body.hold_seconds > 0,
    "escrow terms read by the Worker (the checkout's fallback) = the store's registered terms hash");

  // ---- the core as the Worker builds it (src/index.js passes no net): a global fetch that, like Workers, refuses to be
  // called with another `this` ("Illegal invocation"). The webhook has to leave; with fetch kept bare, it would not.
  const realFetch = globalThis.fetch;
  const workersFetch = async function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    if (String(url) !== WEBHOOK) return realFetch(url, init); // anything else of the rehearsal (anvil reads) goes on as before
    workersFetch.calls.push(String(url));
    return { status: 200, text: async () => '{"ok":true}' };
  };
  workersFetch.calls = [];
  const bareRun = async (extra) => {
    workersFetch.calls = [];
    const m = new Map([["s:" + STORE.address.toLowerCase(), { merchant: STORE.address.toLowerCase(), webhook_secret: "ws_test" }],
      ["w:t1", { id: "t1", url: WEBHOOK, merchant: STORE.address.toLowerCase(), body: cj({ type: "paid", data: { order: "TS-000000" }, at: 0 }), tries: 0, next: 0 }]]);
    const c = new GatewayCore({ cfg, store: mem(m), arc: null, gl: null, dns: realDns, f1: fone, openrouterKey: "test", log: () => {}, ...extra });
    await c.webhooks(await t());
    return { calls: workersFetch.calls.length, seen: (m.get("wl:" + STORE.address.toLowerCase()) || []).at(-1) };
  };
  globalThis.fetch = workersFetch;
  let asWorker, bareKept;
  try {
    asWorker = await bareRun({});
    bareKept = await bareRun({ net: globalThis.fetch });
  } finally { globalThis.fetch = realFetch; }
  check(asWorker.calls === 1 && asWorker.seen.status === 200 && !asWorker.seen.error,
    "the core as the Worker builds it (no net) sends its webhook through a fetch that refuses another `this`, like Workers");
  check(bareKept.calls === 0 && /Illegal invocation/.test(bareKept.seen.error || ""),
    "control: with fetch kept bare and called as this.net(...), the same fetch refuses it (the bug this test guards)");

  // ---- state the later sections read: a claim answered by the store and refunded, the buyer's withdrawal, and a second
  // store (GadgetBox) registered up to its activation. The old single page that did this (app/pay.js) is retired.
  say("-- a refunded claim, a withdrawal and a second store");
  const pb = await shop.buy("charger", await t());
  const co = await core.checkout(pb.order);
  await pay(B1, co);
  await tick(4, 20);
  await openClaim(B1, pb.order, "not_as_described", { description: PRODUCTS_DESC.charger, account: "The charger in the box says 20 W on its label.",
    promised: "65 W", received: "20 W", proof_kind: "label", proof: "TS-C20 20W", delivered_date: new Date((await t()) * 1000).toISOString().slice(0, 10) });
  await tick(2, 20);
  await storeSays(pb.order, "response", "We are sorry, we sent the wrong charger. A refund is fine.");
  const pv = await settled(pb.order);
  check(pv.settled?.refund === 2_000_000, "the store admits a not-as-described claim in its own words: REFUND 2.00 USDC");
  const before = await esc("claimable", [B1.address, USDC]);
  await wait(await wallet(B1).writeContract({ address: escrow, abi: art.abi, functionName: "withdraw", args: [USDC] }));
  check(before >= 2_000_000n && (await esc("claimable", [B1.address, USDC])) === 0n, "the buyer withdraws the refund from the escrow");
  let reg = await core.startStore({ domain: "gadgetbox.site", wallet: STORE2.address }, await t());
  txt.set("_tenet.gadgetbox.site", ["tenet-merchant=" + STORE2.address.toLowerCase()]);
  reg = await core.checkTxt(STORE2.address, await t());
  const gbDraft = await core.draftTerms(STORE2.address, POLICY.replace(/TechShopping/g, "GadgetBox"), await t());
  const gbPayload = { structure: gbDraft.draft, promised_label: "Estimated delivery:", delivery_label: "delivered on", order_prefix: "GB-", order_digits: 6,
    hold_days: 30, webhook_url: "https://gadgetbox.site/api/tenet" };
  await core.confirmStore(STORE2.address, gbPayload, await signReg(gbPayload, STORE2), await t());
  reg = await core.storeView(STORE2.address, await t());
  await core.receiveEmail(reg.test_address, buildMime({ from: "GadgetBox <orders@gadgetbox.site>", to: reg.test_address, subject: "test", text: "Hi\n",
    html: "<p>Hi</p>", t: await t(), keys: { store: keys.gb, ses: keys.ses }, domain: "gadgetbox.site" }), await t());
  await tick(2, 20);
  reg = await core.storeView(STORE2.address, await t());
  check(reg.txt.check.ok && reg.terms.terms_hash === (await termsHash(reg.terms.structure, 30, cfg.windows_text)) && !["started", "test_email"].includes(reg.state),
    `a second store registered through the API, past its test email (GadgetBox, ${reg.state})`);

  // ---- the readings My orders uses ------------------------------------------
  await tick(1, 5);
  const moB1 = (await serve(core, cfg, { method: "GET", url: `/api/orders?buyer=${B1.address}`, headers: { get: () => null }, body: {} })).body;
  check(moB1.withdrawals?.length >= 1 && moB1.withdrawals.at(-1).amount === Number(before) && /^0x[0-9a-f]{64}$/.test(moB1.withdrawals.at(-1).tx),
    "My orders data: the buyer's withdrawal read from the escrow's Withdrawn event (amount and tx)");
  const moG1 = await core.orderView(g1.order, await t());
  const moKind = (re) => moG1.mails.find((m) => re.test(m.subject))?.dates;
  check(moKind(/confirmed/)?.promised === true && moKind(/confirmed/)?.delivered === false && moKind(/delivered/)?.delivered === true,
    "My orders data: each store email says whether it carries the promised date or the delivery date (the store's labels)");
  const moPb = await core.orderView(pb.order, await t());
  check(moPb.claim_content?.event === "not_as_described" && moPb.claim_content.promised && moPb.claim_content.received
    && moPb.submissions.some((s) => s.party === "merchant" && s.kind === "response" && /wrong charger/.test(s.content)),
    "My orders data: the claim as the buyer signed it and the store's answer");
  const moG6 = await core.orderView(g6, await t());
  check(Number.isInteger(moG6.proof_requested_at) && moG6.windows_seconds.proof === 300 && !moG1.submissions.some((s) => s.content && s.content.body_b64),
    "My orders data: when the judge asked for proof and the windows; email evidence is listed without its bytes");

  // ---- the checkout (site/pay/) in a DOM ---------------------------------
  say("-- the new checkout page");
  const ck = await makeCheckout({ getCore: () => core, cfg, pub, wallet, P });
  await ck.load("#orders/TS-200002");
  check(ck.replaced === "../orders/#/orders/TS-200002", "CHECKOUT an old link to My orders (#orders/...) goes to the new My orders");
  await ck.load("");
  check(ck.status() === "nolink" && ck.shown("screen-nolink"), "CHECKOUT without a payment link: the screen that sends you to a store");
  const howHtml = readFileSync(P("site/how/index.html"), "utf8");
  check(ck.attr("nolink-how", "href") === "../how/" && !/<script/i.test(howHtml) && (howHtml.match(/class="how-step"/g) || []).length === 4
    && /The store registers/.test(howHtml) && /You pay on Tenet's checkout/.test(howHtml) && /you open a claim/.test(howHtml) && /A judge decides, the escrow pays/.test(howHtml)
    && /class="testnet-note"/.test(howHtml) && howHtml.includes('href="https://techshopping.site"') && howHtml.includes('href="../orders/"')
    && howHtml.includes('href="https://merchants.paytenet.site"') && howHtml.includes('href="../styles.css'),
    "HOW How it works at paytenet.site/how/ (the checkout's button goes there): the 4 steps, the testnet note, TechShopping, My orders and For stores; no data, no script");
  await ck.go("#/pay/TS-999999");
  check(ck.status() === "notfound" && ck.text("screen-error").includes("TS-999999"), "CHECKOUT an order that does not exist: not found, with its number");
  ck.net.workerDown = true;
  await ck.go("#/pay/TS-999998");
  ck.net.workerDown = false;
  check(ck.status() === "down" && ck.shown("error-retry"), "CHECKOUT the Worker does not answer: Tenet is not responding, with Try again");

  const ckN = "TS-300001";
  await core.createOrder(apiKey, { order_number: ckN, amount_cents: 200, description: PRODUCTS_DESC.charger,
    items: [{ name: "USB-C charger 65 W", qty: 1, price_cents: 200 }] }, await t());
  await ck.go("#pay/" + ckN); // the link form the Worker gives stores
  const ckCo = await core.checkout(ckN);
  const ckText = render(ckCo.terms.structure, ckCo.terms.hold_days, ckCo.terms.windows);
  const ckHash = await termsHash(ckCo.terms.structure, ckCo.terms.hold_days, ckCo.terms.windows);
  check(ck.status() === "ready" && ck.shown("seal-verified") && ck.doc.getElementById("policy-text").textContent === ckText
    && ck.text("policy-dialog").includes(ckHash) && ckHash === ckCo.terms.terms_hash,
    "CHECKOUT terms verified: the full policy is the terms.js text byte for byte, its SHA-256 shown = the order's and the escrow's");
  check(ck.doc.querySelectorAll("#terms-rule-list .rule").length === 3 && ck.text("terms-rule-list").includes("50%")
    && ck.text("order-item").includes("USB-C charger 65 W") && ck.text("order-item").includes("2.00"),
    "CHECKOUT the rule cards come from the structure (3 rules, 50% late) and the item and total from the order");
  check(ck.shown("pay-connect") && !ck.shown("pay-submit") && ck.walletStatus() === "disconnected", "CHECKOUT no wallet: Connect wallet to pay, no Pay button");

  ck.net.account = B3;
  ck.net.chainId = "0x1";
  ck.net.refuseSwitch = true;
  await ck.click("wallet-connect");
  check(ck.shown("menu-connect") && !ck.shown("connect-google"), "CHECKOUT the connect menu offers the browser wallet (Google appears only once Circle is set up)");
  await ck.click("connect-browser-wallet");
  await ck.until(() => ck.walletStatus() === "error");
  check(ck.walletStatus() === "error" && ck.shown("pay-wrong-network") && !ck.shown("pay-submit"), "CHECKOUT a wallet on another network: no Pay, Switch to Arc Testnet");
  ck.net.refuseSwitch = false;
  await ck.click("pay-switch-network");
  await ck.until(() => ck.walletStatus() === "connected");
  check(ck.walletStatus() === "connected" && ck.shown("pay-submit") && ck.text("wallet-account").includes(B3.address.slice(0, 6)),
    "CHECKOUT after switching to Arc: connected, address in the header, Pay shown");

  ck.net.tamper = (b) => { b.terms.structure.rules[0].refund_percent = 100; return b; };
  await ck.go("#/pay/" + ckN);
  ck.net.tamper = null;
  check(ck.status() === "mismatch" && ck.shown("seal-mismatch") && ck.shown("pay-blocked") && !ck.shown("pay-submit"),
    "CHECKOUT terms that do not hash to the escrow's: Do not pay, payment blocked");

  ck.net.rpcDown = true;
  await ck.go("#/pay/" + ckN);
  check(ck.status() === "ready", "CHECKOUT Arc's RPC blocked: the terms are read through the wallet and verified");
  await ck.click("wallet-account");
  await ck.click("wallet-disconnect");
  await ck.go("#/pay/" + ckN);
  check(ck.status() === "ready" && ck.walletStatus() === "disconnected", "CHECKOUT RPC blocked and no wallet: the Worker reads the escrow and the terms are verified");
  ck.net.relayDown = true;
  await ck.go("#/pay/" + ckN);
  check(ck.status() === "rpc" && ck.shown("rpc-banner") && ck.shown("pay-waiting") && !ck.shown("pay-submit"),
    "CHECKOUT nothing can read the escrow: the banner, payment paused");
  ck.net.rpcDown = false;
  ck.net.relayDown = false;
  await ck.click("rpc-retry");
  await ck.until(() => ck.status() === "ready");
  check(ck.status() === "ready", "CHECKOUT Retry once Arc answers: verified");

  await ck.click("wallet-connect");
  await ck.click("connect-browser-wallet");
  await ck.until(() => ck.walletStatus() === "connected");
  ck.net.reject = true;
  await ck.click("pay-submit");
  await ck.until(() => ck.status() === "ready" && ck.shown("notice-rejected"));
  ck.net.reject = false;
  check(ck.shown("notice-rejected") && !(await core.checkout(ckN)).paid, "CHECKOUT rejected in the wallet: nothing charged, the notice, Pay again");

  const usdcOf = async (a) => BigInt(await pub.request({ method: "eth_call", params: [{ to: cfg.usdc, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"] }));
  const ckBefore = await usdcOf(B3.address), sentBefore = ck.net.sent.length;
  await ck.click("pay-submit");
  await ck.until(() => ck.status() === "paid", 20000);
  const sent = ck.net.sent.slice(sentBefore);
  check(ck.status() === "paid" && sent.length === 2 && ck.shown("badge-paid") && !ck.shown("pay-submit")
    && ck.attr("paid-tx-link", "href") === "https://explorer.testnet.arc.io/tx/" + sent[1] && ckBefore - (await usdcOf(B3.address)) === 2_000_000n,
    "CHECKOUT Pay: Approve then Pay in the wallet (2 signatures), 2.00 USDC into the escrow, Paid with the explorer link, no Pay button");
  check(ck.attr("store-notify", "data-notified") === "false" && ck.text("store-notify").includes("waiting for Tenet"),
    "CHECKOUT right after paying: registered on Arc, waiting for Tenet to read it");
  await tick(2, 20);
  await ck.until(() => ck.attr("store-notify", "data-notified") === "true");
  check(ck.attr("store-notify", "data-notified") === "true" && (await core.checkout(ckN)).store_notified_at > 0,
    "CHECKOUT once the store's webhook took the paid notice: The store is notified");
  await ck.load("#/pay/" + ckN);
  check(ck.status() === "paid" && ck.shown("paid-block") && !ck.shown("pay-submit") && ck.attr("store-notify", "data-notified") === "true",
    "CHECKOUT the paid order loaded again: Paid, no Pay button, the store already notified");

  // ---- TechShopping's page (techshopping/site) in a DOM ---------------
  say("-- TechShopping's new page");
  const sp = await makeShopPage({ getCore: () => core, cfg, shop, t, P });
  await sp.load("");
  const cards = [...sp.doc.querySelectorAll("#product-list .product-card")];
  check(cards.length === 3 && cards.every((c) => c.querySelector('[data-field="description"]').textContent === SHOP_PRODUCTS[c.getAttribute("data-product-id")].description),
    "SHOP the three products, each with the exact description Tenet keeps in its orders (what a not-as-described claim is judged on)");
  check(cards.every((c) => c.querySelectorAll('[data-list="specs"] .spec').length === 4),
    "SHOP every card has 4 specs, so the grids are full and the three Pay buttons line up");
  // The three cards line up (measured in a browser on techshopping.site: at 1280 and 1440 px the spec boxes start and end
  // at the same height and the Pay buttons sit 20 px below them in the three). linkedom has no layout: the rules that do it.
  const shopCss = readFileSync(P("techshopping/site/styles.css"), "utf8");
  check(/\.product-card__desc \{[^}]*line-height: 1\.5;[^}]*min-height: 3em;/.test(shopCss) && /\.spec__value \{[^}]*line-height: 1\.3; min-height: 2\.6em;/.test(shopCss)
    && /\.product-card__foot \{[^}]*margin-top: auto;/.test(shopCss) && /\.spec-grid \{ display: grid; grid-template-columns: 1fr 1fr;/.test(shopCss)
    && cards.every((c) => c.querySelectorAll('[data-list="specs"] .spec').length === 4),
    "SHOP the three cards line up: descriptions two lines tall, every spec two lines tall, 2 x 2 spec boxes, the Pay button at the bottom of each card");
  const shopIcon = readFileSync(P("techshopping/site/favicon.svg"), "utf8");
  check(sp.doc.querySelector('link[rel="icon"]')?.getAttribute("href").startsWith("favicon.svg") && /fill="#17140F"/.test(shopIcon) && /fill="#FF5A1F"/.test(shopIcon),
    "SHOP the store has its tab icon: a t on the store's ink with the orange dot of its wordmark");
  // The card as laid out: its elements, classes and what is hidden, without the button's busy flags. If a purchase
  // added, removed or showed anything inside the card, the button would move.
  const layout = (id) => { const c = sp.doc.getElementById(id).cloneNode(true); c.removeAttribute("data-state");
    c.querySelectorAll("[aria-busy]").forEach((e) => e.removeAttribute("aria-busy")); return c.outerHTML; };
  const css = readFileSync(P("techshopping/site/styles.css"), "utf8");
  const cardBefore = layout("product-charger");
  await sp.click("pay-charger");
  await sp.until(() => sp.attr("shop-toast", "data-kind") === "opened");
  const win = sp.net.opened[0], made = sp.text("shop-toast").match(/TS-\d{6}/)?.[0];
  check(sp.shown("shop-toast") && sp.attr("shop-toast", "data-kind") === "opened" && win && win.opener === null && made
    && /\/#pay\/TS-\d{6}$/.test(win.location.href) && sp.attr("shop-toast-link", "href") === win.location.href && !!(await core.checkout(made)),
    "SHOP Pay with Tenet: a new window opened in the same click, without access back to the store, sent to Tenet's checkout of the new order; the notice gives the order and the link");
  check(layout("product-charger") === cardBefore && sp.attr("product-charger", "data-state") === "idle"
    && !sp.doc.getElementById("shop-toast").closest(".product-card") && /\.toast \{ position: fixed; right: 20px; bottom: 20px;/.test(css)
    && ![...css.matchAll(/\.product-card\[data-state="(\w+)"\]([^{,]*)/g)].some((m) => m[1] !== "busy" || !/^ \.pay-btn/.test(m[2])),
    "SHOP after buying the card does not change (the Pay button stays where it was, in line with the others): the notice floats at the bottom right, outside the cards");
  await sp.click("shop-toast-close");
  check(!sp.shown("shop-toast"), "SHOP the notice closes with its button");
  sp.net.popupBlocked = true;
  await sp.click("pay-case");
  await sp.until(() => sp.attr("shop-toast", "data-kind") === "blocked");
  check(sp.shown("shop-toast") && /\/#pay\/TS-\d{6}$/.test(sp.attr("shop-toast-link", "href")) && sp.shown("shop-toast-link")
    && sp.text("shop-toast").includes("is ready") && sp.attr("product-case", "data-state") === "idle",
    "SHOP the browser blocks the new window: the notice says the order is ready and gives the checkout link");
  sp.net.popupBlocked = false;
  sp.net.buyFails = true;
  const opened = sp.net.opened.length;
  await sp.click("pay-earbuds");
  await sp.until(() => sp.attr("shop-toast", "data-kind") === "failed");
  check(sp.shown("shop-toast") && sp.text("shop-toast-title") === "Could not create your order" && !sp.shown("shop-toast-link")
    && sp.net.opened[opened] && sp.net.opened[opened].closed && sp.attr("product-earbuds", "data-state") === "idle",
    "SHOP the order cannot be created: the window it opened closes and the error goes to the same floating notice");
  sp.net.buyFails = false;
  await sp.go("#/orders/" + made);
  await sp.until(() => sp.attr("order-card", "data-order-id") === made);
  check(sp.attr("order-card", "data-payment") === "unpaid" && sp.text("order-status-pill") === "Waiting for payment" && /#pay\/TS-\d{6}$/.test(sp.attr("order-pay-link", "href")),
    "SHOP order status of an unpaid order: waiting for payment, with the link to pay on Tenet");
  await sp.go("#/orders/" + g1.order);
  await sp.until(() => sp.attr("order-card", "data-order-id") === g1.order);
  check(sp.attr("order-card", "data-payment") === "paid" && sp.text("order-status-pill") === "Refunded 1.50 USDC"
    && sp.doc.querySelectorAll('#order-emails .email-row[data-state="sent"]').length === 3 && sp.text("order-dates").includes("one day late")
    && sp.text("order-card").includes(g1.order.toLowerCase()) && sp.attr("order-claim-link", "href").endsWith("/orders/#/orders/" + g1.order),
    "SHOP order status of the late earbuds: refunded 1.50, the 3 emails sent to Tenet's address, delivered one day late, link to claim");

  // ---- My orders (site/orders) in a DOM -----------------------------
  say("-- the new My orders page");
  const moLate = await shop.buy("earbuds", await t()), moNad = await shop.buy("charger", await t()), moCase = await shop.buy("case", await t());
  for (const x of [moLate, moNad, moCase]) await pay(B4, await core.checkout(x.order));
  await tick(4, 20);
  const moDay = new Date((await t()) * 1000).toISOString().slice(0, 10);
  await warp(Math.max(60, Date.parse(moDay + "T00:00:00Z") / 1000 + 86400 + 400 - (await t())));
  await tick(5, 20);
  const mo = await makeOrdersPage({ getCore: () => core, cfg, pub, wallet, P });
  await mo.load("#/orders");
  check(mo.walletStatus() === "disconnected" && mo.shown("screen-wallet"), "ORDERS without a wallet: connect to see your orders");
  await mo.connect(B4);
  await mo.until(() => !!mo.doc.getElementById("order-row-" + moCase.order));
  check([moLate, moNad, moCase].every((x) => mo.text("order-row-" + x.order).includes("In escrow")), "ORDERS the wallet's orders, each In escrow");

  await mo.go("#/orders/" + moCase.order);
  check(mo.attr("claim-type-late", "aria-disabled") === "true" && mo.shown("late-disabled-note") && mo.attr("claim-type-not-delivered", "aria-disabled") === "false",
    "ORDERS It arrived late is off without a delivery email verified in Lacre, with the suggestion of It never arrived");
  const caseTo = (await core.orderView(moCase.order, await t())).mail_to, emailsText = mo.text("emails-card");
  check(caseTo === core.orderAddress(moCase.order) && /^orders?[-+]ts-\d{6}@/.test(caseTo)
    && emailsText.includes("to " + caseTo + ".") && (emailsText.match(/[^\s@]+@[^\s@]+/g) || []).length === 1,
    "ORDERS Store emails says where the store sends them: Tenet's address for this order, and no other address");

  await mo.go("#/orders/" + moNad.order);
  await mo.click("claim-type-not-as-described");
  await mo.type("answer-promised", "65 W");
  await mo.type("answer-arrived", "20 W");
  await mo.type("answer-delivered-on", moDay);
  await mo.type("answer-what-happened-nad", "The charger in the box is a 20 W one, not 65 W.");
  check(mo.attr("answer-promised", "maxlength") === "200" && mo.attr("answer-what-happened-nad", "maxlength") === "500", "ORDERS the fields keep Tenet's limits (200, and 500 for what happened)");
  await mo.load("#/orders/" + moNad.order);
  await mo.until(() => mo.status() === "detail");
  check(mo.attr("claim-type-not-as-described", "aria-checked") === "true" && mo.doc.getElementById("answer-arrived").value === "20 W",
    "ORDERS the chosen claim type and the answers survive a reload");
  await mo.switchAccount(B2);
  await mo.go("#/orders/" + moNad.order);
  check(mo.attr("claim-type-not-as-described", "aria-checked") === "true", "ORDERS and a change of account");
  await mo.click("claim-review");
  check(mo.shown("claim-confirm") && mo.text("claim-confirm").includes("You are claiming: It is not what the description says") && mo.text("confirm-summary").includes("20 W"),
    "ORDERS Review the claim: You are claiming ..., with the answers, before signing");
  const sentB2 = mo.net.sent.length;
  await mo.click("claim-sign");
  check(mo.shown("action-failed") && mo.text("action-failed").includes("Only the wallet that paid") && mo.net.sent.length === sentB2 && !(await core.orderView(moNad.order, await t())).claim,
    "ORDERS another account cannot sign the claim: nothing sent, it says which wallet paid");
  await mo.switchAccount(B4);
  await mo.go("#/orders/" + moNad.order);
  await mo.click("claim-review");
  await mo.click("claim-sign");
  await mo.until(() => mo.shown("pending-claim"));
  check(mo.text("pending-claim").includes("waiting for Tenet") && mo.attr("claim-sign", "data-sign-state") === "done",
    "ORDERS right after signing: registered on Arc, waiting for Tenet to read it; the button stays done");
  await tick(1, 5);
  await mo.until(() => mo.text("pending-claim").includes("Tenet read your claim") && mo.attr("step-store", "data-step-state") === "active");
  check(mo.attr("step-open", "data-step-state") === "done" && mo.attr("step-store", "data-step-state") === "active" && mo.shown("act-store"),
    "ORDERS the claim's steps: open done, waiting for the store with its countdown");
  await storeSays(moNad.order, "response", "Our test report for this unit, serial TS-C65-0042, shows 65 W.");
  for (let i = 0; i < 12; i++) { const v = await core.orderView(moNad.order, await t()); if (v.next?.action === "closing") break; await tick(1, 30); }
  await mo.until(() => mo.shown("proof-alert") && mo.text("proof-alert").includes("The store disputed your claim with a fact"));
  check(mo.shown("proof-alert") && mo.text("proof-alert").includes("The store disputed your claim with a fact") && mo.shown("proof-kind-label"),
    "ORDERS the closing round: the store disputed with a fact, add one more piece of proof (its kind and what it shows)");
  await mo.click("proof-kind-label");
  await mo.type("proof-text", "TS-C20 20W");
  await mo.click("proof-send");
  await mo.until(() => mo.shown("pending-proof"));
  const moSubs = (await core.orderView(moNad.order, await t())).submissions;
  await tick(1, 5);
  check(mo.attr("proof-send", "data-sign-state") === "done" && (await core.orderView(moNad.order, await t())).submissions.some((s) => s.party === "buyer" && s.kind === "closing_proof" && s.content?.proof_kind === "label" && s.content?.proof === "TS-C20 20W") && moSubs.length >= 1,
    "ORDERS the closing proof is registered as the escrow takes it (kind label, TS-C20 20W)");
  await storeSays(moNad.order, "closing_response", "The serial TS-C65-0042 on the box belongs to a 65 W unit.");
  const moNadV = await settled(moNad.order);
  await mo.until(() => mo.text("detail-status") === "Released to the store");
  check(moNadV.settled?.released === 2_000_000 && mo.text("detail-status") === "Released to the store", "ORDERS the claim decided for the store: Released to the store");

  await mo.go("#/orders/" + moLate.order);
  check(mo.attr("claim-type-late", "aria-disabled") === "false", "ORDERS with the delivery email verified, It arrived late can be chosen");
  await mo.click("claim-type-late");
  await mo.click("claim-review");
  check(mo.text("confirm-summary").includes("3 store emails"), "ORDERS a late claim's review lists the 3 store emails to register");
  await mo.click("claim-sign");
  await tick(1, 5);
  await mo.until(() => mo.attr("step-emails", "data-step-state") === "active");
  check(mo.attr("step-emails", "data-step-state") === "active" && mo.text("act-emails").includes("Register 3 store emails"), "ORDERS after the late claim: Register 3 store emails");
  const sentE = mo.net.sent.length;
  await mo.click("emails-register");
  await mo.until(() => mo.shown("pending-emails"), 20000);
  await tick(1, 5);
  check(mo.net.sent.length - sentE === 3 && (await core.orderView(moLate.order, await t())).submissions.filter((s) => s.kind === "evidence").length === 3,
    "ORDERS the 3 store emails registered with 3 signatures, as the Worker gave them");
  const moLateV = await settled(moLate.order);
  await mo.until(() => mo.text("detail-status") === "Refund ready");
  const tlRows = [...mo.doc.querySelectorAll("#timeline .tl")];
  const tlTx = tlRows.map((r) => r.querySelector("[data-f-tx]")?.getAttribute("href") || "").filter((h) => h && h !== "#");
  const tlText = tlRows.map((r) => r.querySelector('[data-f="what"]')?.textContent || "");
  const lateEv = (await core.orderView(moLate.order, await t())).events;
  check(tlTx.length === new Set(tlTx).size && lateEv.filter((e) => e.tx).length > tlTx.length
    && tlText.includes("Settled on Arc") && !tlText.includes("Verdict executed") && tlText.includes("Verdict proposed on Arc") && !tlText.includes("Verdict proposed"),
    `ORDERS the timeline has one line per transaction, its last state (${tlTx.length} transactions of ${lateEv.filter((e) => e.tx).length} events with one)`);
  await mo.go("#/orders");
  await mo.until(() => mo.shown("balance-card") && mo.text("balance-sources").includes(moLate.order));
  const moBal = await esc("claimable", [B4.address, USDC]);
  check(moLateV.settled?.refund === 1_500_000 && mo.text("balance-sources").includes(moLate.order) && mo.text("balance-card").includes((Number(moBal) / 1e6).toFixed(2)),
    "ORDERS the refund ready: the balance in the escrow and the order it comes from");
  await mo.click("balance-withdraw");
  await mo.until(() => mo.shown("pending-withdraw"), 20000);
  await tick(1, 5);
  await mo.until(() => mo.text("pending-withdraw").includes("Tenet read it"));
  check((await esc("claimable", [B4.address, USDC])) === 0n && mo.text("pending-withdraw").includes("Tenet read it") && mo.attr("balance-withdraw", "data-sign-state") === "done",
    "ORDERS Withdraw: the whole balance to the wallet, read by Tenet, the button done");
  mo.close();
  // A wallet that withdrew before the Worker read Withdrawn events (Randy's buyer on testnet, 2026-10-22): its refunds
  // are not shown as waiting, because the escrow's balance decides.
  gwMem.delete("wd:" + B1.address.toLowerCase());
  const mo2 = await makeOrdersPage({ getCore: () => core, cfg, pub, wallet, P });
  await mo2.load("#/orders");
  await mo2.connect(B1);
  await mo2.until(() => mo2.doc.querySelectorAll("#order-list [data-order-id]").length > 0);
  const b1Refunded = [...mo2.doc.querySelectorAll("#order-list [data-order-id]")].filter((r) => /Refunded/.test(r.textContent)).length;
  check((await esc("claimable", [B1.address, USDC])) === 0n && b1Refunded >= 1 && !mo2.text("order-list").includes("Refund ready") && !mo2.shown("balance-card"),
    "ORDERS a wallet that withdrew before Tenet read withdrawals: its refunds show as Refunded, none as waiting (the escrow's balance decides)");
  mo2.close();

  // ---- the store panel (merchants-site): page, wallet and locked screens -------------------
  say("-- the new store panel (merchants.paytenet.site)");
  const sha = (f) => createHash("sha256").update(readFileSync(P(f))).digest("hex");
  const merApp = readFileSync(P("merchants-site/app.js"), "utf8");
  check(sha("merchants-site/tenet.js") === sha("site/tenet.js") && sha("merchants-site/terms.js") === sha("site/terms.js")
    && [...merApp.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]).join() === "./tenet.js",
    "MERCHANTS the panel and the checkout use the same tenet.js and terms.js (same SHA-256), and the panel imports only tenet.js");
  const merHtml = readFileSync(P("merchants-site/index.html"), "utf8");
  check(!existsSync(P("merchants-site/sample-data.json")) && !/preview-bar|preview-chip|\?preview=1|sample-data/.test(merHtml + merApp)
    && !/arcscan/.test(merHtml + merApp) && merHtml.includes('fill="#1B3158"') && !merHtml.includes("Replace with the Arc logo")
    && !/connect-google|Continue with Google/.test(merHtml),
    "MERCHANTS published as it should: no preview bar or sample data, the official Arc icon, Arc's explorer, browser wallet only");
  const mp = await makeMerchantsPage({ getCore: () => core, cfg, pub, wallet, P });
  await mp.load("");
  check(mp.walletStatus() === "disconnected" && mp.shown("screen-wallet") && !mp.shown("layout") && mp.text("screen-wallet").includes("Connect your store's wallet"),
    "MERCHANTS without a wallet: connect the store's wallet, nothing else is shown");
  mp.net.chainId = "0x1";
  mp.net.refuseSwitch = true;
  await mp.connect(B3);
  mp.net.refuseSwitch = false;
  check(mp.walletStatus() === "error" && mp.shown("gate-switch-network") && !mp.shown("layout"), "MERCHANTS a wallet on another network: switch to Arc Testnet first");
  await mp.click("gate-switch-network");
  await mp.until(() => mp.status() === "ready");
  check(mp.net.chainId === "0x4cef52" && mp.walletStatus() === "connected" && mp.reg() === "nostore" && mp.shown("reg-domain")
    && mp.text("reg-domain").includes(B3.address.slice(0, 6)) && mp.attr("nav-orders", "data-locked") === "true",
    "MERCHANTS a wallet with no store: Register your store, starting with the domain; this wallet becomes the store");
  await mp.go("#/orders");
  check(mp.shown("screen-locked") && !mp.shown("screen-orders"), "MERCHANTS Orders before the store is active: Available when your store is active");
  await mp.disconnect();
  mp.net.down = true;
  await mp.connect(STORE);
  await mp.until(() => mp.status() === "down");
  check(mp.status() === "down" && mp.shown("retry-load") && !mp.shown("layout"), "MERCHANTS Tenet cannot be reached: says so, nothing signed, Try again");
  mp.net.down = false;
  await mp.click("retry-load");
  await mp.until(() => mp.status() === "ready");
  const tsView = await core.storeView(STORE.address, await t());
  await mp.go("#/register");
  const took = Math.max(1, Math.round((tsView.active_since - (tsView.stages?.key || 0)) / 60));
  check(mp.reg() === "active" && mp.shown("reg-active") && tsView.active_since > 0 && mp.text("reg-active").includes("Active since " + mp.T.state.data.registration.activatedAt)
    && /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC$/.test(mp.T.state.data.registration.activatedAt)
    && tsView.stages?.key && mp.shown("activation-took") && mp.text("activation-took") === `Activation took ${took} minutes.`
    && mp.attr("nav-orders", "data-locked") === "false" && mp.text("site-header").includes(TS),
    "MERCHANTS an active store registered with stage times (TechShopping in the rehearsal): Active since <date> and how long activation took");
  // TechShopping on testnet was activated before Tenet kept stage times: Active since <date> only, no invented times.
  const tsRec = gwMem.get("s:" + STORE.address.toLowerCase()), tsStages = tsRec.stages;
  delete tsRec.stages;
  await mp.disconnect();
  await mp.connect(STORE);
  check(mp.reg() === "active" && mp.text("reg-active").includes("Active since ") && !mp.shown("activation-took"),
    "MERCHANTS an active store without stage times (TechShopping on testnet): Active since <date> only, no invented times");
  tsRec.stages = tsStages;
  await mp.go("#/terms");
  check(mp.shown("screen-terms") && mp.doc.getElementById("terms-signed").textContent === tsView.terms.text
    && tsView.terms.text === render(tsView.terms.structure, tsView.terms.hold_days, cfg.windows_text) && mp.text("screen-terms").includes(tsView.terms.terms_hash),
    "MERCHANTS Terms: the signed text as terms.js renders it, and its hash");
  await mp.disconnect();
  await mp.connect(STORE2);
  await mp.go("#/register");
  const gbView = await core.storeView(STORE2.address, await t());
  check(["key", "key_pending", "judges", "escrow", "failed", "active"].includes(gbView.state) && mp.reg() === gbView.state
    && mp.shown({ active: "reg-active", failed: "reg-failed" }[gbView.state] || "reg-activation"),
    `MERCHANTS a store past its test email (GadgetBox, ${gbView.state} in the rehearsal): the page shows the same stage`);
  mp.close();

  // ---- the store panel: a new store registers through the page, signed by its own wallet ---------------------
  const NINE = "shopnine.site", nineTxt = "tenet-merchant=" + B3.address.toLowerCase();
  const mb = await makeMerchantsPage({ getCore: () => core, cfg, pub, wallet, P });
  await mb.load("#/register");
  await mb.connect(B3);
  await mb.type("f-domain", "not a domain");
  await mb.click("reg-start");
  await mb.until(() => mb.shown("reg-error"));
  check(mb.reg() === "nostore" && /not a domain name/i.test(mb.text("reg-error")), "MERCHANTS B a domain that is not one: refused, and the page says why");
  await mb.type("f-domain", NINE);
  await mb.click("reg-start");
  await mb.until(() => mb.reg() === "txt");
  await mb.click("copy-txt-value");
  check(mb.reg() === "txt" && !mb.shown("reg-error") && mb.text("reg-txt").includes("_tenet." + NINE) && mb.text("reg-txt").includes(nineTxt) && mb.copied.at(-1) === nineTxt,
    "MERCHANTS B Start: the TXT record to publish (name and value, with copy buttons)");
  await mb.click("reg-check-txt");
  await mb.until(() => mb.reg() === "txtfail");
  check(mb.shown("txt-fail") && /no tenet-merchant record/.test(mb.text("txt-fail")), "MERCHANTS B the TXT is not there yet: TXT not found, with what Tenet read");
  txt.set("_tenet." + NINE, [nineTxt]);
  await mb.click("reg-check-txt");
  await mb.until(() => mb.reg() === "policy");
  check(mb.shown("reg-policy") && mb.attr("reg-steps", "id") && mb.doc.querySelector('#reg-steps [data-step="1"]').getAttribute("data-step-state") === "done",
    "MERCHANTS B the TXT checks: step 1 done, paste the refund policy");
  await mb.type("f-policy", "We are a small shop and we answer every email within a day or two.");
  await mb.click("reg-draft");
  await mb.until(() => mb.reg() === "policy" && mb.shown("reg-error"));
  check(/could not read a fixed refund/.test(mb.text("reg-error")), "MERCHANTS B a policy with no fixed refund: no draft, the page says so");
  await mb.type("f-policy", POLICY.replace(/TechShopping/g, "ShopNine") + " Please contact us first, and delays caused by customs are not covered.");
  await mb.click("reg-draft");
  await mb.until(() => mb.reg() === "draft");
  check(mb.doc.querySelectorAll("#rule-editors .rule-editor").length === 3 && mb.attr("store-conditions", "data-flagged") === "true"
    && mb.doc.getElementById("f-preconditions").value === "contact the store first" && mb.doc.getElementById("f-excluded-causes").value === "customs"
    && mb.doc.querySelectorAll("#rule-editors [data-rule-field='pre'], #rule-editors [data-rule-field='excl']").length === 0,
    "MERCHANTS B the draft: one editor per rule, and preconditions and excluded causes once for the whole store, flagged for review");
  await mb.load("#/register");
  await mb.connect(B3);
  check(mb.reg() === "draft" && mb.doc.querySelectorAll("#rule-editors .rule-editor").length === 3, "MERCHANTS B the draft survives a reload (Tenet keeps it)");
  check(mb.attr("sign-confirm", "data-sign-state") === "disabled" && /order prefix/.test(mb.text("form-error")), "MERCHANTS B Sign and confirm waits for a valid form (the order prefix first)");
  await mb.type("f-order-prefix", "SN-");
  await mb.type("f-webhook-url", "https://shopnine.site/api/tenet");
  check(mb.attr("sign-confirm", "data-sign-state") === "disabled" && /Clear preconditions/.test(mb.text("form-error")),
    "MERCHANTS B with something in preconditions or excluded causes the terms cannot be signed");
  await mb.type("f-preconditions", "");
  await mb.type("f-excluded-causes", "");
  const lateIdx = mb.T.state.rules.findIndex((r) => r.key === "late");
  await mb.type(`r${lateIdx}-refund`, "40");
  await mb.click("day-type-business");
  const preview = mb.doc.getElementById("terms-preview").textContent;
  check(mb.attr("sign-confirm", "data-sign-state") === "idle" && mb.attr("store-conditions", "data-flagged") === "false"
    && preview.includes("you get a refund of 40% of the order total") && preview.includes("Days are counted as business days") && !/Conditions:\n- You must contact/.test(preview),
    "MERCHANTS B the terms text follows the edits (terms.js), and with the form valid the store can sign");
  await mb.click("sign-confirm");
  await mb.until(() => mb.reg() === "test", 15000);
  const nine = await core.storeView(B3.address, await t());
  const apiShown = mb.text("creds-visible");
  check(nine.state === "test_email" && nine.terms.text === preview && nine.terms.terms_hash === (await termsHash(nine.terms.structure, 30, cfg.windows_text))
    && nine.terms.structure.day_type === "business" && nine.terms.structure.rules.find((r) => r.event === "late").refund_percent === 40
    && !nine.terms.structure.preconditions.length && !nine.terms.structure.excluded_causes.length,
    "MERCHANTS B signed in the store's wallet: Tenet registers exactly the terms the page showed (same text, same hash)");
  check(mb.shown("creds-visible") && /tk_[0-9a-f]{48}/.test(apiShown) && /ws_[0-9a-f]{48}/.test(apiShown) && mb.text("test-email-card").includes(nine.test_address),
    "MERCHANTS B the API key and the webhook secret shown once, and the address for the test email");
  await mb.click("hide-credentials");
  check(mb.shown("creds-hidden") && !mb.shown("creds-visible") && !/tk_[0-9a-f]{48}/.test(mb.doc.body.textContent), "MERCHANTS B I saved both: the credentials leave the page for good");
  await core.receiveEmail(nine.test_address, buildMime({ from: "ShopNine <orders@shopnine.site>", to: nine.test_address, subject: "test", text: "Hi\n", html: "",
    t: await t(), keys: { store: keys.gb, ses: keys.ses }, textOnly: true, domain: NINE }), await t());
  await mb.click("reg-check-test");
  await mb.until(() => mb.reg() === "testfail");
  check(mb.shown("test-fail") && /text\/plain/.test(mb.text("test-fail-list")), "MERCHANTS B a test email in the wrong format: Last test email did not pass, and why");
  txt.set(`${SEL}._domainkey.${NINE}`, [`v=DKIM1; k=rsa; p=${keys.gbSpki}`]);
  await core.receiveEmail(nine.test_address, buildMime({ from: "ShopNine <orders@shopnine.site>", to: nine.test_address, subject: "test", text: "Hi\n",
    html: "<p>Hi</p>", t: await t(), keys: { store: keys.gb, ses: keys.ses }, domain: NINE }), await t());
  await mb.click("reg-check-test");
  await mb.until(() => mb.reg() !== "testfail" && mb.reg() !== "test");
  const nineKey = await core.storeView(B3.address, await t());
  check(["key", "key_pending", "judges"].includes(mb.reg()) && mb.shown("reg-activation") && mb.shown("activation-elapsed")
    && nineKey.stages && nineKey.stages.started && nineKey.stages.test_email && nineKey.stages.key,
    "MERCHANTS B the test email passes: Pending activation, with the time since it started (Tenet keeps when each stage began)");
  await tick(3, 20);
  await mb.click("reg-check-again");
  const nineNow = await core.storeView(B3.address, await t());
  check(mb.reg() === nineNow.state && (nineNow.state !== "failed" || (mb.shown("reg-failed") && mb.text("reg-failed").includes(nineNow.failure.slice(1)) && mb.text("reg-failed").includes("UTC"))),
    `MERCHANTS B Check again follows the store (${nineNow.state} in the rehearsal); a failure says what failed and when`);
  mb.close();

  // ---- the store panel: the store's orders (answer, closing round, refund of a stray payment) ----------------
  const cN = (await shop.buy("charger", await t())).order;
  await pay(B1, await core.checkout(cN));
  await tick(3, 20);
  await openClaim(B1, cN, "not_as_described", claimNad(cN, false));
  await tick(2, 5);
  const ghost3 = "TS-999997";
  await pay(B2, { ref: orderRef(ghost3), merchant: STORE.address, amount_cents: 100, terms: co1.terms });
  await tick(2, 5);
  const cU = (await shop.buy("case", await t())).order;
  const mc = await makeMerchantsPage({ getCore: () => core, cfg, pub, wallet, P });
  await mc.load("#/orders");
  await mc.connect(STORE);
  await mc.until(() => mc.doc.querySelectorAll("#orders-list .orders-row--item").length > 0);
  const rowIds = [...mc.doc.querySelectorAll("#orders-list .orders-row--item")].map((r) => r.getAttribute("data-order-id"));
  const ghostId = rowIds.find((id) => /^unknown-/.test(id) && mc.T.state.data.orders.find((o) => o.id === id).raw.ref === orderRef(ghost3).toLowerCase());
  check(rowIds[0] === cU && rowIds.indexOf(cN) < rowIds.indexOf(g4) && ghostId && mc.attr("order-row-" + cN, "data-needs") === "true"
    && mc.attr("order-row-" + ghostId, "data-needs") === "true" && Number(mc.text("nav-orders").replace(/\D/g, "")) >= 2 && mc.text("order-row-" + ghostId).includes("\u2026"),
    "MERCHANTS C the store's orders, newest first; the ones that need the store are marked and counted; a stray payment shows by its reference");
  await mc.go("#/orders/" + cU);
  check(mc.shown("action-wait") && /Not paid yet/.test(mc.text("action-wait")) && mc.text("order-row-" + cU).includes("Not paid"), "MERCHANTS C an order not paid yet: nothing to do, Tenet notifies the webhook");
  await mc.go("#/orders/" + cN);
  const quote = mc.text("action-respond");
  check(mc.shown("action-respond") && quote.includes("The charger in the box is a 20 W one") && quote.includes("Promised: 65 W") && /left$/.test(mc.doc.querySelector("[data-countdown]").textContent)
    && mc.attr("sign-response", "data-sign-state") === "disabled" && mc.attr("f-response", "maxlength") === String(cfg.limits.panel_chars),
    "MERCHANTS C a claim to answer: what the buyer wrote, the window's countdown, Tenet's length limit; nothing to sign before writing");
  const cNev = (await core.orderView(cN, await t())).events.slice(-6), links = [...mc.doc.querySelectorAll("#order-timeline .event__tx")].map((a) => a.getAttribute("href"));
  check(links.length === cNev.length && cNev.some((e) => e.tx) && cNev.every((e, i) => !e.tx ? links[i] === null
    : links[i] === (e.net === "arc" ? "https://explorer.testnet.arc.io/tx/" : "https://explorer-bradbury.genlayer.com/tx/") + e.tx),
    "MERCHANTS C the order's timeline (last 6): each transaction opens its network's explorer (Arc, or Bradbury for the judge and Lacre)");
  // The time column fits "Oct 23, 14:02" on one line (the design's 46 px split it in three; measured in a browser at 768 to
  // 1440 px), and on a phone it goes above the event. linkedom has no layout, so this checks the rules themselves.
  const merCss = readFileSync(P("merchants-site/styles.css"), "utf8");
  const phone = (/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(merCss) || [])[1] || "";
  check(/\.event \{ display: grid; grid-template-columns: max-content 12px 1fr auto;/.test(merCss) && /\.event__t \{[^}]*white-space: nowrap;/.test(merCss)
    && /\.event \{ grid-template-columns: 12px 1fr auto;/.test(phone) && /\.event__t \{ grid-column: 2 \/ -1; grid-row: 1; \}/.test(phone)
    && /\.event__what \{ grid-column: 2; grid-row: 2; \}/.test(phone) && /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/.test(mc.doc.querySelector("#order-timeline .event__t").textContent),
    "MERCHANTS C the timeline's date and time on one line (a column as wide as it needs, no wrap); on a phone, above the event");
  const ANSWER = "Our test report for this unit, serial TS-C65-0042, shows 65 W.";
  await mc.type("f-response", ANSWER);
  const mcSent = mc.net.sent.length;
  await mc.click("sign-response");
  const answered = (kind) => mc.T.state.sign[`response:${cN}:${kind}`] === "done";
  for (let i = 0; i < 40 && !answered("response"); i++) { await tick(1, 3); await new Promise((r) => setTimeout(r, 150)); }
  const cNv = await core.orderView(cN, await t());
  check(answered("response") && mc.net.sent.length === mcSent + 1
    && cNv.submissions.some((x) => x.party === "merchant" && x.kind === "response" && x.content === ANSWER),
    "MERCHANTS C Send the answer: one transaction from the store's wallet, the answer on chain as written, the button done once Tenet read it");
  for (let i = 0; i < 12; i++) { const o = await core.orderView(cN, await t()); if (o.next?.action === "closing") break; await tick(1, 30); }
  await submit(B1, cN, cj({ party: "buyer", kind: "closing_proof", content: { proof_kind: "label", proof: "TS-C20 20W" } }));
  await tick(2, 3);
  // Read the store again now (the panel does it every 15 s on its own), and reconnect if the closing round is not there yet.
  await mc.click("reg-check-again");
  for (let i = 0; i < 40 && !(mc.T.state.data.orders.find((o) => o.id === cN) || {}).responseKind?.startsWith("closing"); i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (i % 10 === 9) { await mc.disconnect(); await mc.connect(STORE); await mc.go("#/orders/" + cN); }
  }
  check(mc.shown("action-respond") && mc.text("action-respond").includes("Buyer, latest proof") && mc.text("action-respond").includes("Proof (label): TS-C20 20W")
    && mc.text("action-respond").includes("Closing answer to the buyer's last proof") && mc.attr("sign-response", "data-sign-state") === "disabled",
    "MERCHANTS C the closing round: the buyer's last proof, and one closing answer in its own window");
  const CLOSING = "The serial TS-C65-0042 on the box belongs to a 65 W unit.";
  await mc.type("f-response", CLOSING);
  await mc.click("sign-response");
  for (let i = 0; i < 40 && !answered("closing_response"); i++) { await tick(1, 3); await new Promise((r) => setTimeout(r, 150)); }
  check(answered("closing_response") && (await core.orderView(cN, await t())).submissions.some((x) => x.party === "merchant" && x.kind === "closing_response" && x.content === CLOSING),
    "MERCHANTS C Send the closing answer: registered on chain from the store's wallet");
  await mc.go("#/orders/" + ghostId);
  check(mc.shown("action-refund") && mc.text("action-refund").includes("the store never created this order") && mc.text("action-refund").includes("1.00 USDC"),
    "MERCHANTS C a payment that matches no order: what arrived, from whom and why, with Refund in full");
  await mc.click("sign-refund");
  for (let i = 0; i < 40 && mc.attr("sign-refund", "data-sign-state") !== "done"; i++) { await tick(1, 3); await new Promise((r) => setTimeout(r, 150)); }
  await mc.until(() => mc.T.state.data.orders.find((o) => o.id === ghostId)?.action === "settled");
  check((await core.orderView(ghostId, await t())).settled?.refund === 1_000_000 && mc.shown("action-settled") && mc.text("action-settled").includes("Refunded in full"),
    "MERCHANTS C Refund in full: merchantRefund from the store's wallet, then the order shows as settled");
  await mc.go("#/orders/" + g4);
  check(mc.shown("action-settled") && /no refund/.test(mc.text("action-settled")) && mc.text("action-settled").includes("2.00 USDC"),
    "MERCHANTS C a settled claim: the result and how much went to each side");
  const synth = mc.T.toData({ merchant: STORE.address.toLowerCase(), domain: TS, state: "active", txt: {}, orders: [{ order: "TS-123456", ref: "0x" + "1".repeat(64),
    merchant: STORE.address.toLowerCase(), amount_cents: 300, paid: true, paid_at: 1, events: [], steps: [], submissions: [], mails: [], claim: { event: "late", judge: "mail", at: 1 },
    mail_to: "order-ts-123456@" + cfg.mail_domain, windows_seconds: cfg.windows_seconds,
    next: { action: "send_readable_email", until: Math.floor(Date.now() / 1000) + 200, text: "Send a readable email (multipart with a text part) to order-ts-123456@" + cfg.mail_domain + " before the window closes." } }] });
  const ro = synth.orders[0];
  check(ro.action === "send_readable_email" && ro.orderAddress === "order-ts-123456@" + cfg.mail_domain && ro.windowSecondsLeft > 100 && /readable email/.test(ro.issueText),
    "MERCHANTS C the judge could not read a store email: the order's address and the window to send a readable one (as the Worker says)");
  mc.close();

  // ---- the store panel: balance and withdrawal ---------------------------------------------------------------
  const cNs = await settled(cN);
  const units = await esc("claimable", [STORE.address, USDC]);
  const md = await makeMerchantsPage({ getCore: () => core, cfg, pub, wallet, P });
  await md.load("#/balance");
  await md.connect(STORE);
  await md.until(() => md.T.state.data.balance.units === units);
  const bal = md.T.state.data.balance, money = (u) => (Number(u) / 1e6).toFixed(2);
  const srcUnits = bal.sources.map((x) => BigInt(Math.round(Number(x.amount) * 1e6)));
  const srcSum = srcUnits.reduce((a, b) => a + b, 0n);
  const heldNow = (await core.storeView(STORE.address, await t())).orders.filter((o) => o.paid && !o.settled && !o.unexpected);
  check(units > 0n && cNs.settled?.released > 0 && md.text("screen-balance").includes(money(units) + " USDC") && bal.sources[0].orderId === cN
    && /not as described claim denied/.test(bal.sources[0].why) && srcSum >= units && srcSum - srcUnits.at(-1) < units,
    "MERCHANTS D Balance: what the escrow holds for the store (claimable read on Arc), and the orders it comes from, newest first, up to that amount");
  check(md.text("screen-balance").includes(`${heldNow.length} orders`) && md.text("screen-balance").includes(money(heldNow.reduce((n, o) => n + o.amount_cents * 1e4, 0)) + " USDC")
    && md.attr("sign-withdraw", "data-sign-state") === "idle" && md.text("sign-withdraw").includes(`Withdraw ${money(units)} USDC`),
    "MERCHANTS D still held in escrow (paid orders not settled), and one Withdraw for the whole balance");
  const usdcBefore = await usdcOf(STORE.address);
  await md.click("sign-withdraw");
  await md.until(() => md.T.state.sign.withdraw === "done", 15000);
  await md.until(() => md.T.state.data.balance.units === 0n);
  check(md.T.state.sign.withdraw === "done" && (await esc("claimable", [STORE.address, USDC])) === 0n && (await usdcOf(STORE.address)) - usdcBefore === units
    && md.text("sign-withdraw").includes("Withdrawn") && md.text("screen-balance").includes(`${money(units)} USDC sent to`) && md.text("screen-balance").includes("0.00 USDC"),
    "MERCHANTS D Withdraw: one transaction from the store's wallet, the whole balance in the wallet, the escrow at 0.00 and the button done");
  await md.load("#/balance");
  await md.connect(STORE);
  await md.until(() => md.T.state.status === "ready");
  await md.until(() => md.T.state.data.balance.units === 0n && md.attr("sign-withdraw", "data-sign-state") === "disabled");
  check(md.attr("sign-withdraw", "data-sign-state") === "disabled" && md.text("screen-balance").includes("Nothing released to this wallet yet"),
    "MERCHANTS D with nothing released, Withdraw is off and says so");
  md.close();

  // ---- the store panel: the signed terms, checked against the escrow -------------------------------------------
  const me = await makeMerchantsPage({ getCore: () => core, cfg, pub, wallet, P });
  await me.load("#/terms");
  await me.connect(STORE);
  await me.until(() => ["ok", "bad", "unknown"].includes(me.T.state.data.termsCheck));
  const tsTerms = (await core.storeView(STORE.address, await t())).terms, onChainHash = String(await esc("merchantTermsHash", [STORE.address])).toLowerCase();
  check(me.shown("terms-ok") && !me.shown("terms-bad") && me.doc.getElementById("terms-signed").textContent === render(tsTerms.structure, tsTerms.hold_days, cfg.windows_text)
    && me.text("screen-terms").includes(onChainHash) && onChainHash === tsTerms.terms_hash && me.text("screen-terms").includes("Confirmed by signature on "),
    "MERCHANTS E Terms: the text terms.js renders from the registered structure, the hash the page computes, the same the escrow holds on Arc");
  // If what Tenet shows were not what the escrow holds (here: a rule changed in Tenet's record), the page says so.
  const tsRec2 = gwMem.get("s:" + STORE.address.toLowerCase()), tsStruct = structuredClone(tsRec2.structure);
  tsRec2.structure.rules.find((r) => r.event === "late").refund_percent = 100;
  await me.load("#/terms");
  await me.connect(STORE);
  await me.until(() => ["ok", "bad", "unknown"].includes(me.T.state.data.termsCheck));
  check(me.shown("terms-bad") && !me.shown("terms-ok") && me.text("terms-bad").includes(onChainHash), "MERCHANTS E terms that do not match the escrow: Does not match, with the hash the escrow holds");
  tsRec2.structure = tsStruct;
  me.close();

  // ---- /app/: the old page's links go to My orders, the checkout or the store panel ----------------------
  const appHtml = readFileSync(P("site/app/index.html"), "utf8");
  const appScript = /<script>([\s\S]*?)<\/script>/.exec(appHtml)[1];
  const goesTo = (hash) => { let to = null; vm.runInNewContext(appScript, { window: { location: { hash, replace: (u) => { to = u; } } } }); return to; };
  const M = "https://merchants.paytenet.site/";
  check(goesTo("#orders") === "/orders/#/orders" && goesTo("#orders/TS-171823") === "/orders/#/orders/TS-171823" && goesTo("#pay/TS-171823") === "/pay/#pay/TS-171823"
    && goesTo("#stores") === M + "#/register" && goesTo("#panel") === M + "#/orders" && goesTo("#how") === "/how/" && goesTo("") === M
    && goesTo("#orders/<script>") === M && !/pay\.js/.test(appHtml) && readdirSync(P("site/app")).join() === "index.html" && appHtml.includes('http-equiv="refresh" content="0; url=' + M + '"'),
    "APP /app/ is only the redirect page (the old page is gone): old order links to My orders, payment links to the checkout, How it works to /how/, stores and panel to merchants.paytenet.site, the rest there too");

  // ---- the home page (site/index.html): links from stores go on to the checkout (site/pay/) --------------
  const homeHtml = readFileSync(P("site/index.html"), "utf8");
  const homeScript = /<script>([\s\S]*?)<\/script>/.exec(homeHtml)[1];
  const homeTo = (hash) => { let to = null; vm.runInNewContext(homeScript, { window: { location: { hash, replace: (u) => { to = u; } } } }); return to; };
  check(homeTo("#pay/TS-171823") === "/pay/#pay/TS-171823" && homeTo("#/pay/TS-171823") === "/pay/#pay/TS-171823" && homeTo("#orders") === "/orders/#/orders"
    && homeTo("#orders/TS-171823") === "/orders/#/orders/TS-171823" && homeTo("#stores") === M + "#/register" && homeTo("#panel") === M + "#/orders"
    && homeTo("#how") === "/how/" && homeTo("") === null && homeTo("#top") === null && homeTo("#products") === null && homeTo("#pay") === null,
    "HOME paytenet.site: a store's payment link (#pay/<order>, the form the Worker and TechShopping give) opens the checkout at /pay/; the earlier pages' links go where they went; the page's own anchors stay");
  const ckHtml = readFileSync(P("site/pay/index.html"), "utf8");
  const ckLinkForms = [unpaid.checkout_url.replace(/[^/]+$/, "TS-171823"), JSON.parse(readFileSync(P("techshopping/site/store.json"), "utf8")).store.checkoutUrlTemplate.replace("{orderId}", "TS-171823")];
  check(ckLinkForms.every((u) => new URL(u).origin === "https://paytenet.site" && new URL(u).pathname === "/") &&['href="../favicon.svg', 'href="../styles.css', 'src="../circle.js', 'src="../checkout.js', 'href="../" class="brand"'].every((s) => ckHtml.includes(s))
    && homeTo(new URL(ckLinkForms[0]).hash) === "/pay/" + new URL(ckLinkForms[0]).hash && homeTo(new URL(ckLinkForms[1]).hash) === "/pay/" + new URL(ckLinkForms[1]).hash,
    "HOME the checkout at /pay/ loads the shared files from the site root and its brand goes home; the Worker's and TechShopping's link forms both reach it");
  const homeLinks = [...homeHtml.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const HOME_LINKS = ["#top", "#products", "https://github.com/randyparrs/Tenet", "https://youtu.be/z4cT_LdlxKg", "https://techshopping.site",
    "https://tenet.rpmdev.app/#live-cases", "https://tenet.rpmdev.app/#how-it-works", "https://tenet.rpmdev.app/#demo-shop", "https://paytenet.site/orders/",
    "https://paytenet.site/how/", "https://merchants.paytenet.site", "https://github.com/randyparrs/tenet-pay", "https://lacre.in-sidr.xyz"];
  const homeFiles = [...homeHtml.matchAll(/(?:href|src)="((?:home\.(?:css|js)|favicon\.svg)[^"]*)"/g)].map((m) => m[1].split("?")[0]);
  check(homeLinks.every((h) => HOME_LINKS.includes(h)) && HOME_LINKS.every((h) => homeLinks.includes(h)) && homeFiles.join() === "favicon.svg,home.css,home.js"
    && homeFiles.every((f) => existsSync(P("site/" + f))) && !/[–—]/.test(homeHtml + readFileSync(P("site/home.js"), "utf8") + readFileSync(P("site/home.css"), "utf8"))
    && /<h1[^>]*>Buyer protection for stablecoin payments\.<\/h1>/.test(homeHtml),
    "HOME links: Products, both repositories, the video, TechShopping, Tenet's live cases, How it works and Demo Shop, My orders, How it works, For stores, Lacre; its own files are home.css, home.js and the favicon");
  check(/<p class="hero__eyebrow" id="hero-eyebrow"[^>]*>RULES DETERMINE OUTCOMES\.<\/p>\s*<h1 /.test(homeHtml)
    && homeHtml.includes('id="hero-lede">The payment waits in escrow on Arc. If something goes wrong, a judge on GenLayer decides.</span>')
    && !homeHtml.includes("hero__lede-rule") && /\.hero__eyebrow \{[^}]*font-family: var\(--font-mono\);[^}]*color: var\(--color-green\);/.test(readFileSync(P("site/home.css"), "utf8")),
    "HOME hero: the green monospace label RULES DETERMINE OUTCOMES. above the title, the subtitle on escrow and the judge, no rule before it");
  const circleJs = readFileSync(P("site/circle.js"), "utf8");
  const circleMeta = (html) => (/<meta name="tenet-circle" content="([^"]*)">/.exec(html) || [])[1];
  const tenetCircle = circleMeta(readFileSync(T("site/index.html"), "utf8"));
  const ordersHtml = readFileSync(P("site/orders/index.html"), "utf8");
  check(circleJs.includes("redirectUri: location.origin + location.pathname,") && !circleJs.includes("redirectUri: location.origin,")
    && circleJs.includes("s.src = new URL('circle-sdk.js', me || location.href).href") && new URL("circle-sdk.js", "https://paytenet.site/circle.js?v=1").pathname === "/circle-sdk.js"
    && /^[0-9a-f-]{36}\|\d+-\w+\.apps\.googleusercontent\.com$/.test(tenetCircle) && circleMeta(ckHtml) === tenetCircle && circleMeta(ordersHtml) === tenetCircle
    && /src="\.\.\/circle\.js\?v=/.test(ckHtml) && /src="\.\.\/circle\.js\?v=/.test(ordersHtml),
    "CIRCLE the checkout (/pay/) and My orders (/orders/) offer Continue with Google with Tenet's Circle app and Google client; Google sends the buyer back to the page they left and the SDK loads from the site root");
  const homeImgs = [...homeHtml.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
  check(homeImgs.join() === "logos/arc.svg,logos/genlayer.svg,logos/lacre.svg,https://i.ytimg.com/vi/z4cT_LdlxKg/maxresdefault.jpg"
    && readdirSync(P("site/logos")).join() === "arc.svg,genlayer.svg,lacre.svg"
    && ["arc", "genlayer", "lacre"].every((n) => /^(<\?xml[^>]*\?>)?\s*<svg[\s>]/.test(readFileSync(P(`site/logos/${n}.svg`), "utf8")) && !/<script|\son\w+=|href=/i.test(readFileSync(P(`site/logos/${n}.svg`), "utf8")))
    && !homeHtml.includes("logo-slot"),
    "HOME logos only in Built on: the official marks of Arc, GenLayer and Lacre (plain SVG, no script, no links); the only other image is the video's thumbnail");
  const tenetData = JSON.parse(readFileSync(T("site/data/tenet.json"), "utf8"));
  const c3 = /^(\d+) \/ (\d+)$/.exec(tenetData.measurements.runs.find((r) => r.id === "C3").results["correct decision"]);
  const homeNumbers = { "verdicts-expected": tenetData.bradbury_run.cases.filter((c) => c.passed === true).length, "verdicts-total": tenetData.bradbury_run.cases.length,
    "committee-correct": +c3[1], "committee-total": +c3[2], "orders-settled": tenetData.live_cases.filter((c) => c.status === "settled").length };
  const homeShown = Object.fromEntries([...homeHtml.matchAll(/<span data-field="([a-z-]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]));
  check(Object.keys(homeShown).length === 5 && Object.entries(homeNumbers).every(([k, v]) => homeShown[k] === String(v)),
    `HOME the three numbers are Tenet's data at the pinned commit (build_site.py): verdicts ${homeShown["verdicts-expected"]} / ${homeShown["verdicts-total"]}, committee C3 ${homeShown["committee-correct"]} / ${homeShown["committee-total"]}, live orders settled ${homeShown["orders-settled"]}`);

  say(`judge sends ${c.sends.judge}, Lacre attestations ${c.sends.attest}, set_merchant ${c.sends.set_merchant}, register_key ${c.sends.register_key}, confirm_key ${c.sends.confirm_key}`);
}

const PRODUCTS_DESC = { charger: "USB-C wall charger, 65 W, model TS-C65, with a 1 m cable." };

main().catch((e) => { console.error(e); say("GATEWAY REHEARSAL ERROR: " + (e.stack || e.message)); writeFileSync(P("results/gateway-rehearsal.txt"), lines.join("\n") + "\n"); process.exit(1); });
