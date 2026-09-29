/* NURA order.js: the order-confirmed page (order-confirmed.html#<order id>).

   Everything shown comes from GET /api/orders/:id, which answers only the account or the
   guest browser that placed the order. Anyone else, with the same link, gets "not found". */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var main = document.getElementById('ocMain');
  var id = decodeURIComponent(location.hash.slice(1));

  /** 254712345678 → 0712 345 678, the way Kenyans write their numbers. */
  function localPhone(p) {
    var m = String(p).match(/^254(\d{3})(\d{3})(\d{3})$/);
    return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : p;
  }

  function notFound() {
    main.innerHTML =
        '<section class="oc-card"><h1 class="co-title" style="font-size:36px;">We couldn’t find that order</h1>'
      + '<p class="co-hint" style="margin-top:10px;font-size:13px;">Orders can only be opened in the browser that placed them, or when signed in to the account they belong to. '
      + 'If you ordered on another device, open it there.</p>'
      + '<a class="co-link" href="index.html">Back to NURA &rarr;</a></section>';
  }

  function render(o) {
    var first = o.contact.name.split(/\s+/)[0];
    var cod = o.paymentMethod === 'COD';
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

    main.innerHTML =
        '<section class="oc-hero">'
      +   '<p class="oc-hero__kicker">Order ' + esc(o.number) + '</p>'
      +   '<h1 tabindex="-1" id="ocTitle">Thank you, ' + esc(first) + '</h1>'
      // No confirmation email yet: emails arrive in Phase 7, so the page must not promise one.
      +   '<p>Your order is in. Keep your order number, ' + esc(o.number) + ', in case you need to reach us.</p>'
      + '</section>'

      + '<section class="oc-card" aria-labelledby="ocNext"><h2 id="ocNext">What happens next</h2><ol class="oc-steps">'
      +   '<li><span><strong>We call to confirm</strong>We’ll ring ' + esc(localPhone(o.contact.phone)) + ' to confirm your order and a delivery time.</span></li>'
      +   '<li><span><strong>We pack and dispatch</strong>Your pieces are checked, packed and handed to a rider.</span></li>'
      +   (cod
            ? '<li><span><strong>Pay when it arrives</strong>Have ' + NURA.fmtKsh(o.totalKes) + ' ready for the rider.</span></li>'
            : '<li><span><strong>Delivered</strong>Your rider brings it to your door.</span></li>')
      + '</ol></section>'

      + '<section class="oc-card" aria-labelledby="ocItems"><h2 id="ocItems">Your order</h2>' + items
      +   '<div class="co-rows">'
      +     '<div class="co-row"><span>Subtotal</span><span>' + NURA.fmtKsh(o.subtotalKes) + '</span></div>'
      +     '<div class="co-row"><span>Delivery</span><span>' + (o.shippingKes ? NURA.fmtKsh(o.shippingKes) : 'Free') + '</span></div>'
      +     '<div class="co-row co-row--total"><span>' + (cod ? 'To pay on delivery' : 'Total') + '</span><span>' + NURA.fmtKsh(o.totalKes) + '</span></div>'
      +   '</div></section>'

      + '<div class="oc-cols">'
      +   '<section class="oc-card" aria-labelledby="ocTo"><h2 id="ocTo">Delivering to</h2><address class="oc-address">'
      +     esc(o.contact.name) + '<br>' + esc(o.delivery.addressLine1) + '<br>' + esc(o.delivery.area) + ', ' + esc(o.delivery.county)
      +     (o.delivery.notes ? '<br><span class="co-hint">“' + esc(o.delivery.notes) + '”</span>' : '')
      +   '</address></section>'
      +   '<section class="oc-card" aria-labelledby="ocPay"><h2 id="ocPay">Payment</h2><p class="oc-address">'
      +     (cod ? 'Cash on delivery' : esc(o.paymentMethod)) + '<br><span class="co-hint">Placed ' + new Date(o.placedAt).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) + '</span>'
      +   '</p></section>'
      + '</div>'

      + (o.guest
          ? '<section class="oc-card oc-invite"><p><strong>Save your details for next time.</strong><br>Create an account with ' + esc(o.contact.email)
            + ' and this order will be waiting in it.</p><a class="auth-submit" href="index.html#create-account" id="ocSignup">Create account</a></section>'
          : '');

    var signup = document.getElementById('ocSignup');
    if (signup) {
      // The sign-up form on the next page starts with this email filled in. sessionStorage:
      // this tab only, gone when it closes.
      signup.addEventListener('click', function () {
        try { sessionStorage.setItem('nura_signup_email', o.contact.email); } catch (e) {}
      });
    }
    document.title = 'Order ' + o.number + ' confirmed — NURA';
    document.getElementById('ocTitle').focus();          // screen readers start at the good news
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) { notFound(); return; }
  NURA.api('/orders/' + encodeURIComponent(id)).then(function (d) { render(d.order); }, function (err) {
    if (err.status === 404 || err.status === 400) notFound();
    else main.innerHTML = '<section class="oc-card"><p role="alert">' + esc(err.message) + '</p></section>';
  });
})();
