/*
 * Tenet Pay for stores (merchants.paytenet.site): the stores' interface on the
 * gateway Worker and the store's wallet. The store is the wallet that registers it: the page reads the store of the
 * connected wallet (GET /api/stores/<wallet>) and everything that changes state is signed in that wallet. Shared logic
 * (Worker, Arc reads, wallet, transactions, terms text and hash) comes from tenet.js and terms.js, the same files as
 * paytenet.site (build_site.py copies them).
 *
 * Routes:
 *   #/register            Registration (default)
 *   #/orders              Orders panel, first order selected
 *   #/orders/:orderId     Orders panel with one order selected
 *   #/balance             Balance
 *   #/terms               Signed terms
 * Orders, Balance and Terms show a locked screen until the store is active.
 *
 * Registration stages (set on #app as data-reg):
 *   nostore, txt, txtfail, policy, drafting, draft, test, testfail,
 *   key, key_pending, judges, escrow, failed, active
 */
import { ARC, CHAIN_ID, SEL, get, post, call, word, withBytes, cj, wallet, sendTx, waitReceipt, cancelled, utf8Hex, renderTerms, termsHash, escrowTermsHash, shortAddr, when, txUrl } from "./tenet.js";

var CONFIG = {
  delays: { copyReset: 1500, afterConfirm: 1400 },
  pollEvery: 15000,
  readEvery: 4000,
  readTries: 45,
  policyMax: 6000,
  responseMax: 1000,
  lowCountdownSeconds: 60,
  activationSeconds: 4500,
  actionsThatNeedYou: ['respond', 'send_readable_email', 'refund']
};
var LINKS = { buyerCheckout: 'https://paytenet.site' };
var NETWORK = { name: ARC.chainName, chainId: String(CHAIN_ID) };
// Stages the Worker moves on its own: the page reads the store again while it sits in one of them.
var MOVING = ['test', 'testfail', 'key', 'key_pending', 'judges', 'escrow', 'active'];
var RULE_NAME = { late: 'Late delivery', not_as_described: 'Not as described', not_delivered: 'Not delivered', cancelled: 'Cancelled order', out_of_stock: 'Out of stock' };
var PRECONDITION = { contact_seller: 'contact the store first', seller_attempt_resolution: 'the store resolves it first' };
var PAYMENT = { cash: 'cash', off_platform: 'payment outside the platform', qr: 'QR code' };
var CLAIM_NAME = { late: 'late', not_as_described: 'not as described', not_delivered: 'never arrived', cancelled: 'cancelled', out_of_stock: 'out of stock' };
var PROOF_NAME = { label: 'label', model_number: 'model number', serial_number: 'serial number' };
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Arc transactions open Arc's explorer; the judge's and Lacre's (GenLayer) open Bradbury's.
function txHref(hash, net) { return net && net !== 'arc' ? 'https://explorer-bradbury.genlayer.com/tx/' + hash : txUrl(hash); }

/* ---------- Data and chain layer ---------- */
var Api = {
  // GET /api/config: the escrow's answer and proof windows as text (the terms text uses them).
  loadConfig: function () { return get('/api/config'); },
  // GET /api/stores/<wallet>: the store of this wallet, or null when it has none yet.
  loadMerchant: function (address) {
    return get('/api/stores/' + address).then(function (v) { return toData(v); }, function (e) {
      if (e && e.status === 404) return toData(null);
      throw e;
    });
  },
  // POST /api/stores { domain, wallet }: the store starts with its TXT record to publish.
  startRegistration: function (domain) { return post('/api/stores', { domain: domain, wallet: wallet.address }).then(toData); },
  // POST /api/stores/<wallet>/txt: Tenet looks the TXT record up through two resolvers.
  checkTxt: function () { return post('/api/stores/' + wallet.address + '/txt', {}).then(toData); },
  // POST /api/stores/<wallet>/draft { policy }: the fixed model's draft of the structure, to check and edit.
  draftTerms: function (policy) { return post('/api/stores/' + wallet.address + '/draft', { policy: policy }); },
  // The registration message (EIP-191) signed by the store's wallet, then POST /api/stores/<wallet>/confirm. The API key
  // and the webhook secret come back once.
  confirm: function (payload, onSigned) {
    var address = wallet.address;
    return post('/api/stores/' + address + '/message', { payload: payload }).then(function (r) {
      return wallet.provider().request({ method: 'personal_sign', params: ['0x' + utf8Hex(r.message), address] });
    }).then(function (signature) {
      onSigned();
      return post('/api/stores/' + address + '/confirm', { payload: payload, signature: signature });
    });
  },
  // claimable(store, USDC) on the escrow: what was released to the store and is not withdrawn yet (units of 6 decimals).
  claimable: function (address) {
    return call(state.config.escrow, '0x' + SEL.claimable + word(address) + word(state.config.usdc)).then(function (h) { return BigInt(h || '0x0'); });
  },
  // One action of the store: an answer on an order (submit), a refund of a payment that matches no order
  // (merchantRefund), "I sent a readable email" (Tenet reads the order's address again), or the withdrawal of its whole
  // balance (withdraw). onRegistered(txShort) when the wallet has sent the transaction; resolves when Tenet has read it
  // (for the withdrawal, when the escrow shows nothing left). Rejects with { code: 'rejected' } on cancel.
  sign: function (action, payload, onRegistered) {
    var address = wallet.address;
    var order = findById(state.data.orders, payload.orderId), raw = order && order.raw;
    if (!raw && action !== 'withdraw') return Promise.reject(new Error('The order is no longer in the list.'));
    var merchant = raw ? raw.merchant : state.data.raw && state.data.raw.merchant;
    if (merchant && address.toLowerCase() !== merchant) return Promise.reject(new Error('Connect the store wallet ' + shortAddr(merchant) + ' to act on its orders.'));
    var data, read;
    if (action === 'response') {
      var kind = order.responseKind;
      data = withBytes(SEL.submit, raw.ref, cj({ party: 'merchant', kind: kind, content: payload.text }));
      read = function (o) { return o && (o.submissions || []).some(function (x) { return x.party === 'merchant' && x.kind === kind; }); };
    } else if (action === 'refund') {
      data = '0x' + SEL.merchantRefund + word(raw.ref);
      read = function (o) { return o && !!o.settled; };
    } else if (action === 'readable') {
      var before = (raw.mails || []).length;
      return readUntil(raw.order, function (o) { return o && (o.mails || []).length > before && o.mails[o.mails.length - 1].readable !== false; }, 1)
        .then(function (ok) { if (!ok) throw new Error('No new readable email at ' + order.orderAddress + ' yet. Send it and try again.'); return {}; });
    } else if (action === 'withdraw') {
      data = '0x' + SEL.withdraw + word(state.config.usdc);
      return sendTx(state.config.escrow, data).then(function (hash) {
        onRegistered(shortTx(hash), hash);
        return waitReceipt(hash).then(function () { return Api.claimable(address); }).then(function (units) {
          if (units > 0n) throw new Error('The escrow still shows a balance for this wallet. Check the transaction and try again.');
          return { txShort: shortTx(hash), hash: hash };
        });
      }).catch(function (e) { throw cancelled(e) ? { code: 'rejected' } : e; });
    } else {
      return Promise.reject(new Error('Not available yet.'));
    }
    return sendTx(state.config.escrow, data).then(function (hash) {
      onRegistered(shortTx(hash), hash);
      return waitReceipt(hash).then(function () { return readUntil(raw.order, read, CONFIG.readTries); }).then(function () { return { txShort: shortTx(hash), hash: hash }; });
    }).catch(function (e) { throw cancelled(e) ? { code: 'rejected' } : e; });
  }
};

