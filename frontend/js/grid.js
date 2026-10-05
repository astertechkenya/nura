/* NURA grid.js: product cards rendered from the API (Phase 7.5). Replaces catalogue.js.

   Before: every page carried hand-written cards, and catalogue.js corrected their prices once
   the API answered. The HTML and the database could disagree (a stale price for a moment, the
   Sale page missing 2 of its 8 products), and a new product needed a code change to appear.

   Now: each grid in the HTML is an empty container that names its list:
       <div class="product-grid" data-list="women">          (category pages)
       <div class="products" data-list="sale" data-limit="4"> (home sections)
   and holds skeleton placeholders until the catalogue arrives. The rules for which products
   belong to which list live in api.js (NURA.lists), shared with search.

   When the cards are in, this fires `nura:grid` on document. filters.js (counts, sort, style
   tiles), wishlist.js (hearts) and ui.js (#sku highlight) wait for it. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var LOW_STOCK = 3;   // "Only N left" at or below this

  var grids = Array.prototype.slice.call(document.querySelectorAll('[data-list]'));
  if (!grids.length) return;
  // grid.js is itself a deferred script, so this listener is always in place before the event.
  var domReady = false;
  document.addEventListener('DOMContentLoaded', function () { domReady = true; });

  var HEART = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

  /** One card. The home page uses .product / .product__*; category pages use .product-card /
   *  .product-card__*. Same content, two class prefixes, because the two layouts were styled
   *  separately. Every value from the database goes through esc(). */
  function cardHtml(p, prefix) {
    var tag = prefix === 'product' ? 'product' : 'product-card';
    var badge = p.onSale ? 'sale' : p.isNew ? 'new' : null;           // Sale wins: the more useful fact
    var soldOut = p.totalStock === 0;
    var overlay = soldOut
      ? '<button type="button" class="' + tag + '__overlay" data-sold-out aria-disabled="true">Sold out</button>'
      : '<button type="button" class="' + tag + '__overlay" data-action="add-to-cart">Add to cart</button>';
    var low = p.totalStock > 0 && p.totalStock <= LOW_STOCK;
    var url = NURA.productUrl(p);

    return '<article class="' + tag + (soldOut ? ' is-sold-out' : '') + '" data-sku="' + esc(p.sku) + '"'
      + ' data-style="' + esc(p.style || '') + '" data-stock="' + Number(p.totalStock) + '"'
      + ' data-arrived="' + esc(p.arrivedAt) + '">'
      + '<div class="' + tag + '__img">'
      +   (badge ? '<span class="product-card__badge product-card__badge--' + badge + '">' + (badge === 'sale' ? 'Sale' : 'New') + '</span>' : '')
      // The photo links to the product page too, but only the name is announced and in the tab
      // order: one link per product for keyboard and screen-reader users, not two.
      +   '<a class="card-photo-link" href="' + esc(url) + '" tabindex="-1" aria-hidden="true">'
      +     '<img class="nura-card-img" src="' + esc(p.imageUrl) + '" alt="" loading="lazy"></a>'
      +   '<button class="product__wish product-card__wish" data-wishlist-id="' + esc(p.sku) + '" aria-label="Add to wishlist" aria-pressed="false" data-action="wishlist">' + HEART + '</button>'
      +   overlay
      + '</div>'
      + '<div class="' + tag + '__body">'
      +   '<p class="' + tag + '__brand">' + esc(p.brand.name) + '</p>'
      +   '<p class="' + tag + '__name"><a class="card-name-link" href="' + esc(url) + '">' + esc(p.name) + '</a></p>'
      +   '<p><span class="' + tag + '__price">' + NURA.fmtKsh(p.priceKes) + '</span>'
      +     (p.onSale ? '<span class="' + tag + '__price-old"><span class="visually-hidden">was </span>' + NURA.fmtKsh(p.compareAtKes) + '</span>' : '')
      +   '</p>'
      +   (low ? '<p class="nura-stock">Only ' + Number(p.totalStock) + ' left</p>' : '')
      + '</div>'
      + '</article>';
  }

  /** Colours and image focus are set through the CSSOM, not by pasting database values into a
   *  style="" attribute: el.style.x = value can only ever set that one property. */
  function applyLooks(grid, byId) {
    var listView = grid.classList.contains('list-view');
    grid.querySelectorAll('[data-sku]').forEach(function (card) {
      var p = byId[card.dataset.sku];
      var holder = card.querySelector('.product-card__img, .product__img');
      var img = card.querySelector('img');
      if (holder) holder.style.backgroundColor = p.cardBg;
      if (img) {
        img.dataset.gridPos = p.imageFocus;                  // filters.js swaps these for list view
        img.style.objectPosition = listView ? 'center center' : p.imageFocus;
      }
    });
  }

  function message(grid, text, retry) {
    grid.innerHTML = '<div class="grid-message" role="status"><p>' + esc(text) + '</p>'
      + (retry ? '<button type="button" class="grid-message__btn" data-action="grid-retry">Try again</button>' : '')
      + '</div>';
  }

  // Home sections never repeat a product: a section skips anything shown in a section above it.
  var EMPTY = { women: 'No pieces here right now.', men: 'No pieces here right now.',
                'new': 'Nothing new this month yet. Check back soon.', sale: 'Nothing on sale right now.' };

  function render(data) {
    var byId = {};
    data.products.forEach(function (p) { byId[p.sku] = p; });
    var shownOnPage = {};

    grids.forEach(function (grid) {
      var prefix = grid.classList.contains('products') ? 'product' : 'product-card';
      var list = NURA.productsFor(data.products, grid.dataset.list);
      if (grid.dataset.limit) {
        list = list.filter(function (p) { return !shownOnPage[p.sku]; }).slice(0, +grid.dataset.limit);
      }
      list.forEach(function (p) { shownOnPage[p.sku] = true; });

      if (!list.length) message(grid, EMPTY[grid.dataset.list] || 'No pieces here right now.', false);
      else grid.innerHTML = list.map(function (p) { return cardHtml(p, prefix); }).join('');
      applyLooks(grid, byId);
      grid.setAttribute('aria-busy', 'false');
    });

    // "Up to N% off" = the biggest real discount on this page (the Sale page header).
    var maxOff = 0;
    Object.keys(shownOnPage).forEach(function (sku) {
      var p = byId[sku];
      if (p.onSale) maxOff = Math.max(maxOff, Math.floor((1 - p.priceKes / p.compareAtKes) * 100));
    });
    document.querySelectorAll('[data-max-discount]').forEach(function (el) {
      if (maxOff > 0) el.textContent = maxOff + '% off';
    });

    document.dispatchEvent(new CustomEvent('nura:grid', { detail: data }));
  }

  function load() {
    grids.forEach(function (g) { g.setAttribute('aria-busy', 'true'); });
    NURA.products().then(function (data) {
      // Render only after DOMContentLoaded, which the browser fires once EVERY deferred script
      // has run, so filters.js, wishlist.js and ui.js are all listening for `nura:grid`.
      // (document.readyState can't tell us this: it is already 'interactive' while deferred
      // scripts are still running. A cached catalogue can arrive between two of them.)
      if (domReady) render(data);
      else document.addEventListener('DOMContentLoaded', function () { render(data); });
    }, function () {
      grids.forEach(function (g) {
        message(g, 'We couldn’t load the products. Check your connection and try again.', true);
        g.setAttribute('aria-busy', 'false');
      });
    });
  }

  NURA.on('grid-retry', function () {
    grids.forEach(function (g) { g.innerHTML = g.dataset.skeleton || ''; });
    load();
  });

  // Keep the skeleton markup so "Try again" can show it again while it retries.
  grids.forEach(function (g) { g.dataset.skeleton = g.innerHTML; });
  load();
})();
