// worker/src/f1.js against arbiter/policy_v2.py: the prompt of the 21 F1 policies (SHA-256) and the
// canonical structure of the 525 recorded F1 readings (data/local-f1.jsonl, every model).
//   node worker/test/f1.test.mjs
import { readFileSync } from "node:fs";
import { buildPrompt, canonical } from "../src/f1.js";

const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const V = JSON.parse(readFileSync(new URL("./f1-vectors.json", import.meta.url), "utf8"));
let p = 0;
for (const v of V) if ((await sha(await buildPrompt(v.policy))) === v.prompt_sha256) p++; else console.log("BAD prompt", v.id);
const rows = readFileSync(new URL("../../data/local-f1.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let c = 0;
for (const r of rows) {
  const got = r.ok ? canonical(r.raw) : null;
  if (got === (r.canonical ?? null)) c++; else console.log("BAD reading", r.pass, r.case, r.model, String(got).slice(0, 60), "/", String(r.canonical).slice(0, 60));
}
console.log(`f1.js: prompt ${p}/${V.length}, canonical ${c}/${rows.length}`);
process.exit(p === V.length && c === rows.length ? 0 : 1);
