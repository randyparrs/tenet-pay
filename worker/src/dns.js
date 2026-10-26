// DNS reads of the gateway: a store proves it owns its domain with a TXT record
// _tenet.<domain> = "tenet-merchant=<wallet>", read through Cloudflare and Google DNS over HTTPS, which have to
// agree, as Lacre's KeyCache does for DKIM keys. The same two reads give the size of the store's DKIM key
// (<selector>._domainkey.<domain>), whose minimum goes into the store's terms.
const RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

/** TXT strings of a name from one resolver: each record's strings joined, quotes removed. */
async function txtFrom(resolver, name, fetchImpl) {
  const r = await fetchImpl(`${resolver}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
  if (r.status !== 200) throw new Error(`${resolver}: http ${r.status}`);
  const d = await r.json();
  if (d.Status !== 0 && d.Status !== 3) throw new Error(`${resolver}: status ${d.Status}`);
  return (d.Answer || []).filter((a) => a.type === 16).map((a) => String(a.data).replace(/"\s*"/g, "").replace(/^"|"$/g, "")).sort();
}

/** The TXT strings of a name, only if both resolvers give the same ones; otherwise an error with both answers. */
export async function txt(name, fetchImpl = fetch) {
  const [a, b] = await Promise.all(RESOLVERS.map((r) => txtFrom(r, name, fetchImpl)));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`the two resolvers differ for ${name}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  return a;
}

/** The wallet a domain names in _tenet.<domain>, checked against the one the store gave. */
export async function checkOwner(domain, wallet, fetchImpl = fetch) {
  const name = `_tenet.${domain}`;
  const records = await txt(name, fetchImpl);
  const named = records.map((t) => /^tenet-merchant=(0x[0-9a-fA-F]{40})$/.exec(t.trim())).filter(Boolean).map((m) => m[1].toLowerCase());
  const ok = named.length === 1 && named[0] === wallet.toLowerCase();
  return { ok, name, records, reason: ok ? "" : named.length === 0 ? `no tenet-merchant record at ${name}`
    : named.length > 1 ? `more than one tenet-merchant record at ${name}` : `${name} names another wallet (${named[0]})` };
}

/** Bits of an RSA public key in DER SubjectPublicKeyInfo (the p= of a DKIM record). */
export function rsaBits(der) {
  let i = 0;
  const tlv = () => {
    const tag = der[i++];
    let len = der[i++];
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = len * 256 + der[i++]; }
    return { tag, start: i, len };
  };
  tlv(); // SubjectPublicKeyInfo
  const alg = tlv(); i = alg.start + alg.len;
  const bits = tlv(); i = bits.start + 1; // BIT STRING, skip the unused-bits byte
  tlv(); // RSAPublicKey
  const n = tlv();
  let s = n.start, len = n.len;
  while (len > 0 && der[s] === 0) { s++; len--; }
  return len ? (len - 1) * 8 + (32 - Math.clz32(der[s])) : 0;
}

/** The size of the store's DKIM key, read through both resolvers. */
export async function dkimBits(domain, selector, fetchImpl = fetch) {
  const recs = await txt(`${selector}._domainkey.${domain}`, fetchImpl);
  const t = recs.join("").replace(/\s+/g, "");
  const p = /(?:^|;)p=([A-Za-z0-9+/=]+)/.exec(t);
  if (!p) throw new Error(`no DKIM key at ${selector}._domainkey.${domain}`);
  return rsaBits(Uint8Array.from(atob(p[1]), (c) => c.charCodeAt(0)));
}
