// F1: the draft of a store's structure from its pasted refund policy, always with Llama 3.3 70B through
// OpenRouter, with the prompt F1 measured (f1-prompt.json, built from arbiter/policy_v2.py). A copy of
// policy_v2.build_prompt and policy_v2.structure, checked by worker/test/f1.test.mjs on the 21 policies
// and the 525 recorded readings of F1. The draft is only a draft: the store reviews and confirms every field.
import F1 from "./f1-prompt.json" with { type: "json" };
import { cj } from "../../tenet/worker/src/util.js";

const EVENTS = ["cancelled", "late", "not_as_described", "not_delivered", "out_of_stock"];
const ANCHORS = ["delivery", "promised", "purchase"];
const PRECONDITIONS = ["contact_seller", "seller_attempt_resolution"];
const SELLER_TYPES = ["any", "first_party", "third_party"];
const PAYMENTS = ["cash", "off_platform", "qr"];
const CAUSES = ["buyer_absent", "buyer_address", "customs", "force_majeure", "weather"];
// What the store has to look at before confirming (F1: the fields the model misses most).
export const REVIEW = ["preconditions", "excluded_causes"];

async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** policy_v2.build_prompt */
export async function buildPrompt(policy) {
  const text = [...String(policy).replace(/\r\n/g, "\n").replace(/\r/g, "\n")].slice(0, F1.max_policy).join("");
  const tag = (await sha256hex(text)).slice(0, 16);
  return F1.prompt.split("<<TAG>>").join(tag).split("<<POLICY>>").join(cj(text));
}

const int = (v, lo, hi) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error("int");
  return v;
};
const subset = (v, allowed) => {
  if (!Array.isArray(v) || v.some((x) => !allowed.includes(x))) throw new Error("subset");
  return [...new Set(v)].sort();
};

/** policy_v2.structure: the policy as read, normalized and validated, or null. */
export function structure(raw) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.clear !== "boolean") return null;
  if (raw.clear === false) return { clear: false };
  try {
    const rules = {};
    for (const r of raw.rules) {
      const event = r.event;
      if (!EVENTS.includes(event) || rules[event]) throw new Error("event");
      let waitDays = int(r.wait_days, 0, 90);
      const deadlineDays = int(r.deadline_days, 0, 365);
      let grace = event === "late" ? int(r.late_grace_days, 0, 60) : 0;
      if (event === "late" && r.wait_from === "promised") {
        grace = Math.max(grace, Math.min(waitDays, 60));
        waitDays = 0;
      }
      const waitFrom = waitDays ? r.wait_from : "none";
      const deadlineFrom = deadlineDays ? r.deadline_from : "none";
      if ((waitDays && !ANCHORS.includes(waitFrom)) || (deadlineDays && !ANCHORS.includes(deadlineFrom))) throw new Error("anchor");
      rules[event] = { event, wait_from: waitFrom, wait_days: waitDays, deadline_from: deadlineFrom, deadline_days: deadlineDays,
        late_grace_days: grace, refund_percent: int(r.refund_percent, 0, 100) };
    }
    if (!Object.keys(rules).length) throw new Error("rules");
    if (!["calendar", "business"].includes(raw.day_type) || !SELLER_TYPES.includes(raw.seller_types)) throw new Error("type");
    if (typeof raw.category_exclusions !== "boolean") throw new Error("categories");
    return { clear: true, rules: Object.keys(rules).sort().map((e) => rules[e]), day_type: raw.day_type,
      preconditions: subset(raw.preconditions, PRECONDITIONS), seller_wait_hours: int(raw.seller_wait_hours, 0, 720),
      seller_types: raw.seller_types, excluded_payments: subset(raw.excluded_payments, PAYMENTS),
      category_exclusions: raw.category_exclusions, excluded_causes: subset(raw.excluded_causes, CAUSES) };
  } catch {
    return null;
  }
}

/** policy_v2.canonical */
export function canonical(raw) {
  const s = structure(raw);
  return s === null ? null : s.clear === false ? "unclear" : cj(s);
}

/** What the gateway judges can judge (their _terms, M3): no preconditions, seller types, excluded payments,
 *  category exclusions or excluded causes. The reasons a confirmed structure cannot be registered. */
export function unsupported(s) {
  const out = [];
  if (!s || !s.clear) return ["the policy does not promise a fixed refund"];
  if (s.preconditions.length) out.push("preconditions (contacting the store first, or letting it resolve the problem first)");
  if (s.seller_types !== "any") out.push("terms that apply only to some sellers");
  if (s.excluded_payments.length) out.push("excluded payment methods");
  if (s.category_exclusions) out.push("excluded product categories");
  if (s.excluded_causes.length) out.push("excluded causes of delay");
  return out;
}

/** The draft: one reading of the fixed model. fetchImpl is fetch in the Worker, a stand-in in the rehearsal. */
export async function draft(policy, apiKey, fetchImpl = fetch) {
  const body = { model: F1.model, temperature: F1.temperature, max_tokens: F1.max_tokens,
    response_format: { type: "json_object" }, messages: [{ role: "user", content: await buildPrompt(policy) }] };
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify(body),
        headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" } });
      if (r.status === 200) {
        const d = await r.json();
        const text = d.choices?.[0]?.message?.content || "";
        return { structure: structure(text), model: F1.model, prompt_sha256: F1.prompt_sha256 };
      }
      last = "http " + r.status;
      if (![408, 429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) {
      last = String(e.message || e);
    }
  }
  return { structure: null, error: last, model: F1.model, prompt_sha256: F1.prompt_sha256 };
}
