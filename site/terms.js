// Copied from worker/src/terms.js by build_site.py; do not edit here.
// The refund terms the buyer sees and accepts when paying, rendered from the store's confirmed structure:
// a copy of arbiter/terms.py render() that gives the same text byte for byte (checked by
// worker/test/terms.test.mjs against the Python module). Its SHA-256 is the hash the order keeps in the
// escrow, so the checkout page renders it from the structure in the browser and compares hashes.
// No dependencies: it runs in the Worker and in the page.

export const TERMS_VERSION = "terms-v1";
const EVENT = {
  not_delivered: "If the order never arrives",
  late: "If the order arrives more than {grace} {unit} after the promised delivery date",
  not_as_described: "If the item arrives damaged, defective, wrong or different from its description",
  cancelled: "If the order is cancelled",
  out_of_stock: "If the item is out of stock",
};
const ANCHOR = { purchase: "the purchase date", promised: "the promised delivery date", delivery: "the delivery date" };
const PAYMENT = { cash: "cash", off_platform: "payment outside the platform", qr: "QR code" };
const CAUSE = { buyer_absent: "the recipient not being available", buyer_address: "a wrong or incomplete address given by the buyer",
  customs: "customs", force_majeure: "events beyond the store's control", weather: "weather" };
const PROOF_NOT_PROVIDED_REASON = "proof not provided";
const NOT_PROVEN_REASON = "claim not proven";

const days = (n, dayType) => `${n} ${dayType === "business" ? "business day" : "day"}${n === 1 ? "" : "s"}`;
const join = (items) => (items.length === 1 ? items[0] : items.slice(0, -1).join(", ") + " and " + items[items.length - 1]);

/** Text of the terms. windows: the escrow's answer and proof windows as text (null: 72 hours and 7 days). */
export function render(structure, holdDays, windows = null) {
  const w = windows || { response: "72 hours", proof: "7 days" };
  const lines = [`Refund terms (${TERMS_VERSION})`, ""];
  if (!structure.clear) {
    lines.push("This store does not promise a fixed refund. The escrow does not hold this payment for claims.");
    return lines.join("\n") + "\n";
  }
  const dt = structure.day_type;
  lines.push("What is covered:");
  for (const r of structure.rules) {
    const unit = dt === "business" ? "business days" : "days";
    let s = EVENT[r.event].replace("{grace}", String(r.late_grace_days)).replace("{unit}", unit);
    s += `, you get a refund of ${r.refund_percent}% of the order total.`;
    if (r.wait_days) s += ` You can claim from ${days(r.wait_days, dt)} after ${ANCHOR[r.wait_from]}.`;
    if (r.deadline_days) s += ` You must claim within ${days(r.deadline_days, dt)} of ${ANCHOR[r.deadline_from]}.`;
    else s += " There is no deadline to claim.";
    lines.push("- " + s);
  }
  lines.push("", "Conditions:");
  const cond = [];
  if (structure.preconditions.includes("contact_seller")) {
    const wait = structure.seller_wait_hours;
    cond.push("You must contact the store first" + (wait ? ` and wait ${wait} hours for an answer.` : "."));
  }
  if (structure.preconditions.includes("seller_attempt_resolution")) cond.push("The store gets a chance to resolve the problem first.");
  if (structure.seller_types === "third_party") cond.push("These terms apply only to items sold by third-party sellers.");
  else if (structure.seller_types === "first_party") cond.push("These terms apply only to items sold by the store itself.");
  if (structure.excluded_payments.length) cond.push(`Payments made by ${join(structure.excluded_payments.map((p) => PAYMENT[p]))} are not covered.`);
  if (structure.category_exclusions) cond.push("Some product categories are excluded.");
  if (structure.excluded_causes.length) cond.push(`Delays caused by ${join(structure.excluded_causes.map((c) => CAUSE[c]))} are not covered.`);
  cond.push(`Days are counted as ${dt === "business" ? "business days" : "calendar days"}.`);
  for (const c of cond) lines.push("- " + c);
  lines.push(
    "",
    "How a claim is decided:",
    `- The payment is held in escrow for ${holdDays} days. A claim opened within that time freezes the payment until it is decided; a claim opened later is outside the escrow.`,
    "- A claim that the item is different from its description names what the description promised, what arrived, and, as proof, a label, a model number or a serial number that shows what arrived.",
    `- If the store does not answer a claim within ${w.response}, the claim is decided without its answer: a claim with that proof is refunded under these terms.`,
    `- If a claim needs proof, the buyer is asked once and has ${w.proof} to provide it. Without that proof, the claim is denied: ${PROOF_NOT_PROVIDED_REASON}.`,
    `- If the store disputes the claim with a specific fact, each side may add one more piece of proof, once. If the store then disputes it again with a fact, the claim is denied: ${NOT_PROVEN_REASON}. If the store admits it, the claim is refunded. If the store only denies it in general or does not answer, the claim is refunded when the buyer's proof is well formed.`,
    "- A claim with no agreement among the reviewers is not a denial and can be submitted again.",
  );
  return lines.join("\n") + "\n";
}

/** "0x" + SHA-256 hex of the text, as the escrow keeps it (WebCrypto: Workers, Node and browsers). */
export async function termsHash(structure, holdDays, windows = null) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(render(structure, holdDays, windows)));
  return "0x" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
