/* NURA filters.js: category-page controls (style tabs, sort, grid/list view).
   Loaded on men, women, new-in and sale. The cards are rendered by grid.js from the API, so
   everything here that counts or sorts cards runs when grid.js announces them (`nura:grid`).
   The counts are always counted from the cards on screen, never typed into the HTML. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var grid = document.getElementById('productGrid');
  if (!grid) return;

  // Real cards only: skeletons and messages don't count.
  var cards = function () { return Array.prototype.slice.call(grid.querySelectorAll('.product-card[data-sku]')); };
  var currentStyle = 'All';

  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  // Every number on these pages is counted from the cards that are really on it, so it can
  // never drift from what the shopper sees. (Until Phase 1 they were invented: "48 pieces",
  // "240 pieces".) Phase 7, rendering from the API, keeps the same rule.
  function applyStyleFilter() {
    var shown = 0;
    cards().forEach(function (c) {
      var match = currentStyle === 'All' || c.dataset.style === currentStyle;
      c.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    document.querySelectorAll('.sort-bar__count').forEach(function (el) {
      el.textContent = plural(shown, 'item', 'items');
    });
  }
  function countTotals() {
    var all = cards();
    document.querySelectorAll('[data-live-count]').forEach(function (el) {
      el.textContent = plural(all.length, 'piece', 'pieces');
    });
    // Hero figures ("Pieces available", "Brands"): counted too. Until 7.5 they said 240+ and 18+.
    var brands = {};
    all.forEach(function (c) { var b = c.querySelector('.product-card__brand'); if (b) brands[b.textContent.trim()] = 1; });
    var nums = { pieces: all.length, brands: Object.keys(brands).length };
    document.querySelectorAll('[data-live-num]').forEach(function (el) { el.textContent = nums[el.dataset.liveNum]; });
    document.querySelectorAll('.subcat[data-style]').forEach(function (tile) {
      var style = tile.dataset.style;
      var n = style === 'All' ? all.length : all.filter(function (c) { return c.dataset.style === style; }).length;
      // The style tabs show the bare number ("Casual 3"); the visually-hidden word makes a
      // screen reader say "Casual, 3 pieces" rather than "Casual 3".
      var label = tile.querySelector('.subcat__count');
      if (label) label.innerHTML = n + '<span class="visually-hidden"> ' + (n === 1 ? 'piece' : 'pieces') + '</span>';
    });
  }
  var sortSelect = document.getElementById('sortSelect');

  // The cards have arrived (or arrived again after "Try again"): remember their catalogue order,
  // count them, and re-apply whatever the shopper already chose while they were loading.
  document.addEventListener('nura:grid', function () {
    cards().forEach(function (c, i) { c.dataset.sortIndex = i; });
    countTotals();
    if (sortSelect && sortSelect.value) sortBy(sortSelect.value);
    applyStyleFilter();
  });

  NURA.on('subcat', function (el) {
    currentStyle = el.dataset.style || 'All';
    document.querySelectorAll('.subcat[data-action="subcat"]').forEach(function (t) {
      t.classList.toggle('active', t === el);
      t.setAttribute('aria-pressed', t === el ? 'true' : 'false');
    });
    applyStyleFilter();
    // No scrolling: the style tabs now sit directly above the grid (Oct 2026). The old tiles
    // were tall, so a click used to scroll the products into view.
  });

  function sortBy(val) {
    var priceOf = function (c) { return NURA.parseKsh((c.querySelector('.product-card__price') || {}).textContent); };
    var nameOf = function (c) { return ((c.querySelector('.product-card__name') || {}).textContent || '').trim(); };
    var arrived = function (c) { return Date.parse(c.dataset.arrived) || 0; };
    cards().sort(function (a, b) {
      // "Newest first" really is newest first: by arrival date, catalogue order for ties.
      if (val === 'newest') return (arrived(b) - arrived(a)) || (+a.dataset.sortIndex) - (+b.dataset.sortIndex);
      if (val === 'price-asc') return priceOf(a) - priceOf(b);
      if (val === 'price-desc') return priceOf(b) - priceOf(a);
      if (val === 'az') return nameOf(a).localeCompare(nameOf(b));
      return (+a.dataset.sortIndex) - (+b.dataset.sortIndex);
    }).forEach(function (c) { grid.appendChild(c); });
  }
  if (sortSelect) sortSelect.addEventListener('change', function () {
    sortBy(this.value);
    applyStyleFilter();
  });

  NURA.on('set-view', function (el) {
    var type = el.dataset.view;
    var g = document.getElementById('gridViewBtn'), l = document.getElementById('listViewBtn');
    if (g) g.classList.toggle('active', type === 'grid');
    if (l) l.classList.toggle('active', type === 'list');
    grid.classList.toggle('list-view', type === 'list');
    grid.querySelectorAll('img[data-grid-pos]').forEach(function (img) {
      img.style.objectPosition = type === 'list'
        ? (img.dataset.listPos || 'center center')
        : (img.dataset.gridPos || 'center top');
    });
  });

  var sidebar = document.getElementById('filtersSidebar');
  var toggle = document.getElementById('filterToggle');
  if (sidebar && toggle) toggle.addEventListener('click', function () { sidebar.classList.add('open'); });
  NURA.onEscape(function () { if (sidebar) sidebar.classList.remove('open'); });
})();
