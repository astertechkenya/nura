/* NURA catalogue.js: keeps the hand-written product cards truthful.

   The cards in the HTML still render instantly (good for speed and search engines). Once the
   API answers, every card with a data-sku gets the live values: price, "was" price, New/Sale
   badge and stock. If the API can't be reached, the cards simply keep what the HTML says;
   the page never breaks because the backend is asleep.

   Phase 7 replaces the hand-written cards with ones rendered from the API, once the admin
   can add products that don't exist in the HTML. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var LOW_STOCK = 3; // "Only N left" at or below this

  var cards = document.querySelectorAll('[data-sku]');
  if (!cards.length) return;

  // Only show the "updating" pulse if the API is slow (a cold start). A fast answer
  // should just swap the numbers without any visible flicker.
  var root = document.documentElement;
  var slowTimer = setTimeout(function () { root.classList.add('nura-syncing'); }, 1200);

  function priceEl(card) { return card.querySelector('.product-card__price, .product__price'); }

  function setOldPrice(card, p) {
    var now = priceEl(card);
    var old = card.querySelector('.product-card__price-old, .product__price-old');
    if (!p.onSale) { if (old) old.remove(); return; }
    if (!old && now) {
      old = document.createElement('span');
      old.className = now.classList[0] + '-old';   // product-card__price → product-card__price-old
      now.after(old);
    }
    if (old) old.textContent = NURA.fmtKsh(p.compareAtKes);
  }

  function setBadge(card, p) {
    var holder = card.querySelector('.product-card__img, .product__img');
    if (!holder) return;
    var badge = holder.querySelector('.product-card__badge, .product__badge');
    var kind = p.onSale ? 'sale' : p.isNew ? 'new' : null;   // Sale wins: it's the more useful fact
    if (!kind) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      holder.prepend(badge);
    }
    var base = badge.classList[0] || 'product-card__badge';
    badge.className = base + ' ' + base + '--' + kind;
    badge.textContent = kind === 'sale' ? 'Sale' : 'New';
  }

  function setStock(card, stock, soldOutLabel) {
    var overlay = card.querySelector('[data-action="add-to-cart"], [data-sold-out]');
    var note = card.querySelector('.nura-stock');
    card.classList.toggle('is-sold-out', stock === 0);

    if (overlay) {
      if (stock === 0) {
        // Removing data-action means the click router ignores it: nothing to add.
        overlay.removeAttribute('data-action');
        overlay.setAttribute('data-sold-out', '');
        overlay.setAttribute('aria-disabled', 'true');
        overlay.textContent = soldOutLabel;
      } else if (overlay.hasAttribute('data-sold-out')) {
        overlay.removeAttribute('data-sold-out');
        overlay.removeAttribute('aria-disabled');
        overlay.setAttribute('data-action', 'add-to-cart');
        overlay.textContent = 'Add to cart';
      }
    }

    var text = stock > 0 && stock <= LOW_STOCK ? 'Only ' + stock + ' left' : '';
    if (!text) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('p');
      note.className = 'nura-stock';
      var priceLine = priceEl(card);
      (priceLine ? priceLine.parentElement : card).after(note);
    }
    note.textContent = text;
  }

  function hydrate(data) {
    var bySku = {};
    data.products.forEach(function (p) { bySku[p.sku] = p; });

    cards.forEach(function (card) {
      var p = bySku[card.dataset.sku];
      if (!p) {
        // In the HTML but not in the catalogue: hidden by an admin, or removed.
        setStock(card, 0, 'Unavailable');
        return;
      }
      var now = priceEl(card);
      if (now) now.textContent = NURA.fmtKsh(p.priceKes);
      setOldPrice(card, p);
      setBadge(card, p);
      setStock(card, p.totalStock, 'Sold out');
      card.dataset.stock = p.totalStock;
    });
    // "Up to N% off" = the biggest real discount among the products on this page.
    var maxOff = 0;
    cards.forEach(function (card) {
      var p = bySku[card.dataset.sku];
      if (p && p.onSale) maxOff = Math.max(maxOff, Math.floor((1 - p.priceKes / p.compareAtKes) * 100));
    });
    document.querySelectorAll('[data-max-discount]').forEach(function (el) {
      if (maxOff > 0) el.textContent = maxOff + '% off';
    });
    document.dispatchEvent(new CustomEvent('nura:catalogue', { detail: data }));
  }

  NURA.products()
    .then(hydrate)
    .catch(function () { /* keep the prices written in the HTML */ })
    .finally(function () {
      clearTimeout(slowTimer);
      root.classList.remove('nura-syncing');
    });
})();