/** Reads the order from the store's view until cond(order) holds (Tenet has read the chain); false after tries. */
function readUntil(n, cond, tries) {
  var i = 0;
  function round() {
    return get('/api/stores/' + wallet.address).then(function (v) {
      var o = (v.orders || []).filter(function (x) { return x.order === n; })[0];
      if (cond(o)) return true;
      if (++i >= tries) return false;
      return new Promise(function (r) { setTimeout(r, CONFIG.readEvery); }).then(round);
    });
  }
  return round();
}

/** The Worker's state of a store as the design's registration stage. */
function stageOf(v) {
  if (!v) return 'nostore';
  if (v.state === 'started') {
    if (!v.txt.check) return 'txt';
    if (!v.txt.check.ok) return 'txtfail';
    return v.draft && v.draft.structure && v.draft.structure.clear ? 'draft' : 'policy';
  }
  if (v.state === 'test_email') return v.test && v.test.ok === false ? 'testfail' : 'test';
  return v.state;
}

function sentence(t) { t = String(t || ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }

function shortTx(h) { return h ? h.slice(0, 6) + '\u2026' + h.slice(-4) : ''; }
function usdc(units) { return (Number(units || 0) / 1e6).toFixed(2); }
function day(seconds) {
  if (!seconds) return '';
  var d = new Date(Number(seconds) * 1000);
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

/** What the buyer wrote in the claim, as one quote for the store. */
function claimQuote(c) {
  if (!c) return '';
  var parts = [];
  if (c.account) parts.push(c.account);
  if (c.promised) parts.push('Promised: ' + c.promised + '.');
  if (c.received) parts.push('Received: ' + c.received + '.');
  if (c.proof) parts.push('Proof (' + (PROOF_NAME[c.proof_kind] || c.proof_kind || 'proof') + '): ' + c.proof + '.');
  if (c.promised_date) parts.push('Promised date: ' + c.promised_date + '.');
  if (c.delivered_date) parts.push('Delivered: ' + c.delivered_date + '.');
  return parts.join(' ');
}

/** One order of the store's view (orderView, role store) as the design's order. */
function toOrder(o, x) {
  var next = o.next || {}, w = o.windows_seconds || {}, now = nowSeconds();
  var claimWords = o.claim ? CLAIM_NAME[o.claim.event] || String(o.claim.event).replace(/_/g, ' ') : '';
  var out = { id: o.order, label: o.unexpected && /^unknown-/.test(o.order) ? shortTx(o.ref) : o.order, raw: o,
    amount: usdc(o.amount_cents * 1e4), paidAt: o.paid_at ? day(o.paid_at) : 'Not paid', action: 'none', tone: 'green', statusLabel: 'Paid',
    events: (o.events || []).map(function (e) {
      return { time: day(e.at), what: e.what, tx: e.tx ? shortTx(e.tx) : '', href: e.tx ? txHref(e.tx, e.net) : '',
        tone: /settled|attested|final: refund/i.test(e.what) ? 'ok' : /unexpected|ignored|unreadable|not provided|over 12 KB/i.test(e.what) ? 'bad' : 'neutral' };
    }) };
  if (!o.paid) { out.action = 'unpaid'; out.tone = 'neutral'; out.statusLabel = 'Not paid'; out.waitText = 'Not paid yet. Tenet notifies your webhook when the buyer pays.'; return out; }
  if (o.settled) {
    out.action = 'settled'; out.tone = 'neutral'; out.statusLabel = 'Settled';
    out.refunded = usdc(o.settled.refund); out.released = usdc(o.settled.released);
    var final = (o.steps || []).map(function (st) { return st.final; }).filter(Boolean).pop();
    out.result = o.unexpected ? 'Refunded in full: it matched no order' : !o.claim ? 'Hold ended, no claim'
      : sentence(claimWords) + ', ' + (o.settled.refund > 0 ? Math.round(o.settled.refund / (o.settled.refund + o.settled.released) * 100) + '% refund' : 'no refund') + (final && final.reason ? ' (' + final.reason + ')' : '');
    return out;
  }
  if (o.unexpected) {
    out.action = 'refund'; out.tone = 'red'; out.statusLabel = 'Unexpected payment';
    out.issueTitle = 'This payment matches no order';
    out.issueText = out.amount + ' USDC arrived from ' + shortAddr(o.buyer) + ' on ' + day(o.paid_at) + ' UTC: ' + o.unexpected + '. Refund it so the buyer gets the money back.';
    out.refundAmount = out.amount; out.refundTo = shortAddr(o.buyer);
    return out;
  }
  if (o.claim) { out.tone = 'amber'; out.statusLabel = 'Claim: ' + claimWords; }
  if (next.action === 'respond') {
    out.action = 'respond'; out.responseKind = next.kind; out.responseMax = next.max || CONFIG.responseMax;
    var closingAt = ((o.submissions || []).filter(function (x) { return x.kind === 'closing_open'; })[0] || {}).at;
    var until = next.until || (closingAt ? closingAt + (w.closing || 0) : 0);
    out.windowSecondsLeft = until ? until - now : 0;
    if (next.kind === 'closing_response') {
      var last = (o.submissions || []).filter(function (x) { return x.party === 'buyer' && /proof/.test(x.kind || ''); }).pop();
      var c = last && last.content;
      out.quoteLabel = 'Buyer, latest proof';
      out.quote = c && typeof c === 'object' ? 'Proof (' + (PROOF_NAME[c.proof_kind] || c.proof_kind) + '): ' + c.proof : String(c || '');
      out.responseTitle = 'Closing answer to the buyer\'s last proof';
    } else {
      out.quoteLabel = 'Buyer, what happened';
      out.quote = claimQuote(o.claim_content);
      out.responseTitle = 'Answer the claim';
    }
  } else if (next.action === 'send_readable_email') {
    out.action = 'send_readable_email';
    out.windowSecondsLeft = next.until ? next.until - now : 0;
    out.issueTitle = 'The judge could not read your store email';
    out.issueText = next.text;
    out.orderAddress = o.mail_to || '';
  } else if (o.claim) {
    out.action = 'wait';
    out.waitText = o.proof_requested_at ? 'The judge asked the buyer for proof. Nothing to do now.' : 'The claim is with the judge. Nothing to do now.';
  }
  return out;
}

function balanceOf(orders, units) {
  var sources = [], left = units;
  orders.filter(function (o) { return o.raw.settled && o.raw.settled.released > 0; })
    .sort(function (a, b) { return b.raw.settled.at - a.raw.settled.at; })
    .forEach(function (o) {
      if (left <= 0n) return;
      var r = o.raw, released = BigInt(r.settled.released);
      sources.push({ orderId: o.label, amount: usdc(r.settled.released),
        why: !r.claim ? 'hold ended' : r.settled.refund > 0 ? claimWords(r.claim.event) + ' verdict, ' + Math.round(r.settled.released / (r.settled.released + r.settled.refund) * 100) + '% to you' : claimWords(r.claim.event) + ' claim denied' });
      left -= released;
    });
  var held = orders.filter(function (o) { return o.raw.paid && !o.raw.settled && !o.raw.unexpected; });
  return { claimable: usdc(units), units: units, sources: sources, heldOrders: held.length,
    heldAmount: usdc(held.reduce(function (n, o) { return n + o.raw.amount_cents * 1e4; }, 0)) };
}
function claimWords(event) { return CLAIM_NAME[event] || String(event || '').replace(/_/g, ' '); }

/** The design's data model from the Worker's store view (null: this wallet has no store). */
function toData(v) {
  var x = v || {}, st = x.stages || {};
  return {
    raw: v,
    store: { name: x.domain || '', domain: x.domain || '', termsHash: x.terms ? x.terms.terms_hash : '' },
    registration: {
      stage: stageOf(v),
      txt: { name: x.txt ? x.txt.name : '', value: x.txt ? x.txt.value : '', checkedAt: x.txt && x.txt.check ? when(x.txt.check.at) : '',
        reason: x.txt && x.txt.check ? x.txt.check.reason || '' : '' },
      confirmedAt: x.confirmed_at ? when(x.confirmed_at) : '',
      testEmail: { address: x.test_address || '', lastReceivedAt: x.test && x.test.at ? when(x.test.at) : '',
        failures: (x.test && !x.test.ok && x.test.problems) || [] },
      // The stage times exist for stores registered from 2026-10-23; older ones show no times.
      activation: st.key ? { startAt: st.key } : null,
      failure: sentence(x.failure),
      failedAt: st.failed ? when(st.failed) : '',
      activatedAt: x.active_since ? when(x.active_since) : '',
      activationMinutes: st.key && x.active_since ? String(Math.max(1, Math.round((x.active_since - st.key) / 60))) : ''
    },
    draft: x.state === 'started' && x.draft && x.draft.structure && x.draft.structure.clear ? x.draft.structure : null,
    termsText: x.terms ? x.terms.text : '',
    holdDays: x.terms ? String(x.terms.hold_days) : '',
    orders: (x.orders || []).slice().reverse().map(function (o) { return toOrder(o, x); }),
    balance: { claimable: '0.00', units: 0n, sources: [], heldOrders: 0, heldAmount: '0.00' }
  };
}

/* ---------- State ---------- */
var state = {
  config: null,
  data: toData(null),
  status: 'loading',
  wallet: 'disconnected',
  walletInfo: null,
  menu: null,
  stage: 'nostore',
  view: 'register',
  selId: null,
  busy: false,
  regError: '',
  tick: 0,
  ordersLoadTick: 0,
  domain: '',
  policy: '',
  structure: null,
  form: null,
  rules: [],
  review: { pre: '', excl: '', other: '' },
  creds: null,
  sign: {},
  signTx: {},
  signHash: {},
  withdrawn: null,
  orderError: '',
  responses: {},
  credsHidden: false,
  copied: null
};

/* ---------- Helpers ---------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function fillTemplate(str, vals) { return String(str || '').replace(/\{(\w+)\}/g, function (_, k) { return vals[k] != null ? vals[k] : ''; }); }
function getPath(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
function cloneTemplate(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }
function findById(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
function mmss(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function setValue(el, v) { if (el && document.activeElement !== el && el.value !== String(v == null ? '' : v)) el.value = v == null ? '' : v; }
function whole(v, lo, hi) { var n = Number(v); return String(v).trim() !== '' && Number.isInteger(n) && n >= lo && n <= hi; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }

var svgCopy = 0;
function mountSvg(slot, templateId) {
  var tpl = document.getElementById(templateId);
  if (!slot || !tpl) return;
  svgCopy += 1;
  slot.innerHTML = tpl.innerHTML.replace(/\b(tn)-/g, '$1' + svgCopy + '-');
}

/* ---------- Derived values ---------- */
var STEP_OF = { nostore: 0, txt: 0, txtfail: 0, policy: 1, drafting: 1, draft: 1, test: 2, testfail: 2, key: 3, key_pending: 3, judges: 3, escrow: 3, failed: 3, active: 4 };
var STEP_CURRENT_SUB = { nostore: 'Enter your domain', txt: 'Add the TXT record', txtfail: 'TXT not found', policy: 'Paste your policy', drafting: 'Drafting', draft: 'Review and sign', test: 'Waiting for email', testfail: 'Last test failed', key: 'Pending', key_pending: 'Pending', judges: 'Pending', escrow: 'Almost done', failed: 'Failed' };
var ACTIVATION_ORDER = ['key', 'key_pending', 'judges', 'escrow'];
var ACTIVATION_GROUPS = { dkim: [0, 1], judges: [2], escrow: [3] };

/** What the draft read that the judges cannot apply yet, as text the store has to clear before signing. */
function reviewOf(s) {
  var other = [];
  if (s.seller_types !== 'any') other.push('only ' + s.seller_types.replace(/_/g, ' ') + ' sellers');
  if (s.excluded_payments.length) other.push('payments by ' + s.excluded_payments.map(function (p) { return PAYMENT[p] || p; }).join(', '));
  if (s.category_exclusions) other.push('some product categories');
  return {
    pre: s.preconditions.map(function (p) { return PRECONDITION[p] || p; }).join('; '),
    excl: s.excluded_causes.map(function (c) { return c.replace(/_/g, ' '); }).join('; '),
    other: other.join('; ')
  };
}

/** The structure the store confirms, from the draft and the form, in the form the Worker accepts (f1.js structure()). */
function structureFromForm() {
  var s = JSON.parse(JSON.stringify(state.structure));
  var f = state.form || {};
  s.day_type = f.dayType === 'business' ? 'business' : 'calendar';
  s.rules = s.rules.map(function (r, i) {
    var e = state.rules[i] || {};
    var out = { event: r.event, wait_from: r.wait_from, wait_days: Number(e.wait) || 0, deadline_from: r.deadline_from,
      deadline_days: Number(e.claim) || 0, late_grace_days: r.event === 'late' ? Number(e.grace) || 0 : 0, refund_percent: Number(e.refund) || 0 };
    // Days added to a rule that had none count from the usual anchor; 0 days has no anchor.
    if (out.wait_days && out.wait_from === 'none') out.wait_from = r.event === 'late' || r.event === 'not_delivered' ? 'promised' : 'delivery';
    if (out.event === 'late' && out.wait_from === 'promised') { out.late_grace_days = Math.max(out.late_grace_days, Math.min(out.wait_days, 60)); out.wait_days = 0; }
    if (!out.wait_days) out.wait_from = 'none';
    if (out.deadline_days && out.deadline_from === 'none') out.deadline_from = r.event === 'not_delivered' ? 'purchase' : 'delivery';
    if (!out.deadline_days) out.deadline_from = 'none';
    return out;
  });
  if (!state.review.pre.trim()) { s.preconditions = []; s.seller_wait_hours = 0; }
  if (!state.review.excl.trim()) s.excluded_causes = [];
  if (!state.review.other.trim()) { s.seller_types = 'any'; s.excluded_payments = []; s.category_exclusions = false; }
  return s;
}

function formError() {
  var f = state.form || {};
  for (var i = 0; i < state.rules.length; i++) {
    var r = state.rules[i];
    if (!whole(r.refund, 0, 100) || !whole(r.wait, 0, 90) || !whole(r.claim, 0, 365) || (r.key === 'late' && !whole(r.grace, 0, 60))) {
      return r.name + ': whole numbers only (refund 0 to 100, wait 0 to 90, claim 0 to 365' + (r.key === 'late' ? ', grace 0 to 60' : '') + ').';
    }
  }
  var promised = String(f.promised || ''), delivered = String(f.delivered || '');
  if (!promised.trim() || promised.length > 40) return 'The promised date label is required, up to 40 characters.';
  if (delivered.length > 40) return 'The delivery date label is up to 40 characters.';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,7}$/.test(f.prefix || '')) return 'The order prefix starts with a letter: up to 8 letters, digits or dashes.';
  if (!whole(f.digits, 4, 10)) return 'Order digits must be between 4 and 10.';
  if (!whole(f.hold, 7, 180)) return 'Hold days must be between 7 and 180.';
  if (!/^https:\/\/\S+$/.test(String(f.webhook || '').trim())) return 'The webhook URL must start with https://';
  if (state.review.pre.trim() || state.review.excl.trim() || state.review.other.trim()) return 'Clear preconditions, excluded causes and other limits before signing.';
  return '';
}

