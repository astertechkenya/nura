/* NURA filters.js: category-page controls (subcategory tiles, sort, grid/list view, load more).
   Loaded on men, women, new-in and sale. The item count shows how many products are
   actually on screen. (Until Phase 1 it showed invented numbers such as "180 items".) */
(function () {
  'use strict';
  var NURA = window.NURA;
  var grid = document.getElementById('productGrid');
  if (!grid) return;

  var cards = function () { return Array.prototype.slice.call(grid.querySelectorAll('.product-card')); };
  cards().forEach(function (c, i) { c.dataset.sortIndex = i; });
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
    document.querySelectorAll('.subcat[data-style]').forEach(function (tile) {
      var style = tile.dataset.style;
      var n = style === 'All' ? all.length : all.filter(function (c) { return c.dataset.style === style; }).length;
      var label = tile.querySelector('.subcat__count');
      if (label) label.textContent = plural(n, 'piece', 'pieces');
    });
  }
  countTotals();
  applyStyleFilter();

  NURA.on('subcat', function (el) {
    currentStyle = el.dataset.style || 'All';
    document.querySelectorAll('.subcat[data-action="subcat"]').forEach(function (t) {
      t.classList.toggle('active', t === el);
    });
    applyStyleFilter();
    var target = document.getElementById('grid');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  var sortSelect = document.getElementById('sortSelect');
  if (sortSelect) sortSelect.addEventListener('change', function () {
    var val = this.value;
    var priceOf = function (c) { return NURA.parseKsh((c.querySelector('.product-card__price') || {}).textContent); };
    var nameOf = function (c) { return ((c.querySelector('.product-card__name') || {}).textContent || '').trim(); };
    cards().sort(function (a, b) {
      if (val === 'price-asc') return priceOf(a) - priceOf(b);
      if (val === 'price-desc') return priceOf(b) - priceOf(a);
      if (val === 'az') return nameOf(a).localeCompare(nameOf(b));
      return (+a.dataset.sortIndex) - (+b.dataset.sortIndex);
    }).forEach(function (c) { grid.appendChild(c); });
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

  // Placeholder until the API can page results (Phase 1).
  NURA.on('load-more', function (btn) {
    btn.textContent = 'Loading...';
    setTimeout(function () { btn.textContent = 'All items loaded'; btn.disabled = true; btn.style.opacity = '.4'; }, 1200);
  });

  var sidebar = document.getElementById('filtersSidebar');
  var toggle = document.getElementById('filterToggle');
  if (sidebar && toggle) toggle.addEventListener('click', function () { sidebar.classList.add('open'); });
  NURA.onEscape(function () { if (sidebar) sidebar.classList.remove('open'); });
})();
