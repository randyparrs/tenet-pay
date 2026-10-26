// worker/src/mime.js against the Python side (make_mime_vectors.py): the judge's text on the 32 emails of B4
// and the 5 of M1 (null where the judge gives I11), Lacre's blob of the 5 signed M1 emails, the aligned signature
// (techshopping.site / resend, not amazonses.com) and the arrival check (M1: 3 multipart pass; 2 text-only do not).
//   node worker/test/mime.test.mjs
import { readFileSync } from "node:fs";
import { split, judgeText, headersBlob, alignedSignature, checkStoreEmail } from "../src/mime.js";

const V = JSON.parse(readFileSync(new URL("./mime-vectors.json", import.meta.url), "utf8"));
let bad = 0;
const fail = (what) => { bad++; console.log("BAD", what); };
let texts = 0, blobs = 0, sigs = 0, checks = 0;
for (const v of V) {
  const got = judgeText(split(v.raw_latin1).body);
  if (got !== v.text) fail(`${v.id} text: ${JSON.stringify(got)?.slice(0, 80)} / ${JSON.stringify(v.text)?.slice(0, 80)}`); else texts++;
  if (v.blob !== null) {
    if (headersBlob(v.raw_latin1, "techshopping.site", "resend") !== v.blob) fail(`${v.id} blob`); else blobs++;
    const s = alignedSignature(v.raw_latin1);
    if (s.domain !== "techshopping.site" || s.selector !== "resend") fail(`${v.id} aligned signature ${s.domain}/${s.selector}`); else sigs++;
    const c = checkStoreEmail(v.raw_latin1);
    const multipart = v.raw_latin1.includes("multipart/alternative");
    if (c.ok !== multipart) fail(`${v.id} arrival check ${JSON.stringify(c)}`); else checks++;
  }
}
console.log(`mime.js: text ${texts}/${V.length}, Lacre blob ${blobs}/5, aligned signature ${sigs}/5, arrival check ${checks}/5`);
process.exit(bad ? 1 : 0);
