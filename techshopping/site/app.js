/*
 * TechShopping (techshopping.site): the store's interface wired to its
 * own Worker: the catalog is store.json (the product descriptions are the ones Tenet keeps in each order), "Pay with
 * Tenet" creates the order through POST /api/buy and opens Tenet's checkout in a new window, and the order status
 * screen reads GET /api/orders/:orderId here and the order's public view on Tenet.
 *
 * Routes:
 *   #/                    Shop screen
 *   #/orders              Order status screen (last viewed order)
 *   #/orders/:orderId     Order status screen for one order
 */
(function () {
  'use strict';

  var TENET = ((document.querySelector('meta[name="tenet-gateway-api"]') || {}).content || '').replace(/\/$/, '');
  var CONFIG = { popupPlaceholderText: 'Opening Tenet checkout...' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var CLAIM_NAME = { late: 'arrived late', not_as_described: 'not as described', not_delivered: 'never arrived' };

  /* ---------- Data layer ---------- */
  function getJson(url, init) {
    return fetch(url, Object.assign({ cache: 'no-store' }, init || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) throw Object.assign(new Error(j.error || ('http ' + r.status)), { status: r.status });
        return j;
      });
    });
  }
  var Api = {
    // The catalog: store.json next to this page.
    loadStore: function () { return getJson('store.json'); },
    // POST /api/buy { product }  ->  { order, checkout_url }: the store creates the order on Tenet with its API key.
    createOrder: function (productId) {
      return getJson('/api/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: productId }) })
        .then(function (r) { return { orderId: r.order, checkoutUrl: r.checkout_url }; });
    },
    // GET /api/orders/:orderId here (what the store knows) and the order's public view on Tenet (claim, settlement).
    getOrder: function (orderId) {
      return getJson('/api/orders/' + encodeURIComponent(orderId)).then(function (s) {
        return getJson(TENET + '/api/orders/' + encodeURIComponent(orderId)).catch(function () { return null; }).then(function (t) { return toOrder(s, t); });
      }).catch(function (e) { if (e && e.status === 404) return null; throw e; });
    }
  };

  function fmtDay(day) {
    if (!day) return '';
    var d = new Date(day + 'T00:00:00Z');
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function fmtTime(seconds) {
    if (!seconds) return '';
    var d = new Date(Number(seconds) * 1000);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
  }
  function usdc(units) { return (Number(units) / 1e6).toFixed(2); }

  /** The design's order view from the store's record (s) and Tenet's public view of the order (t, may be null). */
  function toOrder(s, t) {
    var paid = !!s.paid_at, sent = s.sent || {}, dates = s.dates || {};
    var claim = t && t.claim, settled = t && t.settled;
    var label = 'Waiting for payment', tone = 'neutral';
    if (paid) {
      if (settled) {
        label = settled.refund > 0 ? 'Refunded ' + usdc(settled.refund) + ' USDC' : 'Closed, paid to the store';
        tone = settled.refund > 0 ? 'ok' : 'neutral';
      } else if (claim) { label = 'Claim: ' + (CLAIM_NAME[claim.event] || claim.event); tone = 'warn'; }
      else if (sent.delivered) { label = 'Delivered'; tone = 'ok'; }
      else if (sent.shipped) { label = 'Shipped'; tone = 'ok'; }
      else { label = 'Paid'; tone = 'ok'; }
    }
    var list = [
      { label: 'Ordered', value: fmtTime(s.created_at), note: '', tone: '' },
      { label: 'Paid', value: paid ? fmtTime(s.paid_at) : 'Not yet', note: paid ? 'via Tenet Pay' : '', tone: '' },
      { label: 'Estimated delivery', value: fmtDay(dates.promised), note: '', tone: '' }
    ];
    if (paid && s.product === 'case') list.push({ label: 'Delivered on', value: 'Never', note: 'test scenario', tone: 'warn' });
    else if (paid && dates.delivered) {
      var late = dates.delivered > dates.promised;
      list.push({ label: 'Delivered on', value: fmtDay(dates.delivered), note: sent.delivered ? (late ? 'one day late' : 'on time') : 'scheduled', tone: late ? 'warn' : '' });
    }
    var details = {
      confirmed: 'Estimated delivery: ' + dates.promised,
      shipped: 'Demo Post, tracking DP' + String(s.order).slice(3),
      delivered: 'delivered on ' + dates.delivered
    };
    var emails = (s.due || []).map(function (d) {
      var failed = s.mail_error && s.mail_error.kind === d.kind;
      return { subject: 'Order ' + s.order + ' ' + d.kind, detail: details[d.kind] || '',
        sentAt: sent[d.kind] ? fmtTime(sent[d.kind]) : failed ? 'retrying' : 'scheduled ' + fmtTime(d.at),
        state: sent[d.kind] ? 'sent' : failed ? 'retry' : 'none' };
    });
    var product = findById(state.products, s.product) || {};
    return { id: s.order, productId: s.product, quantity: 1, payment: paid ? 'paid' : 'unpaid', statusLabel: label, statusTone: tone,
      mailTo: s.email_to || '', dates: list, emails: emails, scenarioNote: product.scenarioNote || '', checkoutUrl: s.checkout_url || '' };
  }

  /* ---------- State ---------- */
  var state = { store: null, products: [], hero: [], lastOrderId: null, cards: {} };

  /* ---------- Helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function findById(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function fillTemplate(str, vals) { return String(str || '').replace(/\{(\w+)\}/g, function (_, k) { return vals[k] != null ? vals[k] : ''; }); }
  function cloneTemplate(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }

  function setField(root, name, value) {
    $all('[data-field="' + name + '"]', root).forEach(function (el) { el.textContent = value == null ? '' : value; });
  }

  // Inline SVGs come from <template> tags. Each copy gets unique ids so gradients keep working.
  var svgCopy = 0;
  function mountSvg(slot, templateId) {
    var tpl = document.getElementById(templateId);
    if (!slot || !tpl) return;
    svgCopy += 1;
    slot.innerHTML = tpl.innerHTML.replace(/\b(pa|tn)-/g, '$1' + svgCopy + '-');
  }
  function mountArt(tile, art) {
    tile.setAttribute('data-art', art);
    mountSvg($('.art-slot', tile), 'art-' + art);
  }
  function mountIcons(root) {
    $all('[data-icon="tenet"]', root).forEach(function (el) { mountSvg(el, 'icon-tenet'); });
  }

  /* ---------- Routing ---------- */
  function parseRoute() {
    var parts = (window.location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'orders') return { screen: 'order', orderId: parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : null };
    return { screen: 'shop' };
  }
  function navigate(hash) {
    if (window.location.hash === hash) onRoute();
    else window.location.hash = hash;
  }
  function showScreen(name) {
    $all('[data-screen]').forEach(function (el) { el.hidden = el.getAttribute('data-screen') !== name; });
    $all('[data-nav]').forEach(function (el) {
      if (el.getAttribute('data-nav') === name) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  }
  function onRoute() {
    var route = parseRoute();
    showScreen(route.screen);
    window.scrollTo(0, 0);
    if (route.screen === 'order') {
      var id = route.orderId || state.lastOrderId;
      $('#order-card').hidden = !id;
      if (id) loadOrder(id);
    }
  }

  /* ---------- Shop screen ---------- */
  function renderHero() {
    var grid = $('#hero-grid');
    grid.innerHTML = '';
    state.hero.forEach(function (item) {
      var tile = cloneTemplate('tpl-hero-tile');
      tile.id = 'hero-tile-' + item.productId;
      tile.setAttribute('data-product-id', item.productId);
      tile.setAttribute('data-sold-out', item.soldOut ? 'true' : 'false');
      setField(tile, 'label', item.soldOut || !item.priceLabel ? item.label : item.label + ' \u00B7 ' + item.priceLabel);
      mountArt(tile, item.art);
      grid.appendChild(tile);
    });
  }

  function renderProducts() {
    var list = $('#product-list');
    list.innerHTML = '';
    state.products.forEach(function (p) {
      var card = cloneTemplate('tpl-product-card');
      card.id = 'product-' + p.id;
      card.setAttribute('data-product-id', p.id);
      ['name', 'price', 'currency', 'scenario', 'description'].forEach(function (k) { setField(card, k, p[k]); });
      var specs = $('[data-list="specs"]', card);
      (p.specs || []).forEach(function (s) {
        var row = cloneTemplate('tpl-spec');
        setField(row, 'label', s.label);
        setField(row, 'value', s.value);
        specs.appendChild(row);
      });
      var btn = $('[data-action="pay"]', card);
      btn.id = 'pay-' + p.id;
      btn.setAttribute('data-product-id', p.id);
      mountArt($('.product-card__media', card), p.art);
      mountIcons(card);
      list.appendChild(card);
    });
  }

  // Card states: idle, busy. Only the button changes; what happened goes to the floating notice, so the card keeps its size.
  function setCardState(productId, cardState) {
    var card = document.getElementById('product-' + productId);
    if (!card) return;
    state.cards[productId] = cardState;
    card.setAttribute('data-state', cardState);
    var btn = $('[data-action="pay"]', card);
    btn.disabled = false;
    btn.setAttribute('aria-busy', cardState === 'busy' ? 'true' : 'false');
  }

  // Floating notice, one at a time: opened (checkout in a new window), blocked (the browser blocked it), failed.
  function showNotice(kind, info) {
    var toast = $('#shop-toast'), text = $('#shop-toast-text'), link = $('#shop-toast-link');
    var order = info && info.orderId;
    toast.setAttribute('data-kind', kind);
    toast.setAttribute('data-tone', kind === 'opened' ? 'ok' : 'warn');
    $('#shop-toast-title').textContent = kind === 'opened' ? 'Checkout opened in a new window'
      : kind === 'blocked' ? 'Your browser blocked the new window' : 'Could not create your order';
    text.innerHTML = '';
    if (order) {
      var id = document.createElement('span');
      id.className = 'mono';
      id.textContent = order;
      text.appendChild(document.createTextNode(kind === 'opened' ? 'Order ' : 'Your order '));
      text.appendChild(id);
      text.appendChild(document.createTextNode(kind === 'opened' ? '. Not seeing it?' : ' is ready. Open the checkout with this link.'));
    } else {
      text.textContent = 'Nothing was charged. Try again in a moment.';
    }
    link.hidden = !order;
    link.setAttribute('href', (info && info.checkoutUrl) || '#');
    toast.hidden = false;
  }
  function closeNotice() { $('#shop-toast').hidden = true; }

  function writePopupPlaceholder(win) {
    try {
      win.document.title = 'Tenet Pay';
      win.document.body.style.cssText = 'margin:0;background:#0D1310;color:#93A29A;font:14px sans-serif;display:grid;place-items:center;height:100vh';
      win.document.body.textContent = CONFIG.popupPlaceholderText;
    } catch (e) { /* cross origin or closed */ }
  }

  function onPay(productId) {
    if (state.cards[productId] === 'busy') return;
    // Open the window synchronously on click so the browser does not block it.
    var win = null;
    try { win = window.open('', '_blank'); } catch (e) { win = null; }
    if (win) {
      writePopupPlaceholder(win);
      // The checkout must not reach back into the store's page.
      try { win.opener = null; } catch (e) { /* ignore */ }
    }
    setCardState(productId, 'busy');

    Api.createOrder(productId).then(function (res) {
      state.lastOrderId = res.orderId;
      if (win && !win.closed) {
        try { win.location.href = res.checkoutUrl; } catch (e) { /* ignore */ }
        showNotice('opened', res);
      } else {
        showNotice('blocked', res);
      }
      setCardState(productId, 'idle');
    }).catch(function (err) {
      if (win && !win.closed) win.close();
      setCardState(productId, 'idle');
      showNotice('failed');
      console.error('createOrder failed', err);
    });
  }

  /* ---------- Order screen ---------- */
  function loadOrder(orderId) {
    $('#order-lookup-input').value = orderId;
    return Api.getOrder(orderId).then(function (order) {
      if (!order) { $('#order-card').hidden = true; return; }
      $('#order-card').hidden = false;
      state.lastOrderId = order.id;
      renderOrder(order);
    }).catch(function (err) { console.error('getOrder failed', err); });
  }

  function renderOrder(order) {
    var card = $('#order-card');
    var product = findById(state.products, order.productId) || {};
    var currency = product.currency || (state.store && state.store.currency) || '';
    card.setAttribute('data-order-id', order.id);
    card.setAttribute('data-payment', order.payment === 'unpaid' ? 'unpaid' : 'paid');

    setField(card, 'order.path', '/orders/' + order.id);
    setField(card, 'product.name', product.name);
    setField(card, 'order.priceLine', product.price + ' ' + currency + ' \u00B7 Qty ' + (order.quantity || 1));
    setField(card, 'order.statusLabel', order.statusLabel);
    setField(card, 'order.mailTo', order.mailTo);
    setField(card, 'order.scenarioNote', order.scenarioNote);
    $('#order-status-pill').setAttribute('data-tone', order.statusTone || 'neutral');
    mountArt($('#order-art'), product.art || 'buds');

    $('#order-pay-link').setAttribute('href', order.checkoutUrl || fillTemplate(state.store.checkoutUrlTemplate, { orderId: order.id }));
    $('#order-claim-link').setAttribute('href', fillTemplate(state.store.claimUrlTemplate, { orderId: order.id }));
    $('#order-scenario').hidden = !order.scenarioNote;

    var dates = $('#order-dates');
    dates.innerHTML = '';
    (order.dates || []).forEach(function (d, i) {
      var el = cloneTemplate('tpl-order-date');
      el.setAttribute('data-index', i);
      el.setAttribute('data-tone', d.tone || '');
      setField(el, 'label', d.label);
      setField(el, 'value', d.value);
      setField(el, 'note', d.note);
      dates.appendChild(el);
    });

    var ICONS = { sent: 'ok', retry: '!', none: '-' };
    var emails = $('#order-emails');
    emails.innerHTML = '';
    (order.emails || []).forEach(function (m, i) {
      var el = cloneTemplate('tpl-order-email');
      el.setAttribute('data-index', i);
      el.setAttribute('data-state', m.state);
      setField(el, 'icon', ICONS[m.state] || '-');
      setField(el, 'subject', m.subject);
      setField(el, 'detail', m.detail);
      setField(el, 'sentAt', m.sentAt);
      emails.appendChild(el);
    });
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    document.addEventListener('click', function (e) {
      var payBtn = e.target.closest('[data-action="pay"]');
      if (payBtn) { onPay(payBtn.getAttribute('data-product-id')); return; }

      if (e.target.closest('[data-action="close-toast"]')) { closeNotice(); return; }

      var scrollLink = e.target.closest('[data-scroll-target]');
      if (scrollLink) {
        e.preventDefault();
        var targetId = scrollLink.getAttribute('data-scroll-target');
        if (targetId === 'about') { var about = document.getElementById('about'); if (about) window.scrollTo({ top: about.offsetTop, behavior: 'smooth' }); return; }
        if (parseRoute().screen !== 'shop') navigate('#/');
        requestAnimationFrame(function () {
          var target = document.getElementById(targetId);
          if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.pageYOffset - 80, behavior: 'smooth' });
        });
        return;
      }

      var shopLink = e.target.closest('[data-action="go-shop"]');
      if (shopLink) { e.preventDefault(); navigate('#/'); }
    });

    $('#order-lookup-input').addEventListener('input', function (e) {
      var pos = e.target.selectionStart;
      e.target.value = e.target.value.toUpperCase();
      e.target.setSelectionRange(pos, pos);
    });

    $('#order-lookup-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var id = $('#order-lookup-input').value.trim().toUpperCase();
      if (!id) return;
      Api.getOrder(id).then(function (order) {
        if (order) navigate('#/orders/' + encodeURIComponent(order.id));
      });
    });

    window.addEventListener('hashchange', onRoute);
  }

  /* ---------- Boot ---------- */
  function init() {
    bindEvents();
    mountIcons(document.getElementById('screen-order'));
    Api.loadStore().then(function (d) {
      state.store = d.store;
      state.hero = d.hero || [];
      state.products = d.products || [];
      renderHero();
      renderProducts();
      onRoute();
    }).catch(function (err) {
      console.error('Could not load store.json', err);
    });
  }

  window.TechShopping = { state: state, onRoute: onRoute, toOrder: toOrder };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
