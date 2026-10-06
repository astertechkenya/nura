/* NURA search.js: the search overlay.
   Products come from the API (NURA.products(), fetched once per page and shared with
   grid.js). Each result links to the product's own page (NURA.productUrl, in api.js). (Before product pages,
   it linked to a page that held its card: NURA.pageFor, which uses
   the same rules that fill the grids). Filtering the list happens here in the browser: 21 products is tiny, and
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
      return '<a class="search-result" href="' + esc(NURA.productUrl(p)) + '">'
        + (p.imageUrl
            ? '<div class="search-result__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(NURA.photo(p.imageUrl, 800)) + '" alt="" style="width:100%;height:100%;object-fit:cover;"></div>'
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