// The terms text always comes from terms.js: while drafting, rendered from the structure being edited; once signed, the
// Worker's render of the registered structure.
function termsText() {
  if (state.stage === 'draft' && state.structure && state.config) {
    return renderTerms(structureFromForm(), Number((state.form || {}).hold) || 30, state.config.windows_text);
  }
  return state.data.termsText || '';
}

function orderExample() {
  var f = state.form || {}, d = Math.min(10, Math.max(1, Number(f.digits) || 1));
  return (f.prefix || '') + '1'.padStart(d, '0');
}

function selectedOrder() {
  var orders = state.data.orders || [];
  return findById(orders, state.selId) || orders[0] || null;
}
function answerKey(order) { return order.id + (order.responseKind ? ':' + order.responseKind : ''); }
function actionSignKey(order) {
  if (!order) return null;
  if (order.action === 'respond') return 'response:' + answerKey(order);
  if (order.action === 'send_readable_email') return 'readable:' + order.id;
  if (order.action === 'refund') return 'refund:' + order.id;
  return null;
}
function orderNeedsYou(order) {
  if (CONFIG.actionsThatNeedYou.indexOf(order.action) === -1) return false;
  return state.sign[actionSignKey(order)] !== 'done';
}
function countdownFor(order) {
  var remain = (order.windowSecondsLeft || 0) - (state.tick - state.ordersLoadTick);
  var signed = !!state.sign[actionSignKey(order)];
  var closed = remain <= 0 && !signed;
  var label = signed ? 'Answered' : closed ? 'Window closed' : mmss(remain) + ' left';
  var tone = signed ? 'answered' : closed ? 'closed' : remain < CONFIG.lowCountdownSeconds ? 'low' : 'ok';
  return { remain: remain, closed: closed, label: label, tone: tone };
}

