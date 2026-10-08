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

  // Folded away until clicked (Oct 2026): a native <details>, so it opens with a click, a tap,
  // Enter or Space, and screen readers announce it as expanded or collapsed with no extra code.
  function passwordCard() {
    return '<section class="oc-card ac-fold-card"><details class="ac-fold" id="acPwFold"><summary><h2 id="acPw">Change password</h2>'
      + '<svg class="ac-fold__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></summary>'
      + '<form class="ac-form" id="acPwForm" novalidate>'
      + field('acPwCurrent', 'Current password', 'password', 'current-password')
      + field('acPwNew', 'New password', 'password', 'new-password', 'At least 8 characters. Your other devices will be signed out.')
      + '<p class="ac-msg" id="acPwMsg" role="status"></p>'
      + '<button class="auth-submit" type="submit">Change password</button></form></details></section>';
  }

  function deleteCard() {
    return '<section class="oc-card ac-danger" aria-labelledby="acDel"><h2 id="acDel">Delete account</h2>'
      + '<p class="oc-address">This deletes your login, saved cart, wishlist and newsletter subscription. Records of past orders are kept for our accounts and refunds, no longer linked to an account. It can’t be undone.</p>'
      + '<button class="ac-danger__start" type="button" id="acDelStart" aria-haspopup="dialog">Delete account</button></section>';
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

    // Delete account: the button opens "Are you sure?" (NURA.confirmDialog in ui.js), which also
    // asks for the password. Nothing is deleted until both are given. A wrong password shows
    // its message inside the box, which stays open.
    document.getElementById('acDelStart').addEventListener('click', function () {
      NURA.confirmDialog({
        title: 'Delete your account?',
        text: 'Are you sure you want to delete your account? Your login, saved cart, wishlist and newsletter subscription go for good. Records of past orders are kept, no longer linked to you. This can’t be undone.',
        password: 'Enter your password to confirm',
        confirm: 'Delete account',
        onConfirm: function (password) {
          return NURA.api('/account/delete', { method: 'POST', body: { password: password } }).then(function () {
            main.innerHTML = '<section class="oc-card"><h1 class="co-title" id="acTitle" tabindex="-1" style="font-size:36px;">Your account has been deleted</h1>'
              + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Thank you for shopping with NURA. You’re welcome back any time.</p>'
              + '<a class="nura-continue co-continue" href="index.html">Continue shopping <span aria-hidden="true">&rarr;</span></a></section>';
            setTimeout(function () { document.getElementById('acTitle').focus(); }, 0);   // after the box hands focus back
          });
        },
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
