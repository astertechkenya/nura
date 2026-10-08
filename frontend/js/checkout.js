/* NURA checkout.js: the checkout page (Phase 4).

   The page sends who and where; the server decides what and how much. The summary on the
   right is drawn from GET /api/cart, and "Place order" sends only the form. Every amount on
   the confirmation comes back from the server.

   One random checkoutKey is made per visit to this page and sent with every attempt. If the
   answer to "Place order" gets lost (a phone losing signal), pressing again sends the same
   key, and the server hands back the order it already made instead of making a second one. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var byId = function (id) { return document.getElementById(id); };
  var form = byId('coForm');
  if (!form) return;

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^(?:\+?254|0)?[17]\d{8}$/;         // the same rule the server applies

  var cart = null, options = null, sending = false;
  var checkoutKey = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : fallbackUuid();
  function fallbackUuid() {                            // older Safari: build a v4 UUID from random bytes
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ── Summary ───────────────────────────────────────────────────────────────────── */
  function renderSummary() {
    var lines = byId('coLines');
    lines.innerHTML = cart.items.map(function (it) {
      var p = it.product, bg = esc(p.cardBg || '#efefed');
      return '<div class="co-line">'
        + '<div class="co-line__img" style="background:' + bg + '">'
        +   (p.imageUrl ? '<img src="' + esc(NURA.photo(p.imageUrl)) + '" alt="">' : '')
        +   '<span class="co-line__qty" aria-hidden="true">' + Number(it.qty) + '</span></div>'
        + '<div><p class="co-line__brand">' + esc(p.brand) + '</p>'
        +   '<p class="co-line__name">' + esc(p.name) + '</p>'
        +   '<p class="co-line__meta">' + (it.variant.size !== 'ONE SIZE' ? 'Size ' + esc(it.variant.size) + ' · ' : '') + 'Qty ' + Number(it.qty) + '</p>'
        +   (it.problem ? '<p class="co-line__problem">' + esc(it.problem) + '</p>' : '')
        +   '<button type="button" class="co-line__remove" data-action="co-remove" data-id="' + esc(it.id) + '">Remove<span class="sr-only"> ' + esc(p.name) + '</span></button>'
        + '</div>'
        + '<p class="co-line__price">' + (it.lineTotalKes ? NURA.fmtKsh(it.lineTotalKes) : '&mdash;') + '</p>'
        + '</div>';
    }).join('');
    byId('coSubtotal').textContent = NURA.fmtKsh(cart.subtotalKes);
    byId('coShipping').textContent = cart.shipping.feeKes ? NURA.fmtKsh(cart.shipping.feeKes) : 'Free';
    byId('coTotal').textContent = NURA.fmtKsh(cart.totalKes);
    byId('coSummaryTotal').textContent = NURA.fmtKsh(cart.totalKes);
    var note = byId('coShipNote');
    note.hidden = false;
    note.textContent = cart.shipping.awayKes > 0
      ? 'Add ' + NURA.fmtKsh(cart.shipping.awayKes) + ' more for free delivery.'
      : 'Free delivery on this order.';
    updatePayment();
  }

  function showEmpty() {
    byId('coMain').innerHTML =
        '<h1 class="co-title">Checkout</h1>'
      + '<div class="co-empty"><p style="font-family:var(--display);font-size:26px;letter-spacing:2px;color:var(--black);margin:0;">Your cart is empty</p>'
      + '<p>Add something you love, then come back here.</p>'
      + '<a class="nura-continue co-continue" href="index.html">Continue shopping <span aria-hidden="true">&rarr;</span></a></div>';
  }

  function loadCart() {
    return NURA.api('/cart').then(function (d) {
      cart = d.cart;
      if (!cart.items.length) { showEmpty(); return; }
      renderSummary();
    });
  }

  /* ── Payment: what's possible for this county and total ────────────────────────── */
  function updatePayment() {
    if (!options || !cart || !byId('coCounty')) return;   // the form is gone when the cart is empty
    var county = byId('coCounty').value;
    var cod = form.querySelector('input[value="COD"]');
    var codRow = cod.closest('.co-method');
    var codZone = options.cod.counties.indexOf(county) > -1;
    var underMax = options.cod.maxKes === null || cart.totalKes <= options.cod.maxKes;
    var codOk = (!county || codZone) && underMax;       // before a county is chosen, don't grey it out yet
    cod.disabled = !codOk;
    codRow.classList.toggle('is-off', !codOk);
    byId('coCodDesc').textContent = !underMax
      ? 'Available for orders up to ' + NURA.fmtKsh(options.cod.maxKes) + '.'
      : county && !codZone
        ? 'Not available in ' + county + ' yet: ' + options.cod.counties.join(', ') + ' only.'
        : 'Pay in cash when your order arrives. ' + options.cod.counties.join(', ') + ' only.';
    if (!codOk) cod.checked = false;

    // M-Pesa (Phase 5): on as soon as the server says it's configured, in every county.
    var mpesa = form.querySelector('input[value="MPESA"]');
    mpesa.disabled = !options.methods.MPESA;
    mpesa.closest('.co-method').classList.toggle('is-off', mpesa.disabled);
    var tag = mpesa.closest('.co-method').querySelector('.co-method__tag');
    if (tag) tag.hidden = !mpesa.disabled;

    // Cards (Phase 6): on when the server says Paystack is configured, in every county.
    var card = form.querySelector('input[value="CARD"]');
    card.disabled = !options.methods.CARD;
    card.closest('.co-method').classList.toggle('is-off', card.disabled);
    var cardTag = card.closest('.co-method').querySelector('.co-method__tag');
    if (cardTag) cardTag.hidden = !card.disabled;

    // If exactly one way to pay is open, choose it; with more, the shopper picks.
    var open = [cod, mpesa, card].filter(function (r) { return !r.disabled; });
    if (!form.querySelector('input[name="paymentMethod"]:checked') && open.length === 1) open[0].checked = true;

    markSelected();
    var anyAvailable = open.length > 0;
    var noPay = byId('coNoPay');
    noPay.hidden = anyAvailable;
    noPay.textContent = anyAvailable ? '' : 'Delivery to ' + county + ' opens when M-Pesa and card payments arrive, very soon. For now we can only take cash on delivery in '
      + options.cod.counties.join(', ') + '.';
    var btn = byId('coSubmit');
    btn.disabled = !anyAvailable || sending || cart.items.some(function (i) { return i.problem; });
    var chosen = form.querySelector('input[name="paymentMethod"]:checked');
    btn.textContent = sending ? 'Placing order…'
      : chosen && chosen.value === 'MPESA' ? 'Pay ' + NURA.fmtKsh(cart.totalKes) + ' with M-Pesa'
      : chosen && chosen.value === 'CARD' ? 'Pay ' + NURA.fmtKsh(cart.totalKes) + ' by card'
      : 'Place order · ' + NURA.fmtKsh(cart.totalKes);
  }

  function markSelected() {
    form.querySelectorAll('.co-method').forEach(function (row) {
      row.classList.toggle('is-selected', row.querySelector('input').checked);
    });
  }

  /* ── Validation (the server checks everything again; this just saves a round trip) ── */
  function fieldError(inputId, on, text) {
    var input = byId(inputId), err = byId(inputId + 'Err');
    input.classList.toggle('error', on);
    if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (err) { if (text) err.textContent = text; err.classList.toggle('show', on); }
    return on;
  }
  function validate() {
    var bad = [];
    var v = function (id) { return byId(id).value.trim(); };
    if (fieldError('coEmail', !EMAIL_RE.test(v('coEmail')))) bad.push('coEmail');
    if (fieldError('coPhone', !PHONE_RE.test(v('coPhone').replace(/[\s\-().]/g, '')))) bad.push('coPhone');
    if (fieldError('coName', !v('coName'))) bad.push('coName');
    if (fieldError('coLine1', !v('coLine1'))) bad.push('coLine1');
    if (fieldError('coArea', !v('coArea'))) bad.push('coArea');
    if (fieldError('coCounty', !v('coCounty'))) bad.push('coCounty');
    var method = form.querySelector('input[name="paymentMethod"]:checked');
    byId('coMethodErr').classList.toggle('show', !method);
    if (!method && !bad.length) bad.push('coMethods');
    if (bad.length) {
      var first = byId(bad[0]);
      (first.tagName === 'DIV' ? first.querySelector('input:not(:disabled)') || first : first).focus();
    }
    return !bad.length;
  }

  function alertBox(text) {
    var a = byId('coAlert');
    if (!a) return;                       // the empty-cart message has replaced the form
    a.hidden = !text;
    a.textContent = text || '';
    if (text) a.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ── Place order ───────────────────────────────────────────────────────────────── */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending || !cart) return;
    alertBox('');
    if (!validate()) return;
    var val = function (id) { return byId(id).value.trim(); };
    var body = {
      checkoutKey: checkoutKey,
      email: val('coEmail'), phone: val('coPhone'), name: val('coName'),
      addressLine1: val('coLine1'), area: val('coArea'), county: val('coCounty'),
      paymentMethod: form.querySelector('input[name="paymentMethod"]:checked').value,
    };

    sending = true; updatePayment();
    NURA.api('/checkout', { method: 'POST', body: body })
      .then(function (d) {
        // Card: straight on to Paystack's secure page; it sends the shopper back to the order.
        if (d.redirectUrl) { location.href = d.redirectUrl; return; }
        // The order id goes after # so it never reaches server logs or other sites.
        location.href = 'order-confirmed.html#' + encodeURIComponent(d.order.id);
      }, function (err) {
        sending = false;
        if (err.status === 0) {
          // No answer at all. The order may or may not exist; pressing again is safe (same key).
          alertBox('We couldn’t reach NURA. Check your connection and press Place order again. You won’t be charged twice.');
        } else {
          alertBox(err.message);
        }
        // Stock or availability changed: show the cart as it is now, with the problem marked.
        if (err.status === 409 || err.status === 400) loadCart().catch(function () {});
        updatePayment();
      });
  });

  NURA.on('co-remove', function (el) {
    el.disabled = true;
    NURA.api('/cart/items/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' })
      .then(function (d) { cart = d.cart; if (!cart.items.length) showEmpty(); else { renderSummary(); alertBox(''); } },
            function (err) { el.disabled = false; alertBox(err.message); });
  });

  byId('coCounty').addEventListener('change', function () { fieldError('coCounty', false); updatePayment(); });
  form.addEventListener('input', function (e) {             // clear a field's error as soon as it's edited
    if (e.target.classList.contains('error')) fieldError(e.target.id, false);
  });
  form.addEventListener('change', function (e) {
    if (e.target.name === 'paymentMethod') { byId('coMethodErr').classList.remove('show'); updatePayment(); }
  });

  // Phones: fold the summary away so the form comes first. Desktop keeps it open.
  if (window.matchMedia('(max-width: 899px)').matches) byId('coSummary').open = false;

  /* ── Start: options, cart and (if signed in) who you are, in parallel ────────────── */
  // Counties and payment methods. If they can't be loaded (after api.js's own retries), the
  // form can't be completed, so offer "Try again" right in the message (Oct 2026: before, the
  // county list stayed empty and Place order stayed disabled with no way out but a reload).
  function loadOptions() {
    return NURA.api('/checkout/options').then(function (o) {
      options = o;
      alertBox('');
      var sel = byId('coCounty');
      if (!sel) return;
      o.counties.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        sel.appendChild(opt);
      });
      updatePayment();
    }, function (err) {
      alertBox(err.message + ' ');
      var retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'co-link'; retry.textContent = 'Try again';
      retry.addEventListener('click', function () { retry.disabled = true; optionsReady = loadOptions(); });
      if (byId('coAlert')) byId('coAlert').appendChild(retry);
    });
  }
  var optionsReady = loadOptions();

  loadCart().catch(function (err) { alertBox(err.message); });

  // Signed in: email from the account; name, phone and address from the latest order (decided:
  // no separate address book). Only empty fields are filled, never anything already typed.
  function fillIfEmpty(id, value) {
    var el = byId(id);
    if (el && !el.value && value) { el.value = value; return true; }
    return false;
  }
  var localPhone = function (p) {
    var m = String(p || '').match(/^254(\d{3})(\d{3})(\d{3})$/);
    return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : p;
  };
  NURA.api('/auth/me').then(function (d) {
    if (!d.user) return;
    fillIfEmpty('coEmail', d.user.email);
    return NURA.api('/account').then(function (a) {
      var last = a.lastDelivery;
      fillIfEmpty('coName', last ? last.name : d.user.name);
      if (!last) return;
      var filled = [fillIfEmpty('coPhone', localPhone(last.phone)), fillIfEmpty('coLine1', last.addressLine1), fillIfEmpty('coArea', last.area)];
      // The county list arrives separately; set it once it's there (and only if still unchosen).
      optionsReady.then(function () {
        var sel = byId('coCounty');
        if (sel && !sel.value && Array.prototype.some.call(sel.options, function (o) { return o.value === last.county; })) {
          sel.value = last.county;
          updatePayment();                          // COD availability depends on the county
        }
      });
      if (filled.indexOf(true) > -1) {
        var note = byId('coPrefill');
        note.textContent = 'We’ve filled in the delivery details from your last order. Change anything that’s different.';
        note.hidden = false;
      }
    });
  }).catch(function () {});
})();