function viewModel() {
  var d = state.data;
  var sel = selectedOrder() || {};
  var withdrawn = state.sign.withdraw === 'done';
  var w = state.walletInfo || { address: '', addressShort: '', balance: '' };
  var flagged = !!(state.review.pre.trim() || state.review.excl.trim() || state.review.other.trim());
  var reg = Object.assign({}, d.registration, { credentials: state.creds || { apiKey: '', webhookSecret: '', shownAt: '' } });
  return {
    links: LINKS, network: NETWORK,
    wallet: { address: w.address, addressShort: w.addressShort, balance: w.balance, gasBalance: w.balance },
    store: { name: d.store.name, domain: state.domain, termsHash: d.store.termsHash, holdDays: d.holdDays, escrowHash: d.escrowHash || '' },
    registration: reg,
    balance: d.balance,
    sel: sel,
    ui: {
      storeLabel: state.domain || 'New store',
      walletMessage: wallet.message,
      regError: state.regError,
      orderError: state.orderError,
      policyCount: state.policy.length,
      orderExample: orderExample(),
      formError: formError(),
      termsText: termsText(),
      conditionsFlag: flagged ? 'Review: must stay empty for now. The judges cannot apply preconditions or excluded causes yet.' : 'Review: must stay empty for now.',
      elapsed: mmss(activationElapsed()),
      needCount: d.orders.filter(function (o) { return CONFIG.actionsThatNeedYou.indexOf(o.action) !== -1; }).length,
      claimable: withdrawn ? '0.00' : d.balance.claimable,
      responseCount: (state.responses[answerKey(sel)] || '').length,
      responseMax: sel.responseMax || CONFIG.responseMax
    }
  };
}

function activationElapsed() {
  var a = state.data.registration.activation;
  return a ? Math.max(0, nowSeconds() - a.startAt) : 0;
}

/* ---------- Rendering ---------- */
function fillFields(vm) {
  $all('[data-field]').forEach(function (el) {
    if (el.closest('[data-list]')) return;
    var v = getPath(vm, el.getAttribute('data-field'));
    el.textContent = v == null ? '' : v;
  });
  $all('[data-field-href]').forEach(function (el) {
    var v = getPath(vm, el.getAttribute('data-field-href'));
    el.setAttribute('href', v || '#');
  });
}

