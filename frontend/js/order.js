/* NURA order.js: the order page (order-confirmed.html#<order id>).

   Everything shown comes from GET /api/orders/:id, which answers only the account or the
   guest browser that placed the order. Anyone else, with the same link, gets "not found".

   Phase 5: an M-Pesa order lands here BEFORE it's paid. While Safaricom waits for the PIN the
   page shows "Check your phone" and asks the server every 3 seconds how it's going. The
   answer always comes from the server; this page never decides that something was paid. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var main = document.getElementById('ocMain');
  // The order id arrives after # (from checkout), or as ?order= when Paystack sends the shopper
  // back (it adds ?reference=… too). Either way, tidy the address to the # form straight away.
  // From an order email, a guest's link is #<id>.<token>: a signed pass for this order (see
  // api/src/lib/orderLink.js). It's swapped for access once, then removed from the address bar,
  // so it doesn't linger in history or get copied along with the address.
  var params = new URLSearchParams(location.search);
  var raw = params.get('order') || decodeURIComponent(location.hash.slice(1));
  var dot = raw.indexOf('.');
  var id = dot > 0 ? raw.slice(0, dot) : raw;
  var linkToken = dot > 0 ? raw.slice(dot + 1) : '';
  var backFromPaystack = params.has('reference') || params.has('trxref');
  if (params.get('order') || linkToken) history.replaceState(null, '', location.pathname + '#' + id);
  var POLL_MS = 3000, GIVE_UP_MS = 10 * 60 * 1000;
  var pollTimer = null, pollStarted = 0, lastState = '';

  /** 254712345678 → 0712 345 678, the way Kenyans write their numbers. */
  function localPhone(p) {
    var m = String(p).match(/^254(\d{3})(\d{3})(\d{3})$/);
    return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : p;
  }
  var time = function (d) { return new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); };

  function linkExpired() {
    main.innerHTML =
        '<section class="oc-card"><h1 class="co-title" style="font-size:36px;">This link has expired</h1>'
      + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Order links in emails work for 30 days. '
      + 'You can still open the order in the browser you ordered from.</p>'
      + '<a class="co-link" href="index.html">Back to NURA &rarr;</a></section>';
  }

  function notFound() {
    main.innerHTML =
        '<section class="oc-card"><h1 class="co-title" style="font-size:36px;">We couldn’t find that order</h1>'
      + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Orders can only be opened in the browser that placed them, or when signed in to the account they belong to. '
      + 'If you ordered on another device, open it there.</p>'
      + '<a class="co-link" href="index.html">Back to NURA &rarr;</a></section>';
  }

  /* ── Pieces shared by every state ─────────────────────────────────────────────── */
  function itemsCard(o, totalLabel) {
    var items = o.items.map(function (it) {
      return '<div class="co-line">'
        + '<div class="co-line__img" style="background:' + esc(it.cardBg || '#efefed') + '">'
        +   (it.imageUrl ? '<img src="' + esc(it.imageUrl) + '" alt="">' : '')
        +   '<span class="co-line__qty" aria-hidden="true">' + Number(it.qty) + '</span></div>'
        + '<div>' + (it.brand ? '<p class="co-line__brand">' + esc(it.brand) + '</p>' : '')
        +   '<p class="co-line__name">' + esc(it.name) + '</p>'
        +   '<p class="co-line__meta">' + (it.size !== 'ONE SIZE' ? 'Size ' + esc(it.size) + ' · ' : '') + 'Qty ' + Number(it.qty) + '</p></div>'
        + '<p class="co-line__price">' + NURA.fmtKsh(it.lineTotalKes) + '</p></div>';
    }).join('');
    return '<section class="oc-card" aria-labelledby="ocItems"><h2 id="ocItems">Your order</h2>' + items
      + '<div class="co-rows">'
      +   '<div class="co-row"><span>Subtotal</span><span>' + NURA.fmtKsh(o.subtotalKes) + '</span></div>'
      +   '<div class="co-row"><span>Delivery</span><span>' + (o.shippingKes ? NURA.fmtKsh(o.shippingKes) : 'Free') + '</span></div>'
      +   '<div class="co-row co-row--total"><span>' + totalLabel + '</span><span>' + NURA.fmtKsh(o.totalKes) + '</span></div>'
      + '</div></section>';
  }
  function hero(kicker, title, text) {
    return '<section class="oc-hero"><p class="oc-hero__kicker">' + kicker + '</p>'
      + '<h1 tabindex="-1" id="ocTitle">' + title + '</h1><p>' + text + '</p></section>';
  }
  function addressCard(o) {
    return '<section class="oc-card" aria-labelledby="ocTo"><h2 id="ocTo">Delivering to</h2><address class="oc-address">'
      + esc(o.contact.name) + '<br>' + esc(o.delivery.addressLine1) + '<br>' + esc(o.delivery.area) + ', ' + esc(o.delivery.county)
      + (o.delivery.notes ? '<br><span class="co-hint">“' + esc(o.delivery.notes) + '”</span>' : '')
      + '</address></section>';
  }

  /* ── Placed: COD waiting for the rider, or paid by M-Pesa ─────────────────────── */
  function renderPlaced(o) {
    var cod = o.paymentMethod === 'COD';
    var first = o.contact.name.split(/\s+/)[0];
    var steps = '<li><span><strong>We call to confirm</strong>We’ll ring ' + esc(localPhone(o.contact.phone)) + ' to confirm your order and a delivery time.</span></li>'
      + '<li><span><strong>We pack and dispatch</strong>Your pieces are checked, packed and handed to a rider.</span></li>'
      + (cod ? '<li><span><strong>Pay when it arrives</strong>Have ' + NURA.fmtKsh(o.totalKes) + ' ready for the rider.</span></li>'
             : '<li><span><strong>Delivered</strong>Your rider brings it to your door. Nothing more to pay.</span></li>');
    var receipt = o.payment && o.payment.receipt;
    var paidWith = cod ? 'Cash on delivery'
      : o.paymentMethod === 'CARD' ? (receipt ? esc(receipt) : 'Card')
      : 'M-Pesa' + (receipt ? '<br><span class="co-hint">Receipt ' + esc(receipt) + '</span>' : '');
    main.innerHTML =
        hero('Order ' + esc(o.number), 'Thank you, ' + esc(first),
          // No confirmation email yet: emails arrive in Phase 7, so the page must not promise one.
          (cod ? 'Your order is in.' : 'Payment received, and your order is in.') + ' Keep your order number, ' + esc(o.number) + ', in case you need to reach us.')
      + '<section class="oc-card" aria-labelledby="ocNext"><h2 id="ocNext">What happens next</h2><ol class="oc-steps">' + steps + '</ol></section>'
      + itemsCard(o, cod ? 'To pay on delivery' : 'Paid')
      + '<div class="oc-cols">' + addressCard(o)
      +   '<section class="oc-card" aria-labelledby="ocPay"><h2 id="ocPay">Payment</h2><p class="oc-address">' + paidWith
      +   '<br><span class="co-hint">Placed ' + new Date(o.placedAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) + '</span></p></section>'
      + '</div>'
      + (o.guest
          ? '<section class="oc-card oc-invite"><p><strong>Save your details for next time.</strong><br>Create an account with ' + esc(o.contact.email)
            + ' and this order will be waiting in it.</p><a class="auth-submit" href="index.html#create-account" id="ocSignup">Create account</a></section>'
          : '');
    var signup = document.getElementById('ocSignup');
    if (signup) {
      // The sign-up form on the next page starts with this email filled in (this tab only).
      signup.addEventListener('click', function () {
        try { sessionStorage.setItem('nura_signup_email', o.contact.email); } catch (e) {}
      });
    }
    document.title = 'Order ' + o.number + ' confirmed — NURA';
  }

  /* ── Card: off to Paystack, back from Paystack, declined ──────────────────────── */
  function goPay(o, btn) {
    btn.disabled = true; btn.textContent = 'Opening secure payment…';
    NURA.api('/orders/' + encodeURIComponent(o.id) + '/pay', { method: 'POST', body: {} }).then(function (d) {
      if (d.redirectUrl) { location.href = d.redirectUrl; return; }
      show(d.order);                                  // it turned out to be paid already
    }, function (err) {
      btn.disabled = false; btn.textContent = 'Try again';
      var a = document.getElementById('cardErr');
      a.hidden = false; a.textContent = err.message;
    });
  }

  function renderCard(o) {
    var p = o.payment || {};
    var checking = p.status === 'PENDING' && backFromPaystack;
    var panel;
    if (checking) {
      panel = '<div class="pay-wait" role="status"><span class="pay-spinner" aria-hidden="true"></span>'
        + '<div><p class="pay-big">Checking your payment</p><p>Confirming with Paystack. This takes a few seconds.</p></div></div>';
    } else if (p.status === 'FLAGGED') {
      panel = '<p class="co-notice">We received a payment we need to check by hand. We’ll call you on ' + esc(localPhone(o.contact.phone)) + ' shortly.</p>';
    } else {
      var failed = p.status === 'FAILED';
      panel = (failed ? '<div class="co-alert" role="alert">' + esc(p.message || 'The card payment didn’t go through.') + '</div>'
                      : '<p style="font-size:13px;line-height:1.7;">Your order is reserved. Pay on Paystack’s secure page with a card or Apple Pay. Your card details never touch NURA.</p>')
        + '<p class="co-alert" id="cardErr" role="alert" hidden></p>'
        + '<button class="auth-submit" type="button" id="cardPay" style="margin-top:16px;">' + (failed ? 'Try again' : 'Continue to secure payment') + '</button>'
        + '<p class="co-hint" style="margin-top:10px;">Your items are held until ' + time(o.payBy) + '.</p>';
    }
    main.innerHTML =
        hero('Order ' + esc(o.number), checking ? 'Almost there' : 'Payment not completed',
          'Pay ' + NURA.fmtKsh(o.totalKes) + ' by card to confirm your order.')
      + '<section class="oc-card" aria-labelledby="ocPayNow" aria-live="polite"><h2 id="ocPayNow">Card payment</h2>' + panel + '</section>'
      + itemsCard(o, 'To pay now')
      + '<div class="oc-cols">' + addressCard(o) + '</div>';
    document.title = (checking ? 'Checking your payment' : 'Payment not completed') + ' — NURA';
    var btn = document.getElementById('cardPay');
    if (btn) btn.addEventListener('click', function () { goPay(o, btn); });
  }

  /* ── M-Pesa: waiting, failed, retry ────────────────────────────────────────────── */
  function renderPayment(o) {
    if (o.paymentMethod === 'CARD') return renderCard(o);
    var p = o.payment || {};
    var waiting = p.status === 'PENDING';
    var outOfTries = !waiting && o.promptsLeft === 0;
    var slow = waiting && Date.now() - pollStarted > 90 * 1000;
    var panel;

    if (waiting) {
      panel = '<div class="pay-wait" role="status">'
        + '<span class="pay-spinner" aria-hidden="true"></span>'
        + '<div><p class="pay-big">Check your phone</p>'
        + '<p>We’ve sent an M-Pesa prompt to <strong>' + esc(localPhone(p.phone)) + '</strong>. Enter your PIN to pay <strong>' + NURA.fmtKsh(p.amountKes) + '</strong>.</p>'
        + (p.amountKes !== o.totalKes ? '<p class="co-hint">Test mode: the prompt asks for ' + NURA.fmtKsh(p.amountKes) + ' instead of the order total.</p>' : '')
        + (slow ? '<p class="co-hint">Still waiting for M-Pesa. This can take up to two minutes; if the prompt never appeared, you can resend it as soon as this one times out.</p>' : '')
        + '</div></div>';
    } else if (p.status === 'FLAGGED') {
      panel = '<p class="co-notice">We received a payment we need to check by hand. We’ll call you on ' + esc(localPhone(o.contact.phone)) + ' shortly.</p>';
    } else if (outOfTries) {
      panel = '<div class="co-alert" role="alert">' + esc(p.message || 'The payment didn’t go through.')
        + ' That was the last M-Pesa prompt for this order. Your items are held until ' + time(o.payBy) + ', then released. You can place a new order any time.</div>'
        + '<a class="co-link" href="index.html">Back to the shop &rarr;</a>';
    } else {
      panel = '<div class="co-alert" role="alert">' + esc(p.message || 'The payment didn’t go through.') + '</div>'
        + '<form class="pay-retry" id="payRetry" novalidate>'
        + '<div class="auth-field"><label class="auth-label" for="payPhone">M-Pesa number</label>'
        + '<input class="auth-input" id="payPhone" type="tel" inputmode="tel" autocomplete="tel" value="' + esc(localPhone(p.phone || o.contact.phone)) + '" aria-describedby="payPhoneErr">'
        + '<span class="auth-error" id="payPhoneErr">Please enter a Kenyan mobile number, like 0712 345 678.</span></div>'
        + '<button class="auth-submit" type="submit">Resend M-Pesa prompt</button>'
        + '<p class="co-hint">' + o.promptsLeft + ' more ' + (o.promptsLeft === 1 ? 'try' : 'tries') + '. Your items are held until ' + time(o.payBy) + '.</p>'
        + '</form>';
    }

    main.innerHTML =
        hero('Order ' + esc(o.number), waiting ? 'Almost there' : 'Payment not completed',
          'Pay ' + NURA.fmtKsh(o.totalKes) + ' with M-Pesa to confirm your order.')
      + '<section class="oc-card" aria-labelledby="ocPayNow" aria-live="polite"><h2 id="ocPayNow">M-Pesa</h2>' + panel + '</section>'
      + itemsCard(o, 'To pay now')
      + '<div class="oc-cols">' + addressCard(o) + '</div>';
    document.title = (waiting ? 'Check your phone' : 'Payment not completed') + ' — NURA';

    var form = document.getElementById('payRetry');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('payPhone');
      var phone = input.value.trim();
      var ok = /^(?:\+?254|0)?[17]\d{8}$/.test(phone.replace(/[\s\-().]/g, ''));
      document.getElementById('payPhoneErr').classList.toggle('show', !ok);
      if (!ok) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      var btn = form.querySelector('button');
      btn.disabled = true; btn.textContent = 'Sending…';
      NURA.api('/orders/' + encodeURIComponent(o.id) + '/pay', { method: 'POST', body: { phone: phone } })
        .then(function (d) { pollStarted = Date.now(); show(d.order); poll(); }, function (err) {
          btn.disabled = false; btn.textContent = 'Resend M-Pesa prompt';
          var a = document.createElement('p'); a.className = 'co-alert'; a.setAttribute('role', 'alert'); a.textContent = err.message;
          form.prepend(a);
        });
    });
  }

  function renderExpired(o) {
    main.innerHTML =
        hero('Order ' + esc(o.number), 'Not paid in time', 'This order wasn’t paid within the time limit, so its items were released for other shoppers.')
      + '<section class="oc-card"><p class="co-hint" style="font-size:13px;">If money left your M-Pesa for this order, we’ll refund it. Keep your order number handy if you contact us.</p>'
      + '<a class="co-link" href="index.html">Back to the shop &rarr;</a></section>'
      + itemsCard(o, 'Total');
  }

  /* ── Which state, and keep asking while M-Pesa is working ─────────────────────── */
  function show(o) {
    var p = o.payment || {};
    var slow = p.status === 'PENDING' && Date.now() - pollStarted > 90 * 1000;
    // Redraw only when something changed. Redrawing every 3 s would make screen readers
    // repeat the whole message, and would wipe anything typed into the form.
    var state = o.status + '/' + (p.status || '') + '/' + (p.resultCode || '') + '/' + o.promptsLeft + '/' + slow + '/' + backFromPaystack;
    if (state === lastState) return;
    var headingChanged = state.split('/')[0] !== lastState.split('/')[0] || state.split('/')[1] !== lastState.split('/')[1];
    lastState = state;
    if (o.status === 'PENDING_PAYMENT') renderPayment(o);
    else if (o.status === 'EXPIRED') renderExpired(o);
    else renderPlaced(o);
    // Move focus only when the situation really changed, so a screen reader hears it once.
    if (headingChanged) document.getElementById('ocTitle').focus();
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (Date.now() - pollStarted > GIVE_UP_MS) return;
      load().then(function (d) {
        var o = d.order, pending = o.status === 'PENDING_PAYMENT' && o.payment && o.payment.status === 'PENDING';
        // Back from Paystack but still undecided after a minute: stop saying "checking" and
        // offer the button again (the same Paystack page is reused, so nothing is charged twice).
        if (pending && backFromPaystack && Date.now() - pollStarted > 60 * 1000) backFromPaystack = false;
        show(o);
        if (pending && (o.paymentMethod !== 'CARD' || backFromPaystack)) poll();
      }, function () { poll(); });              // a hiccup: try again next round
    }, POLL_MS);
  }

  /** Back from Paystack: ask the server to check with Paystack now. Otherwise just read the order. */
  function load() {
    return backFromPaystack
      ? NURA.api('/orders/' + encodeURIComponent(id) + '/check', { method: 'POST' })
      : NURA.api('/orders/' + encodeURIComponent(id));
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) { notFound(); return; }
  pollStarted = Date.now();
  // With an email link, first swap its token for access in this browser; then load as usual.
  var opened = linkToken
    ? NURA.api('/orders/' + encodeURIComponent(id) + '/open', { method: 'POST', body: { token: linkToken } })
    : Promise.resolve();
  opened.then(load, function (err) {
    if (err.status === 404) { linkExpired(); return new Promise(function () {}); }   // stop here
    throw err;
  }).then(function (d) {
    var o = d.order;
    show(o);
    if (o.status === 'PENDING_PAYMENT' && o.payment && o.payment.status === 'PENDING'
        && (o.paymentMethod !== 'CARD' || backFromPaystack)) poll();
  }, function (err) {
    if (err.status === 404 || err.status === 400) notFound();
    else main.innerHTML = '<section class="oc-card"><p role="alert">' + esc(err.message) + '</p></section>';
  });
})();
