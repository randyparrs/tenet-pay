// CM14 base: the JS copy of the terms text (worker/src/terms.js) gives the same SHA-256 as arbiter/terms.py on
// every vector of make_terms_vectors.py, and the live test and Demo Shop terms hashes are the ones on chain.
//   node worker/test/terms.test.mjs
import { readFileSync } from "node:fs";
import { termsHash } from "../src/terms.js";

const vectors = JSON.parse(readFileSync(new URL("./terms-vectors.json", import.meta.url), "utf8"));
let bad = 0;
for (const v of vectors) if ((await termsHash(v.structure, v.hold, v.windows)) !== v.sha256) bad++;
const br = JSON.parse(readFileSync(new URL("../../tenet/cases/br-cases.json", import.meta.url), "utf8"));
const demo = JSON.parse(readFileSync(new URL("../../tenet/worker/src/demo-data.json", import.meta.url), "utf8"));
const live = (await termsHash(br.structure, 30)) === br.terms_hash;
const dm = (await termsHash(demo.terms.structure, demo.terms.hold_seconds / 86400, { response: "5 minutes", proof: "5 minutes" })) === demo.terms.terms_hash;
console.log(`terms.js = terms.py on ${vectors.length - bad} of ${vectors.length} vectors; live test terms hash ${live ? "ok" : "DIFFERENT"}; Demo Shop terms hash ${dm ? "ok" : "DIFFERENT"}`);
process.exit(bad || !live || !dm ? 1 : 0);