function matchList(attr, value) { return attr.split(/\s+/).indexOf(value) !== -1; }
function flagValue(name) {
  var reg = state.data.registration;
  switch (name) {
    case 'busy': return state.busy;
    case 'credsHidden': return state.credsHidden || !state.creds;
    case 'walletMessage': return !!wallet.message;
    case 'regError': return !!state.regError;
    case 'orderError': return !!state.orderError;
    case 'otherLimits': return !!state.review.other;
    case 'elapsedKnown': return !!reg.activation;
    case 'activationTime': return !!reg.activationMinutes;
    case 'failedAtKnown': return !!reg.failedAt;
    case 'noOrders': return !state.data.orders.length;
    case 'termsChecking': return !state.data.termsCheck || state.data.termsCheck === 'checking';
    case 'termsOk': return state.data.termsCheck === 'ok';
    case 'termsBad': return state.data.termsCheck === 'bad';
    case 'termsUnknown': return state.data.termsCheck === 'unknown';
    default: return false;
  }
}
function matchFlag(attr) { var neg = attr.charAt(0) === '!'; var on = !!flagValue(neg ? attr.slice(1) : attr); return neg ? !on : on; }
function applyVisibility() {
  var sel = selectedOrder();
  var action = sel ? (sel.action || 'none') : 'none';
  $all('[data-visible-reg], [data-visible-action], [data-visible-flag], [data-visible-wallet], [data-visible-status]').forEach(function (el) {
    var r = el.getAttribute('data-visible-reg');
    var a = el.getAttribute('data-visible-action');
    var f = el.getAttribute('data-visible-flag');
    var w = el.getAttribute('data-visible-wallet');
    var st = el.getAttribute('data-visible-status');
    el.hidden = !((!r || matchList(r, state.stage)) && (!a || matchList(a, action)) && (!f || matchFlag(f))
      && (!w || matchList(w, state.wallet)) && (!st || matchList(st, state.status)));
  });
  $all('[data-menu]').forEach(function (m) { m.hidden = m.getAttribute('data-menu') !== state.menu; });
  $('#menu-backdrop').hidden = !state.menu;
}

function renderScreens() {
  var active = state.stage === 'active';
  var target = state.view === 'register' ? 'register' : active ? state.view : 'locked';
  $all('[data-screen]').forEach(function (el) { el.hidden = el.getAttribute('data-screen') !== target; });
  var cur = STEP_OF[state.stage] != null ? STEP_OF[state.stage] : 0;
  $all('[data-nav]').forEach(function (el) {
    var k = el.getAttribute('data-nav');
    var locked = k !== 'register' && !active;
    if (k === state.view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    el.setAttribute('data-locked', locked ? 'true' : 'false');
    el.setAttribute('data-active-store', active ? 'true' : 'false');
  });
  $('[data-nav-meta="register"]').textContent = active ? 'Active' : Math.min(cur + 1, 4) + '/4';
  $('[data-nav-meta="orders"]').textContent = active ? String(viewModel().ui.needCount) : '';
}

function renderSteps() {
  var wrap = $('#reg-steps');
  var cur = STEP_OF[state.stage] != null ? STEP_OF[state.stage] : 0;
  var active = state.stage === 'active';
  var defs = [['Prove the domain', state.domain], ['Confirm the terms', 'Signed, no gas'], ['Send a test email', 'DKIM verified'], ['Activation', 'Active']];
  wrap.innerHTML = '';
  defs.forEach(function (def, i) {
    var step = cloneTemplate('tpl-step');
    var done = i < cur || active, current = i === cur && !active;
    var st = done ? 'done' : current ? (state.stage === 'failed' ? 'failed' : 'current') : 'todo';
    step.setAttribute('data-step', String(i + 1));
    step.setAttribute('data-step-state', st);
    $('.step__n', step).textContent = String(i + 1);
    $('.step__title', step).textContent = def[0];
    $('.step__sub', step).textContent = done ? def[1] : current ? STEP_CURRENT_SUB[state.stage] : 'Locked';
    wrap.appendChild(step);
  });
}

function renderRuleEditors() {
  var wrap = $('#rule-editors');
  wrap.innerHTML = '';
  state.rules.forEach(function (r, i) {
    var card = cloneTemplate('tpl-rule-editor');
    card.setAttribute('data-rule-key', r.key);
    card.setAttribute('data-rule-index', String(i));
    $('.rule-editor__name', card).textContent = r.name;
    $('.rule-editor__key', card).textContent = r.key;
    $all('[data-rule-field]', card).forEach(function (input) {
      var f = input.getAttribute('data-rule-field');
      input.id = 'r' + i + '-' + f;
      input.name = 'rules[' + i + '][' + f + ']';
      input.value = r[f] != null ? r[f] : '';
    });
    wrap.appendChild(card);
  });
}

function renderForm() {
  var f = state.form || {};
  setValue($('#f-domain'), state.domain);
  setValue($('#f-policy'), state.policy);
  $('#policy-counter').setAttribute('data-near-limit', state.policy.length > CONFIG.policyMax - 300 ? 'true' : 'false');
  $all('[data-form-field]').forEach(function (el) { setValue(el, f[el.getAttribute('data-form-field')]); });
  $all('[data-day-type]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-day-type') === f.dayType ? 'true' : 'false'); });
  $all('[data-review-field]').forEach(function (el) {
    var k = el.getAttribute('data-review-field');
    setValue(el, state.review[k]);
    el.classList.toggle('is-invalid', !!String(state.review[k]).trim());
  });
  $('#store-conditions').setAttribute('data-flagged', state.review.pre.trim() || state.review.excl.trim() || state.review.other.trim() ? 'true' : 'false');
  $('#f-hold-days').classList.toggle('is-invalid', !whole(f.hold, 7, 180));
  $('#f-order-digits').classList.toggle('is-invalid', !whole(f.digits, 4, 10));
  $('#f-order-prefix').classList.toggle('is-invalid', !/^[A-Za-z][A-Za-z0-9-]{0,7}$/.test(f.prefix || ''));
  $('#f-webhook-url').classList.toggle('is-invalid', !/^https:\/\/\S+$/.test(String(f.webhook || '').trim()));
  $all('.rule-editor').forEach(function (card) {
    var r = state.rules[Number(card.getAttribute('data-rule-index'))] || {};
    var lim = { refund: 100, wait: 90, claim: 365, grace: 60 };
    $all('[data-rule-field]', card).forEach(function (input) { var k = input.getAttribute('data-rule-field'); input.classList.toggle('is-invalid', !whole(r[k], 0, lim[k])); });
  });
}

function renderTest() {
  var list = $('#test-fail-list');
  list.innerHTML = '';
  (state.data.registration.testEmail.failures || []).forEach(function (t) {
    var item = cloneTemplate('tpl-fail-item');
    $('.fail-item__text', item).textContent = t;
    list.appendChild(item);
  });
}

