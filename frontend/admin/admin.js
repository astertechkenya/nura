/* NURA admin.js: the whole admin, one page, four screens (#dashboard, #orders, #products,
   #activity) plus one order (#order/<id>).

   This page decides nothing. Every button asks the API, which checks the role, the two-factor
   code, and whether the move is allowed, then answers with the new state to draw. A demo admin
   sees the same screens with inputs disabled; the API would refuse the changes anyway. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc, ksh = NURA.fmtKsh;
  var main = document.getElementById('admMain');
  var me = null;                       // { name, role, masked, needsTotp }

  var STATUS = {
    PENDING_PAYMENT: 'Awaiting payment', AWAITING_COD: 'New · cash on delivery', PAID: 'Paid · to pack',
    PROCESSING: 'Packing', SHIPPED: 'On its way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', EXPIRED: 'Expired',
  };
  var ACTION = {
    PROCESSING: 'Confirmed: start packing', SHIPPED: 'Mark as shipped', DELIVERED: 'Mark as delivered',
    CANCELLED: 'Cancel order', 'cod-collected': 'Cash collected: delivered',
  };
  var METHOD = { COD: 'Cash on delivery', MPESA: 'M-Pesa', CARD: 'Card' };
  // Photos are either the shop's own files (images/x.webp, relative to the shop, so ../ from
  // /admin/) or Cloudinary addresses (https://…, used as they are).
  // Thumbnails: the 400px copy (js/api.js). Our own photos are relative to the site root.
  var imgSrc = function (u) { var s = NURA.photo(u); return /^https:\/\//.test(s) ? s : '../' + s; };

  function toast(text) {
    var t = document.getElementById('nuraToast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }
  var pill = function (status) { return '<span class="adm-pill adm-pill--' + esc(status) + '">' + esc(STATUS[status] || status) + '</span>'; };
  var when = function (d) { return new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }); };
  function ago(d) {
    var m = Math.round((Date.now() - new Date(d)) / 60000);
    return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  var localPhone = function (p) { var m = String(p).match(/^254(\d{3})(\d{3})(\d{3})$/); return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : p; };
  var api = function (path, opts) { return NURA.api('/admin' + path, opts); };

  /* ── Getting in: sign in, then the 6-digit code ─────────────────────────────── */
  function showLogin(message) {
    document.getElementById('admTabs').hidden = true;
    main.innerHTML = '<section class="adm-login"><h1 class="adm-h1">Sign in</h1>'
      + (message ? '<p class="adm-alert" role="alert">' + esc(message) + '</p>' : '')
      + '<form class="auth-form" id="admLogin" novalidate>'
      + '<div class="auth-field"><label class="auth-label" for="admEmail">Email</label><input class="auth-input" id="admEmail" type="email" autocomplete="username" required></div>'
      + '<div class="auth-field"><label class="auth-label" for="admPw">Password</label><input class="auth-input" id="admPw" type="password" autocomplete="current-password" required></div>'
      + '<button class="auth-submit" type="submit">Sign in</button></form></section>';
    document.getElementById('admLogin').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = this.querySelector('button'); btn.disabled = true;
      NURA.api('/auth/login', { method: 'POST', body: { email: document.getElementById('admEmail').value.trim(), password: document.getElementById('admPw').value } })
        .then(start, function (err) { showLogin(err.message); });
    });
    document.getElementById('admEmail').focus();
  }

  function showCode(message) {
    document.getElementById('admTabs').hidden = true;
    main.innerHTML = '<section class="adm-login"><h1 class="adm-h1">Your code</h1>'
      + '<p class="adm-muted">Open your authenticator app and type the 6-digit code for NURA.</p>'
      + (message ? '<p class="adm-alert" role="alert" style="margin-top:12px;">' + esc(message) + '</p>' : '')
      + '<form class="auth-form" id="admTotp" novalidate><div class="auth-field"><label class="auth-label" for="admCode">6-digit code</label>'
      + '<input class="auth-input adm-code" id="admCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>'
      + '<button class="auth-submit" type="submit">Continue</button></form></section>';
    var input = document.getElementById('admCode');
    input.focus();
    document.getElementById('admTotp').addEventListener('submit', function (e) {
      e.preventDefault();
      api('/totp', { method: 'POST', body: { code: input.value.replace(/\D/g, '') } }).then(start, function (err) { showCode(err.message); });
    });
  }

  function start() {
    return api('/me').then(function (m) {
      me = m;
      if (m.needsTotp) return showCode();
      document.getElementById('admTabs').hidden = false;
      document.getElementById('admSignOut').hidden = false;
      var role = document.getElementById('admRole');
      role.hidden = !m.masked;
      role.textContent = 'Demo · read only';
      route();
    }, function (err) {
      if (err.status === 401) showLogin(err.message === 'Please sign in.' ? '' : err.message);
      else if (err.status === 403) {
        main.innerHTML = '<section class="adm-login"><h1 class="adm-h1">Admins only</h1><p class="adm-muted">'
          + esc(err.message) + '</p><button class="adm-btn" id="admOut2" style="margin-top:16px;">Sign out</button></section>';
        document.getElementById('admOut2').addEventListener('click', signOut);
      } else main.innerHTML = '<p class="adm-alert" role="alert">' + esc(err.message) + '</p>';
    });
  }
  function signOut() { NURA.api('/auth/logout', { method: 'POST' }).catch(function () {}).then(function () { location.hash = ''; showLogin(); }); }
  document.getElementById('admSignOut').addEventListener('click', signOut);

  /** Any request can find the session expired or the code needed: go back to the right step. */
  function failed(err) {
    if (err.status === 401 && err.message.indexOf('code') > -1) return showCode();
    if (err.status === 401) return showLogin(err.message);
    toast(err.message);
  }

  /* ── Screens ──────────────────────────────────────────────────────────────────── */
  function setTab(name) {
    document.querySelectorAll('.adm-tabs a').forEach(function (a) {
      if (a.dataset.tab === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function dashboard() {
    setTab('dashboard');
    api('/summary').then(function (s) {
      var b = s.byStatus;
      var tile = function (n, label, href, cls) {
        return '<a class="adm-tile' + (n && cls ? ' ' + cls : '') + '" href="' + href + '"><strong>' + Number(n || 0) + '</strong><span>' + label + '</span></a>';
      };
      main.innerHTML = '<h1 class="adm-h1">Today, ' + esc(me.name.split(' ')[0]) + '</h1>'
        + '<div class="adm-tiles">'
        + tile(s.toDo, 'To do', '#orders?status=TODO', 'is-hot')
        + tile(b.AWAITING_COD, 'New cash orders', '#orders?status=AWAITING_COD', 'is-hot')
        + tile(b.PAID, 'Paid, to pack', '#orders?status=PAID', 'is-hot')
        + tile(b.SHIPPED, 'On their way', '#orders?status=SHIPPED')
        + tile(s.refundsDue, 'Refunds due', '#orders?status=REFUND_DUE', 'is-bad')
        + tile(s.flaggedPayments, 'Payments to check', '#orders?status=FLAGGED', 'is-bad')
        + '<div class="adm-tile" style="grid-column:span 2;"><strong>' + esc(ksh(s.takingsLast7DaysKes)) + '</strong><span>Taken in the last 7 days</span></div>'
        + '</div>'
        + '<h2 class="adm-h2">Low stock</h2>'
        + (s.lowStock.length
          ? s.lowStock.map(function (v) { return '<div class="adm-log">' + esc(v.name) + ' · ' + esc(v.size) + ': <strong>' + Number(v.stock) + ' left</strong></div>'; }).join('')
            + '<a class="adm-back" href="#products" style="margin-top:8px;">Restock in Products →</a>'
          : '<p class="adm-muted">Nothing is running low.</p>');
    }, failed);
  }

  var FILTERS = [['TODO', 'To do'], ['AWAITING_COD', 'New cash'], ['PAID', 'Paid'], ['PROCESSING', 'Packing'],
    ['SHIPPED', 'Shipped'], ['DELIVERED', 'Delivered'], ['REFUND_DUE', 'Refunds'], ['FLAGGED', 'Payments to check'], ['', 'All']];

  function orders(query) {
    setTab('orders');
    var status = query.status != null ? query.status : 'TODO', q = query.q || '';
    var params = [];
    if (status) params.push('status=' + encodeURIComponent(status));
    if (q) params.push('q=' + encodeURIComponent(q));
    main.innerHTML = '<h1 class="adm-h1">Orders</h1>'
      + '<nav class="adm-filters" aria-label="Filter orders">' + FILTERS.map(function (f) {
        return '<a class="adm-chip" href="#orders?status=' + f[0] + (q ? '&q=' + encodeURIComponent(q) : '') + '"'
          + (f[0] === status ? ' aria-current="true"' : '') + '>' + f[1] + '</a>';
      }).join('') + '</nav>'
      + '<form class="adm-search" id="admSearch" role="search"><label class="sr-only" for="admQ">Search orders</label>'
      + '<input class="auth-input" id="admQ" type="search" placeholder="Order number, name or phone" value="' + esc(q) + '">'
      + '<button class="adm-btn" type="submit">Search</button></form>'
      + '<div id="admList"><p class="adm-muted">Loading…</p></div>';
    document.getElementById('admSearch').addEventListener('submit', function (e) {
      e.preventDefault();
      location.hash = '#orders?status=' + status + '&q=' + encodeURIComponent(document.getElementById('admQ').value.trim());
    });
    api('/orders' + (params.length ? '?' + params.join('&') : '')).then(function (d) {
      var list = document.getElementById('admList');
      if (!d.orders.length) { list.innerHTML = '<p class="adm-muted">No orders here.</p>'; return; }
      list.innerHTML = d.orders.map(function (o) {
        return '<a class="adm-order" href="#order/' + esc(o.id) + '">'
          + '<span><span class="adm-order__no">' + esc(o.number) + '</span> ' + pill(o.status)
          + (o.refundStatus === 'DUE' ? ' <span class="adm-pill adm-pill--refund">Refund due</span>' : '') + '</span>'
          + '<span class="adm-order__total">' + esc(ksh(o.totalKes)) + '</span>'
          + '<span class="adm-order__who">' + esc(o.customerName) + ' · ' + esc(o.area) + ', ' + esc(o.county) + '</span><span></span>'
          + '<span class="adm-order__meta">' + Number(o.itemCount) + ' item' + (o.itemCount === 1 ? '' : 's') + ' · ' + esc(METHOD[o.paymentMethod]) + ' · ' + esc(ago(o.placedAt)) + '</span>'
          + '</a>';
      }).join('');
    }, failed);
  }

  function order(id) {
    setTab('orders');
    api('/orders/' + encodeURIComponent(id)).then(function (d) { drawOrder(d.order); }, function (err) {
      if (err.status === 404) main.innerHTML = '<a class="adm-back" href="#orders">← Orders</a><p class="adm-alert">Order not found.</p>';
      else failed(err);
    });
  }

  // The two decisions on a payment for the wrong amount. Accepting is only possible while the
  // order still waits for payment (its stock is still reserved); rejecting always is.
  function flagChoice(p, o) {
    var open = o.status === 'PENDING_PAYMENT';
    return '<div class="adm-flag" role="group" aria-label="Decide on this payment">'
      + '<p class="adm-flag__help">Check the receipt in your ' + (p.provider === 'DARAJA' ? 'M-Pesa' : 'Paystack') + ' dashboard first. '
      + (open ? 'Accept it if the difference is fine with you; reject it to refund the shopper (they can still pay the right amount).'
              : 'The order has closed, so this money can only be refunded.') + '</p>'
      + (open ? '<button class="adm-btn" type="button" data-flag="accept" data-payment="' + esc(p.id) + '">Accept as payment</button> ' : '')
      + '<button class="adm-btn adm-btn--danger" type="button" data-flag="reject" data-payment="' + esc(p.id) + '">Reject: refund it</button>'
      + '</div>';
  }

  function drawOrder(o) {
    var c = o.customer, dl = o.delivery;
    var items = o.items.map(function (i) {
      return '<div class="adm-item">' + (i.imageUrl ? '<img src="' + esc(imgSrc(i.imageUrl)) + '" alt="">' : '<span class="adm-ph"></span>')
        + '<span>' + esc(i.name) + '<br><span class="adm-muted">' + (i.size !== 'ONE SIZE' ? 'Size ' + esc(i.size) + ' · ' : '') + 'Qty ' + Number(i.qty) + '</span></span>'
        + '<strong>' + esc(ksh(i.lineTotalKes)) + '</strong></div>';
    }).join('');
    var pays = o.payments.map(function (p) {
      var rejected = p.status === 'FAILED' && p.resultCode === 'REJECTED';
      // A different amount arrived (flagged, or accepted anyway): show both figures.
      var amount = p.receivedKes ? esc(ksh(p.receivedKes)) + ' received <span class="adm-muted">(' + esc(ksh(p.amountKes)) + ' asked)</span>' : esc(ksh(p.amountKes));
      return '<li><span><strong>' + esc(METHOD[{ COD: 'COD', DARAJA: 'MPESA', PAYSTACK: 'CARD' }[p.provider]] || p.provider) + ' · '
        + (rejected ? 'REJECTED (refund due)' : esc(p.status)) + '</strong> '
        + amount + (p.receipt ? ' · ' + esc(p.receipt) : '')
        + (p.failureReason ? '<small>' + esc(p.failureReason) + '</small>' : '') + '<small>' + esc(when(p.createdAt)) + '</small>'
        + (p.status === 'FLAGGED' && !me.masked ? flagChoice(p, o) : '') + '</span></li>';
    }).join('');
    var events = o.events.map(function (e) {
      return '<li><span><strong>' + esc(STATUS[e.to] || e.to) + '</strong>' + (e.note ? ' · ' + esc(e.note) : '')
        + '<small>' + esc(when(e.at)) + (e.by ? ' · ' + esc(e.by) : '') + '</small></span></li>';
    }).join('');
    var EMAIL = { received: 'Order received', confirmed: 'Payment confirmed', shipped: 'On its way', delivered: 'Delivered',
                  cancelled: 'Cancelled', expired: 'Not completed (expired)', refund_due: 'Refund due (late payment)', payment_rejected: 'Payment not accepted (refund due)', refunded: 'Refund sent' };
    var EMAIL_STATUS = { sent: 'Sent', queued: 'Sending…', held: 'Held: address not in MAIL_ONLY_TO',
                         failed: 'Failed (see the API’s log)', logged: 'Not sent: email isn’t set up' };
    var emails = (o.emails || []).map(function (e) {
      return '<li><span><strong>' + esc(EMAIL[e.kind] || e.kind) + '</strong> · ' + esc(EMAIL_STATUS[e.status] || e.status)
        + '<small>' + esc(when(e.at)) + '</small></span></li>';
    }).join('');
    var actions = me.masked ? [] : o.actions;
    var refund = o.refundStatus === 'DUE' && !me.masked;

    main.innerHTML = '<a class="adm-back" href="#orders">← Orders</a>'
      + '<h1 class="adm-h1">' + esc(o.number) + '</h1>'
      + '<p style="margin:-6px 0 14px;">' + pill(o.status) + (o.refundStatus === 'DUE' ? ' <span class="adm-pill adm-pill--refund">Refund due</span>' : '')
      + ' <span class="adm-muted">Placed ' + esc(when(o.placedAt)) + '</span></p>'
      + (me.masked ? '<p class="adm-notice">Demo: names, phone numbers and addresses are hidden, and nothing can be changed.</p>' : '')
      + '<section class="adm-card"><dl class="adm-kv"><dt>Customer</dt><dd>' + esc(c.name) + (o.account ? ' <span class="adm-muted">(has an account)</span>' : '') + '</dd>'
      + '<dt>Phone</dt><dd>' + esc(localPhone(c.phone)) + '</dd><dt>Email</dt><dd>' + esc(c.email) + '</dd>'
      + '<dt>Deliver to</dt><dd>' + esc(dl.addressLine1) + '<br>' + esc(dl.area) + ', ' + esc(dl.county) + '</dd>'
      + (dl.notes ? '<dt>Notes</dt><dd>“' + esc(dl.notes) + '”</dd>' : '') + '</dl>'
      + (me.masked ? '' : '<a class="adm-call" href="tel:+' + esc(c.phone) + '">Call ' + esc(localPhone(c.phone)) + '</a>') + '</section>'
      + '<section class="adm-card"><h2 class="adm-h2" style="margin-top:0;">Items</h2>' + items
      + '<div class="adm-totals"><div><span>Subtotal</span><span>' + esc(ksh(o.subtotalKes)) + '</span></div>'
      + '<div><span>Delivery</span><span>' + (o.shippingKes ? esc(ksh(o.shippingKes)) : 'Free') + '</span></div>'
      + '<div class="is-total"><span>Total</span><span>' + esc(ksh(o.totalKes)) + '</span></div></div></section>'
      + '<section class="adm-card"><h2 class="adm-h2" style="margin-top:0;">Payments</h2><ul class="adm-timeline">' + (pays || '<li><span class="adm-muted">None yet.</span></li>') + '</ul></section>'
      + '<section class="adm-card"><h2 class="adm-h2" style="margin-top:0;">History</h2><ol class="adm-timeline">' + events + '</ol></section>'
      + '<section class="adm-card"><h2 class="adm-h2" style="margin-top:0;">Emails to the customer</h2><ul class="adm-timeline">' + (emails || '<li><span class="adm-muted">None yet.</span></li>') + '</ul></section>'
      + (actions.length || refund
        ? '<div class="adm-actions"><label class="sr-only" for="admNote">Note (optional)</label>'
          + '<input class="auth-input adm-note" id="admNote" maxlength="300" placeholder="Note for the history (optional)">'
          + actions.map(function (a) {
            var danger = a.to === 'CANCELLED';
            return '<button class="adm-btn' + (danger ? ' adm-btn--danger' : '') + '" type="button" data-act="' + esc(a.action) + '" data-to="' + esc(a.to) + '">'
              + esc(ACTION[a.action === 'cod-collected' ? 'cod-collected' : a.to]) + '</button>';
          }).join('')
          + (refund ? '<button class="adm-btn adm-btn--quiet" type="button" data-act="refunded">Refund paid back</button>' : '')
          + '</div>'
        : '');

    main.querySelectorAll('[data-flag]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Both decisions are final: the first tap arms the button, the second confirms.
        if (!btn.classList.contains('is-arming')) {
          var label = btn.textContent;
          btn.classList.add('is-arming'); btn.textContent = 'Tap again to confirm';
          setTimeout(function () { btn.classList.remove('is-arming'); btn.textContent = label; }, 4000);
          return;
        }
        var noteBox = document.getElementById('admNote');
        var body = { paymentId: btn.dataset.payment, decision: btn.dataset.flag };
        if (noteBox && noteBox.value.trim()) body.note = noteBox.value.trim();
        main.querySelectorAll('[data-flag],[data-act]').forEach(function (b) { b.disabled = true; });
        api('/orders/' + encodeURIComponent(o.id) + '/flagged', { method: 'POST', body: body }).then(function (d) {
          toast(body.decision === 'accept' ? 'Payment accepted: order is paid' : 'Payment rejected: refund due');
          drawOrder(d.order);
          main.focus();
        }, function (err) { failed(err); order(o.id); });
      });
    });

    main.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // Cancelling can't be undone: the first tap arms the button, the second confirms.
        if (btn.dataset.to === 'CANCELLED' && !btn.classList.contains('is-arming')) {
          btn.classList.add('is-arming'); btn.textContent = 'Tap again to cancel';
          setTimeout(function () { btn.classList.remove('is-arming'); btn.textContent = ACTION.CANCELLED; }, 4000);
          return;
        }
        var act = btn.dataset.act, note = document.getElementById('admNote').value.trim();
        var body = act === 'transition' ? { to: btn.dataset.to } : {};
        if (note) body.note = note;
        main.querySelectorAll('[data-act]').forEach(function (b) { b.disabled = true; });
        api('/orders/' + encodeURIComponent(o.id) + '/' + act, { method: 'POST', body: body }).then(function (d) {
          toast(act === 'refunded' ? 'Refund recorded' : 'Order is now: ' + (STATUS[d.order.status] || d.order.status));
          drawOrder(d.order);
          main.focus();
        }, function (err) { failed(err); order(o.id); });
      });
    });
  }

  var productQuery = {};
  function products(query) {
    setTab('products');
    productQuery = query || {};
    api('/products').then(function (d) { drawProducts(d.products); }, failed);
  }

  /* Sale dates are Nairobi time, which is UTC+3 all year (Kenya has no daylight saving), so
     the conversion is a fixed 3 hours whatever timezone the admin's own device is set to. */
  var EAT = 3 * 3600 * 1000;
  var toInput = function (iso) { return iso ? new Date(new Date(iso).getTime() + EAT).toISOString().slice(0, 16) : ''; };
  var fromInput = function (v) { return v ? v + ':00+03:00' : null; };
  var day = function (iso) { return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
  // What the shop is doing with this product's sale right now, in words.
  function saleState(p) {
    if (!p.compareAtKes) return '';
    if (p.saleOn) return '<span class="adm-pill adm-pill--DELIVERED">Sale on' + (p.saleEndsAt ? ' until ' + esc(day(p.saleEndsAt)) : '') + '</span>';
    if (p.saleStartsAt && new Date(p.saleStartsAt) > new Date()) return '<span class="adm-pill adm-pill--PROCESSING">Sale starts ' + esc(day(p.saleStartsAt)) + '</span>';
    return '<span class="adm-pill adm-pill--CANCELLED">Sale ended: selling at ' + esc(ksh(p.compareAtKes)) + '</span>';
  }

  var DEPTS = [['WOMEN', 'Women'], ['MEN', 'Men'], ['UNISEX', 'Unisex']];

  function drawProducts(list) {
    var off = me.masked ? ' disabled' : '';
    var count = function (d) { return list.filter(function (p) { return p.department === d; }).length; };
    main.innerHTML = '<div class="adm-titlebar"><h1 class="adm-h1">Products</h1>'
      + '<span class="adm-titlebar__actions"><a class="adm-btn adm-btn--quiet adm-btn--small" href="#stock">Bulk stock</a>'
      + (me.masked ? '' : ' <a class="adm-btn adm-btn--small" href="#product/new">+ Add a product</a>') + '</span></div>'
      + (me.masked ? '<p class="adm-notice">Demo: you can look, but prices and stock can’t be changed.</p>'
                   : '<p class="adm-muted" style="margin-bottom:14px;">Stock saves as soon as you leave the box. Prices and sale dates save with the button.</p>')
      // Search and department chips filter the list in place (no reload, nothing sent anywhere).
      + '<div class="adm-search" role="search"><input class="auth-input" type="search" id="admPQ" placeholder="Search name, brand or code (nura-012)" aria-label="Search products" value="' + esc(productQuery.q || '') + '"></div>'
      + '<div class="adm-filters" role="group" aria-label="Department">'
      + [['', 'All', list.length]].concat(DEPTS.map(function (d) { return [d[0], d[1], count(d[0])]; })).map(function (c) {
          return '<button type="button" class="adm-chip" data-dept="' + c[0] + '" aria-pressed="' + ((productQuery.dept || '') === c[0]) + '">' + c[1] + ' <span class="adm-muted">' + c[2] + '</span></button>';
        }).join('') + '</div>'
      + '<p class="adm-muted" id="admPNone" hidden>No products match.</p>'
      + DEPTS.map(function (d) {
        var group = list.filter(function (p) { return p.department === d[0]; });
        if (!group.length) return '';
        return '<section class="adm-pgroup" data-group="' + d[0] + '"><h2 class="adm-h2">' + d[1] + ' <span class="adm-muted" data-group-count></span></h2>'
          + group.map(productCard).join('') + '</section>';
      }).join('');

    // Search + department: show matching cards, hide empty groups, say so when nothing matches.
    var qInput = document.getElementById('admPQ');
    function applyFilter() {
      var q = qInput.value.trim().toLowerCase(), dept = productQuery.dept || '', shown = 0;
      main.querySelectorAll('.adm-pgroup').forEach(function (g) {
        var inGroup = 0;
        g.querySelectorAll('.adm-product').forEach(function (card) {
          var ok = (!dept || g.dataset.group === dept) && (!q || card.dataset.search.indexOf(q) > -1);
          card.hidden = !ok; if (ok) inGroup++;
        });
        g.hidden = !inGroup; shown += inGroup;
        g.querySelector('[data-group-count]').textContent = inGroup;
      });
      document.getElementById('admPNone').hidden = shown > 0;
      main.querySelectorAll('[data-dept]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.dept === dept)); });
    }
    qInput.addEventListener('input', function () { productQuery.q = qInput.value; applyFilter(); });
    main.querySelectorAll('[data-dept]').forEach(function (b) {
      b.addEventListener('click', function () { productQuery.dept = b.dataset.dept; applyFilter(); });
    });
    applyFilter();
    if (me.masked) return;
    wireProducts();
  }

  function productCard(p) {
    var off = me.masked ? ' disabled' : '';
    return '<article class="adm-product' + (p.isActive ? '' : ' is-hidden') + '" data-id="' + esc(p.id) + '" data-search="' + esc((p.name + ' ' + p.brand + ' ' + p.sku).toLowerCase()) + '">'
          + '<div class="adm-product__head">' + (p.imageUrl ? '<img src="' + esc(imgSrc(p.imageUrl)) + '" alt="">' : '<span class="adm-ph"></span>')
          + '<div><p class="adm-product__name">' + esc(p.name) + '</p><p class="adm-muted">' + esc(p.brand) + ' · ' + esc(p.sku) + '</p></div>'
          + '<label class="adm-toggle"><input type="checkbox" data-visible' + (p.isActive ? ' checked' : '') + off + '> Shown in shop</label></div>'
          + (me.masked ? '' : '<div class="adm-photo-row"><label class="adm-btn adm-btn--quiet adm-btn--small adm-file">Change photo'
            + '<input type="file" accept="' + PHOTO_TYPES.join(',') + '" data-photo class="adm-file__input" aria-label="Change photo of ' + esc(p.name) + '"></label>'
            + '<label class="adm-field adm-field--inline">Crop' + focusSelect(p.imageFocus, 'data-focus aria-label="Crop of ' + esc(p.name) + ' on the card"') + '</label></div>')
          + '<form class="adm-prices" data-prices novalidate>'
          + '<label class="adm-field">Price (KSh)<input type="number" min="1" step="1" inputmode="numeric" name="price" value="' + Number(p.priceKes) + '"' + off + '></label>'
          + '<label class="adm-field">Was (KSh)<input type="number" min="1" step="1" inputmode="numeric" name="was" aria-describedby="wasHint-' + esc(p.id) + '" value="' + (p.compareAtKes || '') + '"' + off + '></label>'
          + '<label class="adm-field">Sale starts<input type="datetime-local" name="starts" aria-describedby="wasHint-' + esc(p.id) + '" value="' + esc(toInput(p.saleStartsAt)) + '"' + off + '></label>'
          + '<label class="adm-field">Sale ends<input type="datetime-local" name="ends" aria-describedby="wasHint-' + esc(p.id) + '" value="' + esc(toInput(p.saleEndsAt)) + '"' + off + '></label>'
          + '<button class="adm-btn" type="submit"' + off + '>Save</button>'
          + '<span class="adm-hint" id="wasHint-' + esc(p.id) + '">Leave “Was” empty when it isn’t on sale. Dates are optional (Nairobi time): outside them it sells at the “Was” price. ' + saleState(p) + '</span></form>'
          + '<div class="adm-stock">' + p.variants.map(function (v) {
            var cls = v.stock === 0 ? 'is-out' : v.stock <= 3 ? 'is-low' : '';
            return '<label>' + esc(v.size) + '<input type="number" min="0" max="9999" step="1" inputmode="numeric" class="' + cls + '" data-variant="' + esc(v.id)
              + '" data-was="' + Number(v.stock) + '" value="' + Number(v.stock) + '" aria-label="Stock, ' + esc(p.name) + ' ' + esc(v.size) + '"' + off + '></label>';
          }).join('') + '</div>'
          // Description: folded away (it's long), shown on the product page and in link previews.
          + '<details class="adm-desc"><summary>Description' + (p.description ? '' : ' <span class="adm-pill adm-pill--refund">missing</span>') + '</summary>'
          + '<form data-desc novalidate><label class="adm-field">Description<textarea name="description" rows="5" maxlength="1000"' + off + '>' + esc(p.description || '') + '</textarea></label>'
          + '<span class="adm-hint">A blank line starts a new paragraph. The first ~155 characters show in Google and WhatsApp previews.</span>'
          + (me.masked ? '' : '<button class="adm-btn adm-btn--small" type="submit">Save description</button>')
          + ' <a class="adm-muted" href="/p/' + encodeURIComponent(p.slug) + '" target="_blank" rel="noopener">View page ↗</a></form></details>'
          + '</article>';
  }

  function wireProducts() {
    main.querySelectorAll('[data-desc]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var id = form.closest('[data-id]').dataset.id, btn = form.querySelector('button');
        btn.disabled = true;
        api('/products/' + id, { method: 'PATCH', body: { description: form.description.value } })
          .then(function () {
            toast('Description saved. It’s on the product page now.');
            var pill = form.closest('details').querySelector('summary .adm-pill');
            if (pill && form.description.value.trim()) pill.remove();
          }, failed)
          .finally(function () { btn.disabled = false; });
      });
    });

    main.querySelectorAll('[data-prices]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var id = form.closest('[data-id]').dataset.id;
        var price = parseInt(form.price.value, 10), was = form.was.value.trim() ? parseInt(form.was.value, 10) : null;
        if (!(price > 0)) { toast('Enter a price in whole shillings.'); return; }
        var body = { priceKes: price, compareAtKes: was };
        // Dates go only with a sale; removing the "Was" price removes them on the server too.
        if (was) { body.saleStartsAt = fromInput(form.starts.value); body.saleEndsAt = fromInput(form.ends.value); }
        api('/products/' + id, { method: 'PATCH', body: body })
          .then(function (d) {
            toast('Saved: ' + ksh(price) + (was ? ', was ' + ksh(was) : ''));
            var fresh = d.products.filter(function (x) { return x.id === id; })[0];
            if (fresh) {                                   // the sale's state in words, and cleared dates
              form.querySelector('.adm-hint').innerHTML = 'Leave “Was” empty when it isn’t on sale. Dates are optional (Nairobi time): outside them it sells at the “Was” price. ' + saleState(fresh);
              form.starts.value = toInput(fresh.saleStartsAt); form.ends.value = toInput(fresh.saleEndsAt);
            }
          }, failed);
      });
    });
    main.querySelectorAll('[data-visible]').forEach(function (box) {
      box.addEventListener('change', function () {
        var card = box.closest('[data-id]');
        api('/products/' + card.dataset.id, { method: 'PATCH', body: { isActive: box.checked } }).then(function () {
          card.classList.toggle('is-hidden', !box.checked);
          toast(box.checked ? 'Showing on the site' : 'Hidden from the site');
        }, function (err) { box.checked = !box.checked; failed(err); });
      });
    });
    main.querySelectorAll('[data-photo]').forEach(function (input) {
      input.addEventListener('change', function () {
        var card = input.closest('[data-id]'), file = input.files[0];
        if (!file) return;
        toast('Uploading photo…');
        uploadPhoto(file).then(function (publicId) {
          return api('/products/' + card.dataset.id + '/image', { method: 'PUT', body: { publicId: publicId } });
        }).then(function (d) { productQuery.q = document.getElementById('admPQ').value; drawProducts(d.products); toast('Photo changed'); }, function (err) { input.value = ''; failed(err); });
      });
    });
    main.querySelectorAll('[data-focus]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        var card = sel.closest('[data-id]');
        api('/products/' + card.dataset.id + '/image', { method: 'PUT', body: { imageFocus: sel.value } })
          .then(function () { toast('Crop saved'); }, failed);
      });
    });
    main.querySelectorAll('[data-variant]').forEach(function (input) {
      input.addEventListener('change', function () {
        var n = parseInt(input.value, 10);
        if (!(n >= 0)) { input.value = input.dataset.was; toast('Stock is a whole number, 0 or more.'); return; }
        api('/variants/' + input.dataset.variant, { method: 'PATCH', body: { stock: n } }).then(function () {
          input.dataset.was = n;
          input.className = n === 0 ? 'is-out' : n <= 3 ? 'is-low' : '';
          toast('Stock saved: ' + n);
        }, function (err) { input.value = input.dataset.was; failed(err); });
      });
    });
  }

  /* ── Photos: checked here first, signed by the API, sent straight to Cloudinary ──── */
  // The browser checks type and size only to give a quick, friendly answer. The real checks
  // happen on the server (Cloudinary is told the allowed formats in the signed upload, and the
  // API re-checks format, size and folder before saving), so skipping these gains nothing.
  var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  var PHOTO_MAX = 5 * 1024 * 1024;
  var FOCUS = { '50% 15%': 'top', '50% 50%': 'centre', '50% 85%': 'bottom' };

  // A crop selector. Older products may have a crop that isn't one of the three ("Custom"):
  // shown as such, and left alone unless the admin picks another.
  function focusSelect(current, attrs) {
    var now = current ? FOCUS[current] : 'centre';
    return '<select ' + attrs + '>' + (current && !now ? '<option value="" selected>Custom</option>' : '')
      + [['top', 'Top'], ['centre', 'Centre'], ['bottom', 'Bottom']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === now ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>';
  }

  /** Resolves with the photo's Cloudinary public_id, or rejects with a message for the admin. */
  function uploadPhoto(file) {
    if (PHOTO_TYPES.indexOf(file.type) < 0) return Promise.reject(new Error('Photos must be JPEG, PNG, WebP or AVIF.'));
    if (file.size > PHOTO_MAX) {
      return Promise.reject(new Error('That photo is ' + (file.size / 1048576).toFixed(1) + ' MB. Photos must be 5 MB or smaller.'));
    }
    return api('/uploads/sign', { method: 'POST' }).then(function (sig) {
      // Every signed field must be sent exactly as signed, or Cloudinary refuses the upload.
      var form = new FormData();
      Object.keys(sig.fields).forEach(function (k) { form.append(k, sig.fields[k]); });
      form.append('file', file);
      // Plain fetch, not NURA.api: this goes to Cloudinary, not our API (and must not carry our cookies).
      return fetch(sig.uploadUrl, { method: 'POST', body: form, credentials: 'omit' }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok || !d.public_id) {
            throw new Error('The photo upload failed' + (d.error && d.error.message ? ': ' + d.error.message : '. Please try again.'));
          }
          return d.public_id;
        });
      }, function () { throw new Error('Couldn’t reach the photo service. Check your connection and try again.'); });
    });
  }

  // Size presets. The API accepts exactly these names (SIZES in services/admin.js).
  var SIZE_SETS = {
    clothing: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    shoes: ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11'],
    one: ['ONE SIZE'],
  };

  function newProduct() {
    setTab('products');
    if (me.masked) { location.hash = '#products'; return; }   // the API refuses anyway; don't offer it
    api('/brands').then(function (d) {
      main.innerHTML = '<a class="adm-back" href="#products">← Products</a><h1 class="adm-h1" id="admNewTitle" tabindex="-1">Add a product</h1>'
        + '<form class="adm-card adm-form" id="admNew" novalidate>'
        + '<p class="adm-alert" id="admNewErr" role="alert" hidden></p>'
        + '<div class="adm-photo-pick"><div class="adm-preview" id="admPreview"><span>No photo yet</span></div>'
        +   '<div><label class="adm-btn adm-btn--quiet adm-file">Choose a photo'
        +     '<input type="file" id="admPhoto" accept="' + PHOTO_TYPES.join(',') + '" class="adm-file__input" aria-describedby="admPhotoHint"></label>'
        +   '<p class="adm-hint" id="admPhotoHint">JPEG, PNG, WebP or AVIF, up to 5 MB. A tall photo (about 3:4) suits the cards best.</p>'
        +   '<label class="adm-field">Crop on the card' + focusSelect(null, 'name="focus" id="admFocus"') + '</label></div></div>'
        + '<label class="adm-field">Product name<input name="name" id="admName" maxlength="80" required autocomplete="off"></label>'
        + '<label class="adm-field">Brand<input name="brand" id="admBrand" maxlength="40" list="admBrands" required autocomplete="off" aria-describedby="admBrandHint"></label>'
        + '<datalist id="admBrands">' + d.brands.map(function (b) { return '<option value="' + esc(b) + '">'; }).join('') + '</datalist>'
        + '<p class="adm-hint" id="admBrandHint">Pick one from the list, or type a new brand.</p>'
        + '<div class="adm-two"><label class="adm-field">Department<select name="department" id="admDept">'
        +   '<option value="WOMEN">Women</option><option value="MEN">Men</option><option value="UNISEX">Unisex (shows on both)</option></select></label>'
        + '<label class="adm-field">Style<select name="style" id="admStyle"><option value="">None</option>'
        +   '<option>Casual</option><option>Formal</option><option>Streetwear</option><option>Evening</option></select></label></div>'
        + '<div class="adm-two"><label class="adm-field">Price (KSh)<input name="price" id="admPrice" type="number" min="1" step="1" inputmode="numeric" required></label>'
        + '<label class="adm-field">Was (KSh)<input name="was" id="admWas" type="number" min="1" step="1" inputmode="numeric" aria-describedby="admWasHint"></label></div>'
        + '<p class="adm-hint" id="admWasHint">Leave “Was” empty unless it’s on sale. With a “was” price it shows on the Sale page.</p>'
        + '<fieldset class="adm-sizes"><legend>Sizes and stock</legend>'
        +   '<div class="adm-seg">'
        +   [['clothing', 'Clothing'], ['shoes', 'Shoes'], ['one', 'One size']].map(function (o, i) {
              return '<label><input type="radio" name="sizeset" value="' + o[0] + '"' + (i === 0 ? ' checked' : '') + '> ' + o[1] + '</label>';
            }).join('') + '</div>'
        +   '<div class="adm-stock" id="admSizes"></div>'
        +   '<p class="adm-hint">Leave a size empty if you don’t sell it. 0 means sold out.</p></fieldset>'
        + '<label class="adm-field">Description (optional)<textarea name="description" id="admDesc" rows="3" maxlength="1000"></textarea></label>'
        + '<button class="adm-btn" type="submit" id="admNewSave">Add product</button></form>';
      wireNewProduct();
      document.getElementById('admNewTitle').focus();   // a new screen: tell screen readers where they are
    }, failed);
  }

  function wireNewProduct() {
    var form = document.getElementById('admNew'), err = document.getElementById('admNewErr');
    var photo = document.getElementById('admPhoto'), preview = document.getElementById('admPreview');
    var show = function (msg, field) {
      err.textContent = msg; err.hidden = false;
      if (field) field.focus(); else err.scrollIntoView({ block: 'center' });
    };

    function drawSizes() {
      var set = form.querySelector('[name="sizeset"]:checked').value;
      document.getElementById('admSizes').innerHTML = SIZE_SETS[set].map(function (size) {
        return '<label>' + esc(size) + '<input type="number" min="0" max="9999" step="1" inputmode="numeric" data-size="' + esc(size) + '"'
          + (set === 'one' ? ' value="1"' : '') + ' aria-label="Stock in ' + esc(size) + '"></label>';
      }).join('');
    }
    form.querySelectorAll('[name="sizeset"]').forEach(function (r) { r.addEventListener('change', drawSizes); });
    drawSizes();

    photo.addEventListener('change', function () {
      var file = photo.files[0];
      preview.innerHTML = '<span>No photo yet</span>';
      if (!file) return;
      if (PHOTO_TYPES.indexOf(file.type) < 0 || file.size > PHOTO_MAX) {
        // Say so now rather than after they've filled in everything else.
        show(PHOTO_TYPES.indexOf(file.type) < 0 ? 'Photos must be JPEG, PNG, WebP or AVIF.' : 'That photo is over 5 MB. Please choose a smaller one.');
        photo.value = ''; return;
      }
      err.hidden = true;
      // The preview is read from the file itself as a data: address (the security policy allows data: images).
      var reader = new FileReader();
      reader.onload = function () {
        preview.innerHTML = '<img src="' + esc(reader.result) + '" alt="Preview of the chosen photo">';
        preview.querySelector('img').style.objectPosition = { top: '50% 15%', centre: '50% 50%', bottom: '50% 85%' }[form.focus.value];
      };
      reader.readAsDataURL(file);
    });
    // The preview follows the crop choice, so the admin sees what the card will show.
    form.focus.addEventListener('change', function () {
      var img = preview.querySelector('img');
      if (img) img.style.objectPosition = { top: '50% 15%', centre: '50% 50%', bottom: '50% 85%' }[form.focus.value];
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      var file = photo.files[0];
      var price = parseInt(form.price.value, 10), was = form.was.value.trim() ? parseInt(form.was.value, 10) : null;
      var sizes = Array.prototype.filter.call(form.querySelectorAll('[data-size]'), function (i) { return i.value.trim() !== ''; })
        .map(function (i) { return { size: i.dataset.size, stock: parseInt(i.value, 10) }; });
      // The same rules as the API, checked first so the photo isn't uploaded for a form that will be refused.
      if (!file) return show('Choose a photo for the product.', photo);
      if (form.name.value.trim().length < 2) return show('Enter a product name.', form.name);
      if (!form.brand.value.trim()) return show('Enter a brand.', form.brand);
      if (!(price > 0)) return show('Enter a price in whole shillings.', form.price);
      if (was !== null && !(was > price)) return show('The “was” price must be higher than the price, or empty.', form.was);
      if (!sizes.length) return show('Enter stock for at least one size.', form.querySelector('[data-size]'));
      if (sizes.some(function (s) { return !(s.stock >= 0 && s.stock <= 9999); })) return show('Stock is a whole number from 0 to 9999.');

      var btn = document.getElementById('admNewSave');
      btn.disabled = true; btn.textContent = 'Uploading photo…';
      uploadPhoto(file).then(function (publicId) {
        btn.textContent = 'Saving…';
        return api('/products', { method: 'POST', body: {
          name: form.name.value.trim(), brand: form.brand.value.trim(), department: form.department.value,
          style: form.style.value || null, priceKes: price, compareAtKes: was, sizes: sizes,
          description: form.description.value.trim() || undefined,
          image: { publicId: publicId }, imageFocus: form.focus.value,
        } });
      }).then(function (d) {
        toast('Added ' + form.name.value.trim() + ' (' + d.product.sku + '). It’s on the shop now.');
        location.hash = '#products';
      }, function (e2) {
        show(e2.message);
        btn.disabled = false; btn.textContent = 'Add product';
      });
    });
  }


  /* ── Customers and the newsletter ───────────────────────────────────────────────── */
  var NEWS = { confirmed: 'Subscribed', pending: 'Not confirmed', unsubscribed: 'Unsubscribed', none: '' };

  function customers(query) {
    setTab('customers');
    var q = query.q || '', page = Math.max(1, parseInt(query.page, 10) || 1);
    var params = ['page=' + page].concat(q ? ['q=' + encodeURIComponent(q)] : []);
    api('/customers?' + params.join('&')).then(function (d) {
      var n = d.newsletter;
      main.innerHTML = '<h1 class="adm-h1">Customers</h1>'
        + '<section class="adm-card adm-news" aria-labelledby="admNewsH"><h2 class="adm-news__h" id="admNewsH">Newsletter</h2>'
        +   '<p><strong>' + n.confirmed + '</strong> subscribed · ' + n.pending + ' waiting to confirm · ' + n.unsubscribed + ' unsubscribed</p>'
        +   '<p class="adm-hint">Only people who clicked the link in the confirmation email are subscribed, and only they are in the download.</p>'
        +   (me.masked ? '<p class="adm-notice">Demo: the subscriber list can’t be downloaded.</p>'
              // A plain link: the browser downloads it with the admin's session cookie, as a file.
              : '<a class="adm-btn adm-btn--small" href="/api/admin/newsletter.csv" download>Download subscribers (CSV)</a>')
        + '</section>'
        + '<form class="adm-search" id="admCSearch" role="search"><label class="sr-only" for="admCQ">Search customers</label>'
        +   '<input class="auth-input" id="admCQ" type="search" placeholder="' + (me.masked ? 'Name' : 'Name or email') + '" value="' + esc(q) + '">'
        +   '<button class="adm-btn" type="submit">Search</button></form>'
        + '<p class="adm-muted" style="margin-bottom:10px;">' + d.total + ' account' + (d.total === 1 ? '' : 's') + (q ? ' found' : '')
        +   '. Guests who checked out without an account are under Orders.</p>'
        + (d.customers.length ? '<ul class="adm-customers">' + d.customers.map(function (c) {
            var orders = c.orderCount + ' order' + (c.orderCount === 1 ? '' : 's');
            return '<li class="adm-customer"><div><p class="adm-product__name">' + esc(c.name) + '</p>'
              + '<p class="adm-muted">' + esc(c.email) + '</p></div>'
              + (NEWS[c.newsletter] ? '<span class="adm-pill adm-pill--nl-' + esc(c.newsletter) + '">' + NEWS[c.newsletter] + '</span>' : '<span></span>')
              + '<p class="adm-customer__meta">'
              // Not for the demo: its emails are masked, so the order search would find nothing.
              + (c.orderCount && !me.masked ? '<a href="#orders?status=&q=' + encodeURIComponent(c.email) + '">' + orders + '</a>' : orders)
              + ' · ' + esc(ksh(c.spentKes)) + ' paid'
              + (c.lastOrderAt ? ' · last ' + esc(ago(c.lastOrderAt)) : '')
              + ' · joined ' + esc(new Date(c.memberSince).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })) + '</p></li>';
          }).join('') + '</ul>' : '<p class="adm-muted">No customers here.</p>')
        + (d.total > page * 50 || page > 1 ? '<nav class="adm-pager" aria-label="Pages">'
            + (page > 1 ? '<a class="adm-chip" href="#customers?page=' + (page - 1) + (q ? '&q=' + encodeURIComponent(q) : '') + '">← Newer</a>' : '<span></span>')
            + (d.total > page * 50 ? '<a class="adm-chip" href="#customers?page=' + (page + 1) + (q ? '&q=' + encodeURIComponent(q) : '') + '">Older →</a>' : '')
            + '</nav>' : '');
      document.getElementById('admCSearch').addEventListener('submit', function (e) {
        e.preventDefault();
        location.hash = '#customers?q=' + encodeURIComponent(document.getElementById('admCQ').value.trim());
      });
    }, failed);
  }

  function activityScreen() {
    setTab('activity');
    api('/activity').then(function (d) {
      var line = function (a) {
        var b = a.before || {}, f = a.after || {};
        var what = Object.keys(f).map(function (k) { return k + ': ' + JSON.stringify(b[k]) + ' → ' + JSON.stringify(f[k]); }).join(', ');
        return '<div class="adm-log"><strong>' + esc(a.action) + '</strong> · ' + esc(what)
          + (b.sku ? ' <span class="adm-muted">(' + esc(b.sku) + ' ' + esc(b.size || '') + ')</span>' : '')
          + (a.entity === 'order' ? ' · <a href="#order/' + esc(a.entityId) + '">open order</a>' : '')
          + '<small>' + esc(a.by) + ' · ' + esc(when(a.at)) + '</small></div>';
      };
      main.innerHTML = '<h1 class="adm-h1">Activity</h1><p class="adm-muted" style="margin-bottom:14px;">Every change made in the admin: who, what, before and after.</p>'
        + (d.activity.length ? d.activity.map(line).join('') : '<p class="adm-muted">Nothing yet.</p>');
    }, failed);
  }

  /* ── Insights (Oct 2026): read-only, from /api/admin/insights ─────────────────────
     Charts are plain HTML (no chart library: the CSP allows only this site's own scripts,
     and a library would outweigh the page). Colours: the three payment methods use the first
     three slots of a palette checked for colour-blind separation; the legend names them, the
     tooltip and the table carry every number, so colour is never the only way to tell. */
  var METHODS = [['MPESA', 'M-Pesa'], ['CARD', 'Card'], ['COD', 'Cash on delivery']];

  function insightsScreen() {
    setTab('insights');
    api('/insights').then(drawInsights, failed);
  }

  function drawInsights(s) {
    var tile = function (v, label) { return '<div class="adm-tile"><strong>' + esc(v) + '</strong><span>' + esc(label) + '</span></div>'; };
    var short = function (d) { return new Date(d + 'T12:00:00Z').toLocaleString('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
    var total = function (d) { return d.MPESA + d.CARD + d.COD; };
    var max = Math.max.apply(null, s.daily.map(total));
    // A clean top for the axis: 1, 2 or 5 × a power of ten, at or above the busiest day.
    var step = Math.pow(10, Math.floor(Math.log10(Math.max(max, 1))));
    var top = [1, 2, 5, 10].map(function (m) { return m * step; }).filter(function (t) { return t >= max; })[0] || step * 10;
    var ticks = [0, top / 2, top];

    var chart = '<div class="ins-legend">' + METHODS.map(function (m) {
        return '<span><i class="ins-key ins-key--' + m[0] + '"></i>' + m[1] + '</span>';
      }).join('') + '</div>'
      + '<div class="ins-chart" role="img" aria-label="Takings per day for the last ' + s.days + ' days, by payment method. The table below has every figure.">'
      + '<div class="ins-grid">' + ticks.slice().reverse().map(function (t) {
          return '<div class="ins-tick"><span>' + (t >= 1000 ? (t / 1000) + 'k' : t) + '</span></div>';
        }).join('') + '</div>'
      + '<div class="ins-cols">' + s.daily.map(function (d, i) {
          var t = total(d);
          // Segments bottom-up: M-Pesa, card, cash. Heights are shares of the axis top.
          var segs = METHODS.map(function (m) { return d[m[0]] ? '<i class="ins-seg ins-seg--' + m[0] + '" style="height:' + (d[m[0]] / top * 100) + '%"></i>' : ''; }).join('');
          var label = i % 7 === 2 || i === s.daily.length - 1 ? '<span class="ins-x">' + esc(short(d.day)) + '</span>' : '';
          return '<div class="ins-col" data-i="' + i + '"><div class="ins-stack">' + segs + '</div>' + label + '</div>';
        }).join('') + '</div>'
      + '<div class="ins-tip" id="insTip" hidden></div></div>'
      + '<details class="adm-desc"><summary>Show as a table</summary><table class="ins-table"><thead><tr><th>Day</th>'
      + METHODS.map(function (m) { return '<th>' + m[1] + '</th>'; }).join('') + '<th>Total</th></tr></thead><tbody>'
      + s.daily.slice().reverse().map(function (d) {
          return '<tr><td>' + esc(short(d.day)) + '</td>' + METHODS.map(function (m) { return '<td>' + esc(ksh(d[m[0]])) + '</td>'; }).join('') + '<td><strong>' + esc(ksh(total(d))) + '</strong></td></tr>';
        }).join('') + '</tbody></table></details>';

    var best = s.bestSellers.length ? (function () {
      var most = s.bestSellers[0].units;
      return s.bestSellers.map(function (b) {
        return '<div class="ins-row"><div class="ins-row__name">' + esc(b.name) + '<small>' + esc(ksh(b.revenueKes)) + ' · ' + (b.stockLeft ? b.stockLeft + ' left' : '<strong class="ins-out">sold out</strong>') + '</small></div>'
          + '<div class="ins-bar"><i style="width:' + (b.units / most * 100) + '%"></i></div><span class="ins-row__val">' + b.units + ' sold</span></div>';
      }).join('');
    })() : '<p class="adm-muted">No sales in the last ' + s.days + ' days yet.</p>';

    var wanted = function (list, empty) {
      return list.length ? list.map(function (w) {
        return '<div class="adm-log">' + esc(w.name) + ' · <strong>' + w.wants + ' ♥</strong>'
          + (w.stock ? ' <span class="adm-muted">(' + w.stock + ' in stock)</span>' : ' <span class="ins-out">sold out</span> · <a href="#products?q=' + encodeURIComponent(w.sku) + '">restock →</a>') + '</div>';
      }).join('') : '<p class="adm-muted">' + empty + '</p>';
    };

    main.innerHTML = '<h1 class="adm-h1">Insights</h1><p class="adm-muted" style="margin-bottom:14px;">The last ' + s.days + ' days, Nairobi time.</p>'
      + '<div class="adm-tiles adm-tiles--money">'
      + tile(ksh(s.takingsKes), 'Taken') + tile(s.orderCount, 'Paid orders') + tile(ksh(s.averageOrderKes), 'Average order')
      + tile(ksh(s.abandoned.valueKes), s.abandoned.carts + ' cart' + (s.abandoned.carts === 1 ? '' : 's') + ' left behind')
      + '</div>'
      + '<h2 class="adm-h2">Takings by day</h2><div class="adm-card">' + chart + '</div>'
      + '<p class="adm-muted" style="margin:-4px 0 14px;">Money that is in: M-Pesa and card once paid, cash once delivered.</p>'
      + '<h2 class="adm-h2">Best sellers</h2><div class="adm-card">' + best + '</div>'
      + '<h2 class="adm-h2">Wanted but sold out</h2>'
      + wanted(s.wantedSoldOut, 'Nothing anyone wants is sold out.')
      + '<h2 class="adm-h2">Most wanted</h2>'
      + wanted(s.mostWanted, 'No hearts yet.')
      + '<p class="adm-muted" style="margin-top:8px;">Hearts from signed-in shoppers only: a guest’s wishlist stays in their own browser, so real demand is higher.</p>';

    // Tooltip: hover with a mouse, tap on a phone. Each day's figures, in text tokens.
    var tip = document.getElementById('insTip'), cols = main.querySelector('.ins-cols');
    function showTip(col) {
      var d = s.daily[+col.dataset.i];
      tip.innerHTML = '<strong>' + esc(short(d.day)) + ': ' + esc(ksh(total(d))) + '</strong>'
        + METHODS.map(function (m) { return '<span><i class="ins-key ins-key--' + m[0] + '"></i>' + m[1] + ' ' + esc(ksh(d[m[0]])) + '</span>'; }).join('');
      tip.hidden = false;
      var box = cols.getBoundingClientRect(), c = col.getBoundingClientRect();
      var x = c.left - box.left + c.width / 2;
      tip.style.left = Math.min(Math.max(x, 80), box.width - 80) + 'px';
      cols.querySelectorAll('.ins-col.is-on').forEach(function (o) { o.classList.remove('is-on'); });
      col.classList.add('is-on');
    }
    cols.addEventListener('pointerover', function (e) { var c = e.target.closest('.ins-col'); if (c) showTip(c); });
    cols.addEventListener('click', function (e) { var c = e.target.closest('.ins-col'); if (c) showTip(c); });
    cols.addEventListener('pointerleave', function (e) {
      if (e.pointerType === 'mouse') { tip.hidden = true; cols.querySelectorAll('.is-on').forEach(function (o) { o.classList.remove('is-on'); }); }
    });
  }

  /* ── Bulk stock (Oct 2026): download the sheet, change numbers, upload, check, apply ── */
  function stockScreen() {
    setTab('products');
    main.innerHTML = '<a class="adm-back" href="#products">← Products</a><h1 class="adm-h1">Bulk stock</h1>'
      + '<ol class="ins-steps">'
      + '<li><a class="adm-btn adm-btn--quiet adm-btn--small" href="/api/admin/stock.csv" download>Download the stock sheet</a> <span class="adm-muted">every size of every product, as a spreadsheet</span></li>'
      + '<li>Change the numbers in the <strong>stock</strong> column. You can delete rows you aren’t changing; leave the sku, size and stock columns as they are.</li>'
      + '<li>' + (me.masked ? '<span class="adm-muted">Demo: uploading is switched off.</span>'
          : '<label class="adm-btn adm-btn--small adm-file">Upload the sheet<input type="file" accept=".csv,text/csv" class="adm-file__input" id="stockFile"></label>')
      + ' <span class="adm-muted">Nothing changes yet: you’ll see exactly what will, first.</span></li></ol>'
      + '<div id="stockResult"></div>';
    if (me.masked) return;
    var file = document.getElementById('stockFile'), out = document.getElementById('stockResult');
    var rows = null;
    file.addEventListener('change', function () {
      var f = file.files[0];
      if (!f) return;
      f.text().then(function (text) {
        try { rows = parseStockCsv(text); } catch (err) { out.innerHTML = '<p class="adm-alert">' + esc(err.message) + '</p>'; file.value = ''; return; }
        return api('/stock/bulk', { method: 'POST', body: { rows: rows, apply: false } }).then(showCheck);
      }).catch(failed).finally(function () { file.value = ''; });
    });
    function showCheck(r) {
      if (r.errors.length) {
        out.innerHTML = '<p class="adm-alert">The sheet has ' + r.errors.length + ' problem' + (r.errors.length === 1 ? '' : 's') + '. Nothing was changed. Fix ' + (r.errors.length === 1 ? 'it' : 'them') + ' and upload again.</p>'
          + r.errors.map(function (e) { return '<div class="adm-log">' + esc(e) + '</div>'; }).join('');
        return;
      }
      if (!r.changes.length) { out.innerHTML = '<p class="adm-notice">Every number matches the shop already: nothing to change.</p>'; return; }
      out.innerHTML = '<h2 class="adm-h2">' + r.changes.length + ' change' + (r.changes.length === 1 ? '' : 's') + '</h2>'
        + '<p class="adm-muted" style="margin-bottom:8px;">' + r.unchanged + ' other row' + (r.unchanged === 1 ? '' : 's') + ' already match.</p>'
        + '<table class="ins-table"><thead><tr><th>Product</th><th>Size</th><th>Now</th><th>New</th></tr></thead><tbody>'
        + r.changes.map(function (c) {
            return '<tr><td>' + esc(c.name) + ' <span class="adm-muted">' + esc(c.sku) + '</span></td><td>' + esc(c.size) + '</td><td>' + c.from + '</td><td><strong>' + c.to + '</strong></td></tr>';
          }).join('') + '</tbody></table>'
        + '<button class="adm-btn" id="stockApply" style="margin-top:12px;">Apply ' + r.changes.length + ' change' + (r.changes.length === 1 ? '' : 's') + '</button>';
      var btn = document.getElementById('stockApply');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        api('/stock/bulk', { method: 'POST', body: { rows: rows, apply: true } }).then(function (done) {
          if (!done.applied) return showCheck(done);              // something changed since the check
          out.innerHTML = '<p class="adm-notice">Done: ' + done.changes.length + ' size' + (done.changes.length === 1 ? '' : 's') + ' updated. Each one is in Activity.</p>';
          toast('Stock updated');
        }, function (err) { btn.disabled = false; failed(err); });
      });
    }
  }

  /** The stock sheet → [{ sku, size, stock }]. Handles quoted cells, as spreadsheets write them. */
  function parseStockCsv(text) {
    var lines = [], row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');                       // Excel's byte-order mark
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); lines.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); lines.push(row); }
    lines = lines.filter(function (l) { return l.some(function (c) { return c.trim(); }); });
    var head = (lines.shift() || []).map(function (h) { return h.trim().toLowerCase(); });
    var at = { sku: head.indexOf('sku'), size: head.indexOf('size'), stock: head.indexOf('stock') };
    if (at.sku < 0 || at.size < 0 || at.stock < 0) throw new Error('This doesn’t look like the stock sheet: it needs sku, size and stock columns. Download it again from step 1.');
    if (!lines.length) throw new Error('The sheet has no rows.');
    return lines.map(function (l, n) {
      var v = (l[at.stock] || '').trim();
      if (!/^\d+$/.test(v)) throw new Error('Row ' + (n + 2) + ': stock “' + v + '” isn’t a whole number of 0 or more.');
      return { sku: (l[at.sku] || '').trim(), size: (l[at.size] || '').trim(), stock: parseInt(v, 10) };
    });
  }

  /* ── Router: #screen?key=value ───────────────────────────────────────────────── */
  function route() {
    if (!me || me.needsTotp) return;
    var h = location.hash.replace(/^#/, ''), path = h.split('?')[0], query = {};
    (h.split('?')[1] || '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('='); query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    window.scrollTo(0, 0);
    if (path.indexOf('order/') === 0) return order(path.slice(6));
    if (path === 'orders') return orders(query);
    if (path === 'products') return products(query);
    if (path === 'stock') return stockScreen();
    if (path === 'insights') return insightsScreen();
    if (path === 'product/new') return newProduct();
    if (path === 'customers') return customers(query);
    if (path === 'activity') return activityScreen();
    return dashboard();
  }
  window.addEventListener('hashchange', route);
  start();
})();
