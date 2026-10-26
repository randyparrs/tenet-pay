// Store emails as Tenet receives them (Cloudflare Email Routing hands the raw MIME to the Worker). Copies of
// what the project's Python and the judges compute, checked byte for byte by worker/test/mime.test.mjs:
//   headersBlob  Lacre's tools/headers_blob.build (the blob attest_inline takes)
//   judgeText    the gateway email judge's _tx (contracts/build_judge_gw.py): the text the committee reads,
//                or null when the judge gives I11
// Messages are handled as latin-1 strings (one char per byte), as the demo Worker does.

export const MAX_BODY = 12288;

/** Header block and body: split at the first empty line (CRLF, or LF in a copy that lost its CRs). */
export function split(raw) {
  const found = [["\r\n\r\n", raw.indexOf("\r\n\r\n")], ["\n\n", raw.indexOf("\n\n")]].filter(([, i]) => i >= 0);
  if (!found.length) return { head: raw, body: "" };
  const [sep, i] = found.sort((a, b) => a[1] - b[1])[0];
  return { head: raw.slice(0, i + sep.length / 2), body: raw.slice(i + sep.length) };
}

/** dkimcore.parse_headers: [name, value] per field, folds kept as CRLF + the continuation line. */
export function parseHeaders(head) {
  const fields = [];
  for (let line of head.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line[0] === " " || line[0] === "\t") {
      if (fields.length) fields[fields.length - 1][1] += "\r\n" + line;
      continue;
    }
    const i = line.indexOf(":");
    if (i >= 0) fields.push([line.slice(0, i), line.slice(i + 1)]);
  }
  return fields;
}

const fieldName = (n) => n.replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();

/** dkimcore.parse_tags */
export function parseTags(text) {
  const tags = {};
  for (const spec of text.split(";")) {
    const i = spec.indexOf("=");
    if (i < 0) continue;
    const name = spec.slice(0, i).trim();
    if (name) tags[name] = spec.slice(i + 1).trim();
  }
  return tags;
}

/** Every DKIM-Signature of the message, in order: {index, d, s, tags}. */
export function signatures(fields) {
  return fields.map(([n, v], index) => [n, v, index]).filter(([n]) => fieldName(n) === "dkim-signature").map(([, v, index]) => {
    const tags = parseTags(v);
    return { index, d: (tags.d || "").toLowerCase(), s: (tags.s || "").toLowerCase(), tags };
  });
}

/** The domain of the From address. */
export function fromDomain(fields) {
  const f = fields.find(([n]) => fieldName(n) === "from");
  const m = f && /@([A-Za-z0-9.-]+)\s*>?\s*$/.exec(f[1].replace(/\r\n/g, " ").trim());
  return m ? m[1].toLowerCase().replace(/\.$/, "") : "";
}

/** Lacre's alignment: d= equal to the From domain, or the From domain a subdomain of d=. */
export const aligned = (d, from) => !!d && (from === d || from.endsWith("." + d));

/** The first signature aligned with the From, the one the store's emails are attested with (Resend signs with
 *  the store's domain and with amazonses.com; only the store's counts). */
export function alignedSignature(raw) {
  const fields = parseHeaders(split(raw).head);
  const from = fromDomain(fields);
  const sig = signatures(fields).find((x) => aligned(x.d, from));
  return sig ? { domain: sig.d, selector: sig.s, from } : { domain: "", selector: "", from };
}

/** headers_blob.build: the signature for d=/s= and the fields it signs, in the message's order, CRLF. */
export function headersBlob(raw, domain, selector) {
  const fields = parseHeaders(split(raw).head);
  const d = domain.trim().toLowerCase().replace(/\.$/, ""), s = selector.trim().toLowerCase().replace(/\.$/, "");
  const sig = signatures(fields).find((x) => x.d === d && x.s === s);
  if (!sig) throw new Error(`no DKIM-Signature with d=${d} and s=${s}`);
  const names = (sig.tags.h || "").split(":").filter((x) => x.trim());
  if (!names.length) throw new Error("the signature has an empty h= tag");
  const pool = {};
  fields.forEach(([n], i) => { if (i !== sig.index) (pool[fieldName(n)] ||= []).push(i); });
  const chosen = new Set([sig.index]);
  for (const n of names) { const f = pool[n.trim().toLowerCase()]; if (f && f.length) chosen.add(f.pop()); }
  const blob = [...chosen].sort((a, b) => a - b).map((i) => fields[i][0] + ":" + fields[i][1] + "\r\n").join("");
  if (blob.length > 16384) throw new Error("the blob is over the 16384 bytes attest_inline takes");
  return blob;
}