function renderActivation() {
  var a = state.data.registration.activation;
  $('#activation-progress').style.width = a ? Math.min(98, activationElapsed() / CONFIG.activationSeconds * 100).toFixed(1) + '%' : '0%';
  var ai = ACTIVATION_ORDER.indexOf(state.stage);
  $all('[data-stage]').forEach(function (row) {
    var idx = ACTIVATION_GROUPS[row.getAttribute('data-stage')];
    var done = ai > Math.max.apply(null, idx), current = idx.indexOf(ai) !== -1;
    row.setAttribute('data-stage-state', done ? 'done' : current ? 'current' : 'todo');
    $('.stage__meta', row).textContent = done ? 'done' : row.getAttribute('data-stage-meta');
  });
}

function renderOrders() {
  var sel = selectedOrder();
  var list = $('#orders-list');
  list.innerHTML = '';
  state.data.orders.forEach(function (o) {
    var row = cloneTemplate('tpl-order-row');
    row.id = 'order-row-' + o.id;
    row.setAttribute('data-order-id', o.id);
    row.setAttribute('aria-pressed', sel && sel.id === o.id ? 'true' : 'false');
    row.setAttribute('data-needs', orderNeedsYou(o) ? 'true' : 'false');
    $('.orders-row__id-text', row).textContent = o.label;
    $('.orders-row__amount', row).textContent = o.amount;
    var chip = $('.orders-row__chip', row);
    chip.textContent = o.statusLabel;
    chip.setAttribute('data-tone', o.tone);
    $('.orders-row__paid', row).textContent = o.paidAt;
    list.appendChild(row);
  });
  if (!sel) return;
  $('#order-detail').setAttribute('data-order-id', sel.id);
  $('#order-detail-chip').setAttribute('data-tone', sel.tone);

  var cd = countdownFor(sel);
  $all('[data-countdown]').forEach(function (el) { el.textContent = cd.label; el.setAttribute('data-cd', cd.tone); });

  var ta = $('#f-response');
  ta.setAttribute('maxlength', String(sel.responseMax || CONFIG.responseMax));
  setValue(ta, state.responses[answerKey(sel)] || '');
  ta.disabled = !!state.sign['response:' + answerKey(sel)] || cd.closed;
  $('#response-counter').setAttribute('data-near-limit', (state.responses[answerKey(sel)] || '').length > CONFIG.responseMax - 50 ? 'true' : 'false');

  var tl = $('#order-timeline');
  tl.innerHTML = '';
  (sel.events || []).slice(-6).forEach(function (e) {
    var ev = cloneTemplate('tpl-event');
    ev.setAttribute('data-tone', e.tone || 'neutral');
    $('.event__t', ev).textContent = e.time;
    $('.event__what', ev).textContent = e.what;
    var tx = $('.event__tx', ev);
    tx.textContent = e.tx || '';
    if (e.href) tx.setAttribute('href', e.href); else tx.removeAttribute('href');
    tl.appendChild(ev);
  });
}

function renderBalance() {
  var wrap = $('#balance-sources');
  wrap.innerHTML = '';
  wrap.setAttribute('data-withdrawn', state.sign.withdraw === 'done' ? 'true' : 'false');
  state.data.balance.sources.forEach(function (s) {
    var row = cloneTemplate('tpl-source');
    $('.source__id', row).textContent = s.orderId;
    $('.source__why', row).textContent = s.why;
    $('.source__amt', row).textContent = s.amount;
    wrap.appendChild(row);
  });
}

var SIGN_COPY = {
  message: { wallet: 'Sign the message in your wallet', reg: 'Signed. Sending to Tenet', walletSub: 'A message signature. No gas.', regSub: 'Signature sent. Tenet is checking it.' },
  tx: { wallet: 'Confirm in your wallet', reg: 'Waiting for Tenet to read it', walletSub: 'A transaction on Arc. Only gas is charged.', regSub: 'Registered on Arc, waiting for Tenet to read it \u00b7 tx {tx}' }
};
function signKeyFor(btn) {
  var base = btn.getAttribute('data-sign');
  if (btn.getAttribute('data-sign-scope') === 'order') { var o = selectedOrder(); return o ? base + ':' + (base === 'response' ? answerKey(o) : o.id) : base; }
  return base;
}
function signContext() {
  var d = state.data, sel = selectedOrder() || {}, cd = sel.id ? countdownFor(sel) : { closed: false };
  var text = (state.responses[answerKey(sel)] || '').trim();
  var fe = formError();
  return {
    vars: {
      walletShort: state.walletInfo ? state.walletInfo.addressShort : '', confirmedAt: d.registration.confirmedAt, formError: fe,
      responseSendLabel: sel.responseKind === 'closing_response' ? 'Send the closing answer' : 'Send the answer',
      responseDisabledSub: cd.closed ? 'The window closed. The judge decides with what it has.' : 'Write your answer first.',
      refundAmount: sel.refundAmount, refundTo: sel.refundTo,
      claimableBefore: state.withdrawn || d.balance.claimable, withdrawTxShort: state.signTx.withdraw || ''
    },
    disabled: { confirm: !!fe, response: cd.closed || !text, readable: cd.closed, refund: false, withdraw: !(d.balance.units > 0n) }
  };
}
function renderSignButtons() {
  var ctx = signContext();
  $all('.sign-btn').forEach(function (btn) {
    var base = btn.getAttribute('data-sign');
    var key = signKeyFor(btn);
    var type = btn.getAttribute('data-sign-type') === 'message' ? 'message' : 'tx';
    var st = state.sign[key];
    var view = st || (ctx.disabled[base] ? 'disabled' : 'idle');
    var vars = Object.assign({ tx: state.signTx[key] || '' }, ctx.vars);
    var copy = SIGN_COPY[type];
    var label = view === 'wallet' ? copy.wallet : view === 'reg' ? copy.reg : view === 'done' ? btn.getAttribute('data-label-done') : btn.getAttribute('data-label-idle');
    var sub = view === 'disabled' ? btn.getAttribute('data-sub-disabled') : view === 'wallet' ? copy.walletSub : view === 'reg' ? copy.regSub : view === 'done' ? btn.getAttribute('data-sub-done') : btn.getAttribute('data-sub-idle');
    btn.setAttribute('data-sign-key', key);
    btn.setAttribute('data-sign-state', view);
    btn.disabled = view === 'disabled';
    btn.setAttribute('aria-busy', view === 'wallet' || view === 'reg' ? 'true' : 'false');
    $('.sign-btn__label', btn).textContent = fillTemplate(label, vars);
    var subEl = $('[data-sign-sub="' + base + '"]');
    if (subEl) { subEl.textContent = fillTemplate(sub, vars); subEl.setAttribute('data-sign-state', view); }
  });
}

function renderCopyLabels() {
  $all('[data-copy-key]').forEach(function (btn) {
    $('[data-copy-label]', btn).textContent = state.copied === btn.getAttribute('data-copy-key') ? 'Copied' : 'Copy';
  });
}

