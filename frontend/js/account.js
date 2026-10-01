/* NURA account.js: the account page (account.html), Phase 7.6.

   Everything here comes from the API and belongs to the signed-in shopper only:
     GET  /api/account            name, email, member since, details from the latest order
     GET  /api/orders             order history (each links to order-confirmed.html#<id>)
     POST /api/account/password   change password (other devices are signed out)
     POST /api/account/delete     delete the account (orders are kept, unlinked)
   Signed out, the page says so and links to the sign-in form; it never shows a blank shell. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var main = document.getElementById('acMain');

  // How each status reads to a shopper (the admin uses its own, more operational words).
  var STATUS = {
    PENDING_PAYMENT: 'Awaiting payment', AWAITING_COD: 'Order received', PAID: 'Paid', PROCESSING: 'Being packed',
    SHIPPED: 'On its way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', EXPIRED: 'Not completed'
  };
  var date = function (d, opts) { return new Date(d).toLocaleDateString('en-KE', opts || { day: 'numeric', month: 'short', year: 'numeric' }); };
  var localPhone = function (p) {
    var m = String(p || '').match(/^254(\d{3})(\d{3})(\d{3})$/);
    return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : p;
  };

  function signedOut() {
    main.innerHTML = '<section class="oc-card"><h1 class="co-title" id="acTitle" tabindex="-1" style="font-size:36px;">Sign in to see your account</h1>'
      + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Your orders, delivery details and password settings are here once you’re signed in.</p>'
      + '<a class="co-link" href="index.html#sign-in">Sign in &rarr;</a></section>';
  }

  function ordersCard(orders) {
    if (!orders.length) {
      return '<section class="oc-card" aria-labelledby="acOrders"><h2 id="acOrders">Your orders</h2>'
        + '<p class="co-hint" style="font-size:13px;">No orders yet.</p><a class="co-link" href="new-in.html">See what’s new &rarr;</a></section>';
    }
    return '<section class="oc-card" aria-labelledby="acOrders"><h2 id="acOrders">Your orders</h2><ul class="ac-orders">'
      + orders.map(function (o) {
        return '<li><a class="ac-order" href="order-confirmed.html#' + esc(o.id) + '">'
          + '<span class="ac-order__main"><strong>' + esc(o.number) + '</strong><span class="co-hint">' + esc(date(o.placedAt))
          + ' · ' + Number(o.itemCount) + ' item' + (o.itemCount === 1 ? '' : 's') + '</span></span>'
          + '<span class="ac-order__side"><span class="ac-status ac-status--' + esc(o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span>'
          + '<span>' + NURA.fmtKsh(o.totalKes) + '</span></span></a></li>';
      }).join('') + '</ul></section>';
  }

  function deliveryCard(last) {
    var body = last
      ? '<address class="oc-address">' + esc(last.name) + '<br>' + esc(localPhone(last.phone)) + '<br>' + esc(last.addressLine1)
        + '<br>' + esc(last.area) + ', ' + esc(last.county) + '</address>'
        + '<p class="co-hint" style="margin-top:10px;">From your latest order. Checkout fills these in for you; type new ones there to change them.</p>'
      : '<p class="co-hint" style="font-size:13px;">After your first order, its delivery details appear here and are filled in for you at checkout.</p>';
    return '<section class="oc-card" aria-labelledby="acDelivery"><h2 id="acDelivery">Delivery details</h2>' + body + '</section>';
  }

  function field(id, label, type, autocomplete, hint) {
    return '<div class="auth-field"><label class="auth-label" for="' + id + '">' + label + '</label>'
      + '<input class="auth-input" type="' + type + '" id="' + id + '" autocomplete="' + autocomplete + '" required maxlength="128"'
      + (hint ? ' aria-describedby="' + id + 'Hint"' : '') + '>'
      + (hint ? '<span class="co-hint" id="' + id + 'Hint">' + hint + '</span>' : '') + '</div>';
  }

  function passwordCard() {
    return '<section class="oc-card" aria-labelledby="acPw"><h2 id="acPw">Change password</h2>'
      + '<form class="ac-form" id="acPwForm" novalidate>'
      + field('acPwCurrent', 'Current password', 'password', 'current-password')
      + field('acPwNew', 'New password', 'password', 'new-password', 'At least 8 characters. Your other devices will be signed out.')
      + '<p class="ac-msg" id="acPwMsg" role="status"></p>'
      + '<button class="auth-submit" type="submit">Change password</button></form></section>';
  }

  function deleteCard() {
    return '<section class="oc-card ac-danger" aria-labelledby="acDel"><h2 id="acDel">Delete account</h2>'
      + '<p class="oc-address">This deletes your login, saved cart, wishlist and newsletter subscription. Records of past orders are kept for our accounts and refunds, no longer linked to an account. It can’t be undone.</p>'
      + '<button class="ac-danger__start" type="button" id="acDelStart" aria-expanded="false" aria-controls="acDelForm">Delete my account…</button>'
      + '<form class="ac-form" id="acDelForm" novalidate hidden>'
      + field('acDelPw', 'Enter your password to confirm', 'password', 'current-password')
      + '<p class="ac-msg" id="acDelMsg" role="status"></p>'
      + '<button class="auth-submit ac-danger__confirm" type="submit">Delete my account for good</button></form></section>';
  }

  function show(account, orders) {
    var u = account.user;
    main.innerHTML =
        '<section class="oc-hero"><p class="oc-hero__kicker">Your account</p>'
      + '<h1 tabindex="-1" id="acTitle">Hi, ' + esc(u.name.split(/\s+/)[0]) + '</h1>'
      + '<p>' + esc(u.email) + ' · member since ' + esc(date(u.memberSince, { month: 'long', year: 'numeric' })) + '</p>'
      + '<button class="ac-signout" type="button" id="acSignOut">Sign out</button></section>'
      + ordersCard(orders)
      + '<div class="oc-cols">' + deliveryCard(account.lastDelivery) + passwordCard() + '</div>'
      + deleteCard();
    wire();
  }

  function message(id, text, ok) {
    var el = document.getElementById(id);
    el.textContent = text;
    el.classList.toggle('is-ok', Boolean(ok));
  }

  function wire() {
    document.getElementById('acSignOut').addEventListener('click', function () {
      NURA.api('/auth/logout', { method: 'POST' }).finally(function () { location.href = 'index.html'; });
    });

    var pw = document.getElementById('acPwForm');
    pw.addEventListener('submit', function (e) {
      e.preventDefault();
      var cur = document.getElementById('acPwCurrent'), nxt = document.getElementById('acPwNew');
      if (!cur.value) { message('acPwMsg', 'Please enter your current password.'); cur.focus(); return; }
      if (nxt.value.length < 8) { message('acPwMsg', 'Your new password needs at least 8 characters.'); nxt.focus(); return; }
      var btn = pw.querySelector('button'); btn.disabled = true;
      NURA.api('/account/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nxt.value } })
        .then(function () {
          cur.value = ''; nxt.value = '';
          message('acPwMsg', 'Password changed. Your other devices have been signed out.', true);
        }, function (err) { message('acPwMsg', err.message); })
        .finally(function () { btn.disabled = false; });
    });

    // Two steps on purpose: one button reveals the form, a second (with the password) deletes.
    var start = document.getElementById('acDelStart'), del = document.getElementById('acDelForm');
    start.addEventListener('click', function () {
      del.hidden = false; start.hidden = true; start.setAttribute('aria-expanded', 'true');
      document.getElementById('acDelPw').focus();
    });
    del.addEventListener('submit', function (e) {
      e.preventDefault();
      var p = document.getElementById('acDelPw');
      if (!p.value) { message('acDelMsg', 'Please enter your password.'); p.focus(); return; }
      var btn = del.querySelector('button'); btn.disabled = true;
      NURA.api('/account/delete', { method: 'POST', body: { password: p.value } }).then(function () {
        main.innerHTML = '<section class="oc-card"><h1 class="co-title" id="acTitle" tabindex="-1" style="font-size:36px;">Your account has been deleted</h1>'
          + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Thank you for shopping with NURA. You’re welcome back any time.</p>'
          + '<a class="co-link" href="index.html">Back to the shop &rarr;</a></section>';
        document.getElementById('acTitle').focus();
      }, function (err) {
        message('acDelMsg', err.message);
        btn.disabled = false;
      });
    });
  }

  Promise.all([NURA.api('/account'), NURA.api('/orders')]).then(function (r) {
    show(r[0], r[1].orders);
    document.title = 'Your account — NURA';
  }, function (err) {
    if (err.status === 401) signedOut();
    else main.innerHTML = '<section class="oc-card"><p role="alert">' + esc(err.message) + '</p></section>';
  });
})();
