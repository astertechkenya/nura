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
        + tile(s.flaggedPayments, 'Payments to check', '#orders', 'is-bad')
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
    ['SHIPPED', 'Shipped'], ['DELIVERED', 'Delivered'], ['REFUND_DUE', 'Refunds'], ['', 'All']];

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

  function drawOrder(o) {
    var c = o.customer, dl = o.delivery;
    var items = o.items.map(function (i) {
      return '<div class="adm-item">' + (i.imageUrl ? '<img src="../' + esc(i.imageUrl) + '" alt="">' : '<span class="adm-ph"></span>')
        + '<span>' + esc(i.name) + '<br><span class="adm-muted">' + (i.size !== 'ONE SIZE' ? 'Size ' + esc(i.size) + ' · ' : '') + 'Qty ' + Number(i.qty) + '</span></span>'
        + '<strong>' + esc(ksh(i.lineTotalKes)) + '</strong></div>';
    }).join('');
    var pays = o.payments.map(function (p) {
      return '<li><span><strong>' + esc(METHOD[{ COD: 'COD', DARAJA: 'MPESA', PAYSTACK: 'CARD' }[p.provider]] || p.provider) + ' · ' + esc(p.status) + '</strong> '
        + esc(ksh(p.amountKes)) + (p.receipt ? ' · ' + esc(p.receipt) : '')
        + (p.failureReason ? '<small>' + esc(p.failureReason) + '</small>' : '') + '<small>' + esc(when(p.createdAt)) + '</small></span></li>';
    }).join('');
    var events = o.events.map(function (e) {
      return '<li><span><strong>' + esc(STATUS[e.to] || e.to) + '</strong>' + (e.note ? ' · ' + esc(e.note) : '')
        + '<small>' + esc(when(e.at)) + (e.by ? ' · ' + esc(e.by) : '') + '</small></span></li>';
    }).join('');
    var EMAIL = { received: 'Order received', confirmed: 'Payment confirmed', shipped: 'On its way' };
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

  function products() {
    setTab('products');
    api('/products').then(function (d) { drawProducts(d.products); }, failed);
  }

  function drawProducts(list) {
    var off = me.masked ? ' disabled' : '';
    main.innerHTML = '<h1 class="adm-h1">Products</h1>'
      + (me.masked ? '<p class="adm-notice">Demo: you can look, but prices and stock can’t be changed.</p>'
                   : '<p class="adm-muted" style="margin-bottom:14px;">Stock saves as soon as you leave the box. Prices save with the button.</p>')
      + list.map(function (p) {
        return '<article class="adm-product' + (p.isActive ? '' : ' is-hidden') + '" data-id="' + esc(p.id) + '">'
          + '<div class="adm-product__head">' + (p.imageUrl ? '<img src="../' + esc(p.imageUrl) + '" alt="">' : '<span class="adm-ph"></span>')
          + '<div><p class="adm-product__name">' + esc(p.name) + '</p><p class="adm-muted">' + esc(p.brand) + ' · ' + esc(p.sku) + '</p></div>'
          + '<label class="adm-toggle"><input type="checkbox" data-visible' + (p.isActive ? ' checked' : '') + off + '> Shown in shop</label></div>'
          + '<form class="adm-prices" data-prices novalidate>'
          + '<label class="adm-field">Price (KSh)<input type="number" min="1" step="1" inputmode="numeric" name="price" value="' + Number(p.priceKes) + '"' + off + '></label>'
          + '<label class="adm-field">Was (KSh)<input type="number" min="1" step="1" inputmode="numeric" name="was" aria-describedby="wasHint-' + esc(p.id) + '" value="' + (p.compareAtKes || '') + '"' + off + '></label>'
          + '<button class="adm-btn" type="submit"' + off + '>Save</button>'
          + '<span class="adm-hint" id="wasHint-' + esc(p.id) + '">Leave “Was” empty when it isn’t on sale.</span></form>'
          + '<div class="adm-stock">' + p.variants.map(function (v) {
            var cls = v.stock === 0 ? 'is-out' : v.stock <= 3 ? 'is-low' : '';
            return '<label>' + esc(v.size) + '<input type="number" min="0" max="9999" step="1" inputmode="numeric" class="' + cls + '" data-variant="' + esc(v.id)
              + '" data-was="' + Number(v.stock) + '" value="' + Number(v.stock) + '" aria-label="Stock, ' + esc(p.name) + ' ' + esc(v.size) + '"' + off + '></label>';
          }).join('') + '</div></article>';
      }).join('');
    if (me.masked) return;

    main.querySelectorAll('[data-prices]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var id = form.closest('[data-id]').dataset.id;
        var price = parseInt(form.price.value, 10), was = form.was.value.trim() ? parseInt(form.was.value, 10) : null;
        if (!(price > 0)) { toast('Enter a price in whole shillings.'); return; }
        api('/products/' + id, { method: 'PATCH', body: { priceKes: price, compareAtKes: was } })
          .then(function () { toast('Saved: ' + ksh(price) + (was ? ', was ' + ksh(was) : '')); }, failed);
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
    if (path === 'products') return products();
    if (path === 'activity') return activityScreen();
    return dashboard();
  }
  window.addEventListener('hashchange', route);
  start();
})();