function render() {
  var app = $('#app');
  app.setAttribute('data-view', state.view);
  app.setAttribute('data-reg', state.stage);
  app.setAttribute('data-wallet', state.wallet);
  app.setAttribute('data-status', state.status);
  fillFields(viewModel());
  renderScreens();
  renderSteps();
  renderForm();
  renderActivation();
  renderOrders();
  renderBalance();
  renderSignButtons();
  renderCopyLabels();
  applyVisibility();
}

/* ---------- Stage changes ---------- */
function setStage(stage) {
  state.stage = stage;
  state.busy = false;
  if (stage === 'draft') renderRuleEditors();
  render();
}

/** A new reading of the store from the Worker: its stage, and what each stage shows. */
function readBalance() {
  if (state.stage !== 'active' || !state.config || state.wallet !== 'connected') return Promise.resolve();
  var address = wallet.address, d = state.data;
  return Api.claimable(address).then(function (units) {
    if (wallet.address !== address || state.data !== d) return;
    // A new release after a withdrawal: the button is ready again.
    if (state.sign.withdraw === 'done' && units > 0n) { delete state.sign.withdraw; state.withdrawn = null; }
    d.balance = balanceOf(d.orders, units);
    render();
  }, function () { /* the next reading tries again */ });
}

function checkTerms() {
  var d = state.data, t = d.raw && d.raw.terms;
  if (state.stage !== 'active' || !t || !state.config) return Promise.resolve();
  if (d.termsCheck) return Promise.resolve();
  d.termsCheck = 'checking';
  return Promise.all([termsHash(t.structure, t.hold_days, state.config.windows_text), escrowTermsHash(state.config.escrow, d.raw.merchant)]).then(function (r) {
    if (state.data !== d) return;
    var own = r[0], onChain = r[1];
    d.termsText = renderTerms(t.structure, t.hold_days, state.config.windows_text);
    d.termsCheck = !onChain ? 'unknown' : own === t.terms_hash && own === onChain ? 'ok' : 'bad';
    d.store.termsHash = own;
    d.escrowHash = onChain || '';
    render();
  }, function () { if (state.data === d) { d.termsCheck = 'unknown'; render(); } });
}

function applyData(d) {
  var keepDraft = state.stage === 'draft' && d.registration.stage === 'draft' && state.structure;
  var was = state.data, wt = was.raw && was.raw.terms, nt = d.raw && d.raw.terms;
  // The same registered terms as the last reading: their check stands (no new reads of Arc every 15 s).
  if (was.termsCheck && was.termsCheck !== 'checking' && wt && nt && wt.terms_hash === nt.terms_hash && was.raw.merchant === d.raw.merchant) {
    d.termsCheck = was.termsCheck; d.termsText = was.termsText; d.escrowHash = was.escrowHash; d.store.termsHash = was.store.termsHash;
  }
  state.data = d;
  state.domain = d.store.domain || state.domain;
  if (d.draft && !keepDraft) applyDraft(d.draft);
  if (!findById(d.orders, state.selId)) state.selId = d.orders.length ? d.orders[0].id : null;
  state.ordersLoadTick = state.tick;
  renderTest();
  if (keepDraft) render();
  else setStage(d.registration.stage);
  readBalance();
  checkTerms();
}

function withBusy(promise) {
  state.busy = true;
  state.regError = '';
  render();
  return promise.then(function (d) { state.busy = false; applyData(d); }, function (err) {
    state.busy = false;
    state.regError = sentence(err && err.message) || 'Tenet did not answer.';
    render();
  });
}

function startRegistration() { if (!state.busy) withBusy(Api.startRegistration(state.domain)); }
function checkTxt() { if (!state.busy) withBusy(Api.checkTxt()); }
function checkStore() { if (!state.busy) withBusy(Api.loadMerchant(wallet.address)); }
function draftTerms() {
  if (state.busy) return;
  state.regError = '';
  setStage('drafting');
  Api.draftTerms(state.policy).then(function (r) {
    if (!r.draft || !r.draft.clear) throw new Error(r.error || 'The draft could not read a fixed refund in this policy. Check the text, or write the terms more plainly.');
    applyDraft(r.draft);
    setStage('draft');
  }).catch(function (err) {
    state.regError = sentence(err && err.message) || 'Tenet did not answer.';
    setStage('policy');
  });
}

function applyDraft(structure) {
  state.structure = JSON.parse(JSON.stringify(structure));
  state.rules = structure.rules.map(function (r) {
    return { key: r.event, name: RULE_NAME[r.event] || r.event, refund: r.refund_percent, wait: r.wait_days, claim: r.deadline_days, grace: r.late_grace_days };
  });
  state.review = reviewOf(structure);
  state.form = state.form || { dayType: structure.day_type, promised: 'Estimated delivery:', delivered: 'delivered on', prefix: '', digits: 6, hold: 30, webhook: '' };
  state.form.dayType = structure.day_type;
}

function confirmPayload() {
  var f = state.form;
  return { structure: structureFromForm(), promised_label: f.promised, delivery_label: f.delivered, order_prefix: f.prefix,
    order_digits: Number(f.digits), hold_days: Number(f.hold), webhook_url: String(f.webhook).trim() };
}

function runSign(btn) {
  var base = btn.getAttribute('data-sign');
  var key = signKeyFor(btn);
  if (state.sign[key] || btn.getAttribute('data-sign-state') === 'disabled') return;
  if (base === 'withdraw') state.withdrawn = state.data.balance.claimable;
  if (base !== 'confirm') { signOrder(base, key); return; }
  state.sign[key] = 'wallet';
  state.regError = '';
  render();
  Api.confirm(confirmPayload(), function () { state.sign[key] = 'reg'; render(); }).then(function (r) {
    state.sign[key] = 'done';
    state.creds = { apiKey: r.api_key, webhookSecret: r.webhook_secret, shownAt: when(nowSeconds()) };
    state.credsHidden = false;
    var d = toData(r);
    state.data.registration.confirmedAt = d.registration.confirmedAt;
    render();
    setTimeout(function () { state.structure = null; applyData(d); }, CONFIG.delays.afterConfirm);
  }).catch(function (err) {
    delete state.sign[key];
    if (!cancelled(err)) state.regError = sentence(err && err.message) || 'Tenet did not answer.';
    render();
  });
}

function signOrder(base, key) {
  var sel = selectedOrder() || {};
  if (!sel.id && base !== 'withdraw') return;
  state.sign[key] = base === 'readable' ? 'reg' : 'wallet';
  state.orderError = '';
  render();
  Api.sign(base, { orderId: sel.id, text: (state.responses[answerKey(sel)] || '').trim() }, function (txShort, hash) {
    state.sign[key] = 'reg';
    state.signTx[key] = txShort;
    state.signHash[key] = hash;
    render();
  }).then(function (res) {
    state.sign[key] = 'done';
    if (res && res.txShort) state.signTx[key] = res.txShort;
    render();
    return Api.loadMerchant(wallet.address).then(function (d) { if (state.sign[key] === 'done') applyData(d); });
  }).catch(function (err) {
    delete state.sign[key];
    if (base === 'withdraw') state.withdrawn = null;
    if (!(err && err.code === 'rejected')) state.orderError = sentence(err && err.message) || 'Tenet did not answer.';
    render();
  });
}

