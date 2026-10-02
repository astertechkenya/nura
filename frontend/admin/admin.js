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
  var imgSrc = function (u) { return /^https:\/\//.test(u) ? u : '../' + u; };

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
      return '<div class="adm-item">' + (i.imageUrl ? '<img src="' + esc(imgSrc(i.imageUrl)) + '" alt="">' : '<span class="adm-ph"></span>')
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
    var EMAIL = { received: 'Order received', confirmed: 'Payment confirmed', shipped: 'On its way', delivered: 'Delivered',
                  cancelled: 'Cancelled', expired: 'Not completed (expired)', refund_due: 'Refund due (late payment)', refunded: 'Refund sent' };
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
    main.innerHTML = '<div class="adm-titlebar"><h1 class="adm-h1">Products</h1>'
      + (me.masked ? '' : '<a class="adm-btn adm-btn--small" href="#product/new">+ Add a product</a>') + '</div>'
      + (me.masked ? '<p class="adm-notice">Demo: you can look, but prices and stock can’t be changed.</p>'
                   : '<p class="adm-muted" style="margin-bottom:14px;">Stock saves as soon as you leave the box. Prices save with the button.</p>')
      + list.map(function (p) {
        return '<article class="adm-product' + (p.isActive ? '' : ' is-hidden') + '" data-id="' + esc(p.id) + '">'
          + '<div class="adm-product__head">' + (p.imageUrl ? '<img src="' + esc(imgSrc(p.imageUrl)) + '" alt="">' : '<span class="adm-ph"></span>')
          + '<div><p class="adm-product__name">' + esc(p.name) + '</p><p class="adm-muted">' + esc(p.brand) + ' · ' + esc(p.sku) + '</p></div>'
          + '<label class="adm-toggle"><input type="checkbox" data-visible' + (p.isActive ? ' checked' : '') + off + '> Shown in shop</label></div>'
          + (me.masked ? '' : '<div class="adm-photo-row"><label class="adm-btn adm-btn--quiet adm-btn--small adm-file">Change photo'
            + '<input type="file" accept="' + PHOTO_TYPES.join(',') + '" data-photo class="adm-file__input" aria-label="Change photo of ' + esc(p.name) + '"></label>'
            + '<label class="adm-field adm-field--inline">Crop' + focusSelect(p.imageFocus, 'data-focus aria-label="Crop of ' + esc(p.name) + ' on the card"') + '</label></div>')
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
    main.querySelectorAll('[data-photo]').forEach(function (input) {
      input.addEventListener('change', function () {
        var card = input.closest('[data-id]'), file = input.files[0];
        if (!file) return;
        toast('Uploading photo…');
        uploadPhoto(file).then(function (publicId) {
          return api('/products/' + card.dataset.id + '/image', { method: 'PUT', body: { publicId: publicId } });
        }).then(function (d) { drawProducts(d.products); toast('Photo changed'); }, function (err) { input.value = ''; failed(err); });
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
    if (path === 'product/new') return newProduct();
    if (path === 'activity') return activityScreen();
    return dashboard();
  }
  window.addEventListener('hashchange', route);
  start();
})();
