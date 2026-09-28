/* NURA search.js: the search overlay.
   Products come from the API (NURA.products(), fetched once per page and shared with
   catalogue.js). Filtering the list happens here in the browser: 21 products is tiny, and
   filtering locally keeps results instant as you type. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;

  var overlay = document.getElementById('searchOverlay');
  var input = document.getElementById('searchInput');
  var results = document.getElementById('searchResults');
  if (!overlay || !input || !results) return;

  var products = null;   // filled on first open
  var failed = false;

  /* Where each product's card actually is. Generated from the five pages; until Phase 7 renders
     the grids from the API, a product can only be shown on a page whose HTML contains its card.
     Regenerate when you add or move a card:  (see tools/card-pages.py) */
  var CARD_PAGES = {
    "nura-001":["new-in.html","index.html"],
    "nura-002":["new-in.html","women.html","index.html"],
    "nura-003":["new-in.html","sale.html","index.html"],
    "nura-004":["new-in.html","sale.html","index.html"],
    "nura-005":["new-in.html"],
    "nura-006":["new-in.html"],
    "nura-018":["sale.html","index.html"],
    "nura-019":["sale.html","index.html"],
    "nura-020":["sale.html","index.html"],
    "nura-021":["sale.html","index.html"],
    "nura-007":["women.html","index.html"],
    "nura-008":["women.html","index.html"],
    "nura-009":["women.html","index.html"],
    "nura-010":["women.html"],
    "nura-011":["women.html","index.html"],
    "nura-012":["men.html","index.html"],
    "nura-013":["men.html","index.html"],
    "nura-014":["men.html","index.html"],
    "nura-015":["men.html"],
    "nura-016":["men.html"],
    "nura-017":["men.html","index.html"]
  };

  /** Best page for a result: New In if it's new, Sale if it's on sale, else its department. The
   *  page must contain the card; the #sku anchor scrolls to it and highlights it. */
  function pageFor(p) {
    var onPages = CARD_PAGES[p.sku] || [];
    var wanted = [];
    if (p.isNew) wanted.push('new-in.html');
    if (p.onSale) wanted.push('sale.html');
    wanted.push(p.department === 'WOMEN' ? 'women.html' : p.department === 'MEN' ? 'men.html' : null);
    var page = wanted.filter(function (w) { return w && onPages.indexOf(w) > -1; })[0] || onPages[0] || 'index.html';
    return page + '#' + p.sku;
  }

  function message(text) { results.innerHTML = '<div class="search-overlay__empty">' + esc(text) + '</div>'; }

  function load() {
    if (products || failed) return;
    NURA.products().then(function (data) {
      products = data.products;
      render(input.value);
    }, function () {
      failed = true;
      render(input.value);
    });
  }

  function render(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) { results.innerHTML = ''; return; }
    if (failed) { message('Search is unavailable right now. Please try again shortly.'); return; }
    if (!products) { message('Loading…'); return; }
    var matches = products.filter(function (p) {
      return p.name.toLowerCase().indexOf(q) > -1 || p.brand.name.toLowerCase().indexOf(q) > -1;
    });
    if (!matches.length) { message('No results'); return; }
    results.innerHTML = matches.map(function (p) {
      var bg = esc(p.cardBg);
      return '<a class="search-result" href="' + esc(pageFor(p)) + '">'
        + (p.imageUrl
            ? '<div class="search-result__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(p.imageUrl) + '" alt="" style="width:100%;height:100%;object-fit:cover;"></div>'
            : '<div class="search-result__img" style="background:' + bg + '"></div>')
        + '<p class="search-result__brand">' + esc(p.brand.name) + '</p>'
        + '<p class="search-result__name">' + esc(p.name) + '</p>'
        + '<p class="search-result__price">' + NURA.fmtKsh(p.priceKes) + '</p>'
        + '</a>';
    }).join('');
  }

  function open() {
    overlay.classList.add('open');
    NURA.lockScroll(true);
    load();
    setTimeout(function () { input.focus(); }, 100);
  }
  function close() {
    if (!overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    NURA.lockScroll(false);
    input.value = '';
    results.innerHTML = '';
  }

  NURA.on('open-search', open);
  input.addEventListener('input', function () { render(this.value); });
  results.addEventListener('click', function (e) { if (e.target.closest('.search-result')) close(); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  NURA.onEscape(close);
})();