function copyValue(btn) {
  var text = getPath(viewModel(), btn.getAttribute('data-copy-field'));
  try { navigator.clipboard.writeText(text || '').catch(function () {}); } catch (e) { /* ignore */ }
  state.copied = btn.getAttribute('data-copy-key');
  render();
  setTimeout(function () { state.copied = null; render(); }, CONFIG.delays.copyReset);
}

/* ---------- The store of the connected wallet ---------- */
function loadStore() {
  if (state.wallet !== 'connected') return Promise.resolve();
  var address = wallet.address;
  state.status = 'loading';
  render();
  return Api.loadMerchant(address).then(function (d) {
    if (wallet.address !== address) return;
    state.status = 'ready';
    applyData(d);
  }, function (e) {
    if (wallet.address !== address) return;
    state.status = 'down';
    render();
    console.error('Could not load the store', e);
  });
}

// While the Worker moves the store on its own (test email, activation), read it again now and then.
function poll() {
  if (state.status !== 'ready' || state.busy || MOVING.indexOf(state.stage) === -1 || state.wallet !== 'connected') return;
  // Not while the store signs or Tenet reads what it signed: the button keeps its state until it is done.
  if (Object.keys(state.sign).some(function (k) { return state.sign[k] === 'wallet' || state.sign[k] === 'reg'; })) return;
  var address = wallet.address;
  Api.loadMerchant(address).then(function (d) {
    if (wallet.address === address && !state.busy && d.registration.stage !== 'nostore') applyData(d);
  }, function () { /* the next round tries again */ });
}

/* ---------- Routing ---------- */
function parseRoute() {
  var parts = (window.location.hash || '#/register').replace(/^#\/?/, '').split('/').filter(Boolean);
  var view = ['register', 'orders', 'balance', 'terms'].indexOf(parts[0]) !== -1 ? parts[0] : 'register';
  return { view: view, orderId: view === 'orders' && parts[1] ? decodeURIComponent(parts[1]) : null };
}
function onRoute() {
  var r = parseRoute();
  if (r.view !== state.view) window.scrollTo(0, 0);
  state.view = r.view;
  if (r.orderId) state.selId = r.orderId;
  render();
}

/* ---------- Wallet ---------- */
function syncWallet() {
  state.wallet = wallet.status;
  state.walletInfo = wallet.address ? { address: wallet.address, addressShort: shortAddr(wallet.address),
    balance: wallet.balance == null ? '...' : wallet.balance.toFixed(2) } : null;
}

/* ---------- Events ---------- */
function bindEvents() {
  document.addEventListener('click', function (e) {
    var row = e.target.closest('.orders-row--item');
    if (row) { window.location.hash = '#/orders/' + encodeURIComponent(row.getAttribute('data-order-id')); return; }
    var el = e.target.closest('[data-action]');
    if (!el) return;
    switch (el.getAttribute('data-action')) {
      case 'open-menu': wallet.message = ''; state.menu = el.getAttribute('data-menu-target'); render(); break;
      case 'close-menu': state.menu = null; render(); break;
      case 'choose-wallet': state.menu = null; wallet.connectBrowser(); break;
      case 'disconnect': state.menu = null; wallet.disconnect(); break;
      case 'switch-network': state.menu = null; wallet.switchNetwork(); break;
      case 'retry-load': loadStore(); break;
      case 'start-registration': startRegistration(); break;
      case 'check-txt': checkTxt(); break;
      case 'draft-terms': draftTerms(); break;
      case 'check-test': checkStore(); break;
      case 'check-activation': checkStore(); break;
      // The credentials leave the page for good: Tenet keeps only the API key's hash.
      case 'hide-credentials': state.credsHidden = true; state.creds = { apiKey: '', webhookSecret: '', shownAt: state.creds ? state.creds.shownAt : '' }; render(); break;
      case 'set-day-type': if (state.form) { state.form.dayType = el.getAttribute('data-day-type'); render(); } break;
      case 'copy': copyValue(el); break;
      case 'sign': runSign(el); break;
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'f-domain') state.domain = t.value.trim();
    else if (t.id === 'f-policy') state.policy = t.value.slice(0, CONFIG.policyMax);
    else if (t.id === 'f-response') { var sel = selectedOrder(); if (sel) state.responses[answerKey(sel)] = t.value.slice(0, sel.responseMax || CONFIG.responseMax); }
    else if (t.hasAttribute('data-form-field') && state.form) state.form[t.getAttribute('data-form-field')] = t.value;
    else if (t.hasAttribute('data-review-field')) state.review[t.getAttribute('data-review-field')] = t.value;
    else if (t.hasAttribute('data-rule-field')) {
      var card = t.closest('.rule-editor');
      var r = state.rules[Number(card.getAttribute('data-rule-index'))];
      if (r) r[t.getAttribute('data-rule-field')] = t.value;
    } else return;
    render();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.menu) { state.menu = null; render(); }
  });
  window.addEventListener('hashchange', onRoute);

  wallet.onChange(function () {
    var was = state.wallet, addr = state.walletInfo && state.walletInfo.address;
    syncWallet();
    // Without a wallet, or with another account, nothing of the previous store stays on screen.
    if (state.wallet !== 'connected' || addr !== wallet.address) {
      state.data = toData(null); state.status = 'loading'; state.sign = {}; state.signTx = {}; state.creds = null;
      state.structure = null; state.form = null; state.rules = []; state.review = { pre: '', excl: '', other: '' };
      state.regError = ''; state.policy = ''; state.domain = '';
    }
    if (wallet.message) state.menu = state.menu || 'connect';
    render();
    if (state.wallet === 'connected' && (was !== 'connected' || addr !== wallet.address)) loadStore();
  });
}

/* ---------- Boot ---------- */
function init() {
  $all('[data-icon="tenet"]').forEach(function (el) { mountSvg(el, 'icon-tenet'); });
  bindEvents();
  onRoute();
  setInterval(function () { state.tick += 1; if (state.status === 'ready') render(); }, 1000);
  setInterval(poll, CONFIG.pollEvery);
  Api.loadConfig().then(function (c) { state.config = c; render(); readBalance(); checkTerms(); }, function () { /* the terms preview waits for it */ });
  wallet.restore().catch(function () {}).then(function () {
    syncWallet();
    render();
    return loadStore();
  });
}

window.TenetMerchants = { state: state, render: render, onRoute: onRoute, toData: toData, structureFromForm: structureFromForm };
init();