// ---- the judge's text (gateway _tx) -----------------------------------------------------------------------

const TAG = /<(?:!doctype|!--|html|head|body|div|span|table|tr|td|p|br|a|img|style|script|font|center|b|i|u|strong|em|h[1-6])[\s>/]/i;
const HID = /<(\w+)\b[^>]*\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLK = /<\/?(?:p|div|tr|table|h[1-6]|li|ul|ol|br|hr|td|th)\b[^>]*>/gi;
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xa0" };

const utf8 = (latin) => new TextDecoder("utf-8").decode(Uint8Array.from(latin, (c) => c.charCodeAt(0) & 0xff));
// Python's str.splitlines boundaries
const LINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function html(t) {
  t = t.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, " ");
  let p = null;
  while (p !== t) { p = t; t = t.replace(HID, " "); }
  t = t.replace(BLK, "\n").replace(/<[^>]+>/g, " ");
  t = t.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (m, x) => {
    if (x[0] === "#") {
      const n = x[1] === "x" || x[1] === "X" ? parseInt(x.slice(2), 16) : parseInt(x.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[x] ?? m;
  });
  return t.split(LINES).map((y) => y.replace(/[ \t\xa0]+/g, " ").trim()).filter(Boolean).join("\n");
}

function qp(b) {
  return b.replace(/[ \t\r]+(?=\n)/g, "").replace(/=\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parts(s) {
  const m = /^--([^\r\n]{1,70}?)[ \t]*\r?$/m.exec(s);
  if (!m) return null;
  const d = "--" + m[1];
  const j = s.indexOf("\r\n" + d + "--", m.index);
  if (j < 0) return null;
  const out = [];
  for (let ch of s.slice(m.index + d.length, j).split("\r\n" + d)) {
    const n = ch.indexOf("\r\n");
    if (n < 0 || ch.slice(0, n).trim()) return null;
    ch = ch.slice(n + 2);
    let h, body;
    if (ch.startsWith("\r\n")) { h = ""; body = ch.slice(2); } else {
      const k = ch.indexOf("\r\n\r\n");
      [h, body] = k < 0 ? [ch, ""] : [ch.slice(0, k), ch.slice(k + 4)];
    }
    h = h.replace(/\r\n[ \t]+/g, " ").toLowerCase();
    const ty = /^content-type:[ \t]*([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)/m.exec(h);
    const te = (/^content-transfer-encoding:[ \t]*([a-z0-9-]+)/m.exec(h) || [, "7bit"])[1];
    let raw = body;
    if (te === "quoted-printable") raw = qp(raw);
    else if (te === "base64") {
      try { raw = atob(raw.replace(/\s/g, "")); } catch { return null; }
    }
    out.push([ty ? ty[1] : "text/plain", utf8(raw)]);
  }
  return out;
}

/** The text the gateway judge's committee reads from a body (latin-1 string), or null. */
export function judgeText(body) {
  const ps = parts(body) || [];
  for (const want of ["text/plain", "text/html"]) {
    for (const [ty, t] of ps) if (ty === want) return want === "text/plain" ? t.replace(/\r\n/g, "\n").trim() : html(t);
  }
  const t = utf8(body);
  return TAG.test(t) ? null : t.replace(/\r\n/g, "\n").trim();
}

/** What Tenet checks on a store email when it arrives (registration test and every order email). */
export function checkStoreEmail(raw) {
  const { head, body } = split(raw);
  const sig = alignedSignature(raw);
  const ps = parts(body);
  const out = { domain: sig.domain, selector: sig.selector, from: sig.from, body_bytes: body.length,
                multipart: !!ps, text_part: !!(ps && ps.some(([t]) => t === "text/plain")), problems: [] };
  if (!sig.domain) out.problems.push("no DKIM signature aligned with the From domain");
  if (body.length > MAX_BODY) out.problems.push(`the body is ${body.length} bytes, over the 12 KB the judge reads`);
  if (!out.multipart || !out.text_part) out.problems.push("not multipart with a text/plain part");
  out.ok = !out.problems.length && !!head;
  return out;
}
