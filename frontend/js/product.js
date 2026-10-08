/* NURA product.js: the product page (/p/<slug>), Phase 8.

   The API sends the page already complete (api/src/routes/pages.js): photo, price, sizes as
   radio buttons, details. That's what WhatsApp previews and Google read, and what shows before
   this script runs. This file adds what needs JavaScript:
     - choosing a size shows how many are left in it;
     - "Add to cart" checks a size is chosen, adds it (js/cart.js) and says so;
     - "Only N left" stays honest: after adding, the sizes are refreshed from the API.
   The wishlist heart is handled by js/wishlist.js like every other heart on the site. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var form = document.getElementById('pdBuy');
  if (!form) return;                                   // the "not found" page has no form

  var data = document.getElementById('pdData');
  var product = data ? JSON.parse(data.textContent) : null;
  var stock = document.getElementById('pdStock'), msg = document.getElementById('pdMsg');
  var add = document.getElementById('pdAdd');
  var LOW_STOCK = 3;

  var chosen = function () { return form.querySelector('input[name="variant"]:checked'); };

  function describe() {
    var c = chosen();
    if (!c) { stock.textContent = ''; return; }
    var n = Number(c.dataset.stock);
    stock.textContent = n <= LOW_STOCK ? 'Only ' + n + ' left in ' + c.dataset.size + '.' : 'In stock.';
    stock.classList.toggle('is-low', n <= LOW_STOCK);
  }

  form.addEventListener('change', function () { msg.textContent = ''; describe(); });
  describe();                                          // a one-size product arrives already chosen

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var c = chosen();
    if (!c) {
      msg.textContent = 'Please choose a size.';
      var first = form.querySelector('input[name="variant"]:not(:disabled)');
      if (first) first.focus();                        // straight to the choice that's missing
      return;
    }
    add.disabled = true; add.textContent = 'Adding…';
    NURA.cart.add(c.value).then(function () {
      add.textContent = 'Added ✓';
      NURA.toast('Added to your cart: ' + (product ? product.name : 'item') + ', ' + c.dataset.size);
      // Back to "Add to cart" after a moment, unless refresh() found it has now sold out
      // completely (the shopper took the last one): then it must stay "Sold out" (Oct 2026).
      setTimeout(function () { if (add.dataset.soldOut) return; add.textContent = 'Add to cart'; add.disabled = false; }, 1600);
      refresh();
    }, function () {
      // cart.js has already shown the API's message (e.g. "Only 1 left in M").
      if (!add.dataset.soldOut) { add.textContent = 'Add to cart'; add.disabled = false; }
      refresh();
    });
  });

  /** Re-reads stock for each size, so the page doesn't keep offering what just sold out. */
  function refresh() {
    if (!product) return;
    NURA.api('/products/' + encodeURIComponent(product.slug)).then(function (d) {
      d.product.variants.forEach(function (v) {
        var input = form.querySelector('input[value="' + v.id + '"]');
        if (!input) return;
        input.dataset.stock = v.stock;
        var out = v.stock === 0;
        input.disabled = out;
        if (out && input.checked) input.checked = false;
        input.closest('.pd-chip').classList.toggle('is-out', out);
      });
      if (d.product.totalStock === 0) { add.disabled = true; add.textContent = 'Sold out'; add.dataset.soldOut = '1'; }
      describe();
    }, function () {});
  }
})();
