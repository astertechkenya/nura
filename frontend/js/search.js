/* NURA search.js: the product list and the search overlay.
   NURA_PRODUCTS is the catalogue until Phase 1 serves it from GET /api/products.
   The Phase 0 seed script reads this array. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;

  var NURA_PRODUCTS = window.NURA_PRODUCTS = [
    {id:'nura-001',img:'images/pearl.webp',brand:'Chanel',       name:'Pearl Chain Bracelet',     price:'KSh 8,500',  bg:'#cccccc',page:'new-in.html'},
    {id:'nura-002',img:'images/linen_blazer.webp',brand:'KikoRomeo',    name:'Linen Oversized Blazer',   price:'KSh 14,200', bg:'#c8c8c6',page:'new-in.html'},
    {id:'nura-003',img:'images/printed_dress.webp',brand:'Zara',         name:'Printed Wrap Dress',       price:'KSh 5,700',  bg:'#cccccc',page:'sale.html'},
    {id:'nura-004',img:'images/handwoven_bucket_hat.webp',brand:'Ann McCreath', name:'Handwoven Bucket Hat',     price:'KSh 2,080',  bg:'#bbbbbb',page:'new-in.html'},
    {id:'nura-005',img:'images/Neverfull.webp',brand:'Louis Vuitton',name:'Neverfull Tote Bag',       price:'KSh 18,500', bg:'#d0c8c0',page:'new-in.html'},
    {id:'nura-006',img:'images/goldchain1.webp',brand:'Chanel',       name:'Gold Chain Earrings',      price:'KSh 4,800',  bg:'#c0bab4',page:'new-in.html'},
    {id:'nura-007',img:'images/columndress.webp',brand:'Ann McCreath', name:'Tailored Column Dress',    price:'KSh 22,500', bg:'#c8c8c6',page:'women.html'},
    {id:'nura-008',img:'images/widelegcargo.webp',brand:'Zara',         name:'Wide Leg Cargo Pants',     price:'KSh 9,800',  bg:'#bbbbbb',page:'women.html'},
    {id:'nura-009',img:'images/drapedgown.webp',brand:'Louis Vuitton',name:'Draped Evening Gown',      price:'KSh 38,000', bg:'#c0bab4',page:'women.html'},
    {id:'nura-010',img:'images/cottonwrap.webp',brand:'KikoRomeo',    name:'Cotton Wrap Skirt',        price:'KSh 5,400',  bg:'#cccccc',page:'women.html'},
    {id:'nura-011',img:'images/structuredblazer.webp',brand:'Ann McCreath', name:'Structured Blazer Set',    price:'KSh 28,000', bg:'#b8b4b0',page:'women.html'},
    {id:'nura-012',img:'images/relaxedlinen.avif',brand:'KikoRomeo',    name:'Relaxed Linen Shirt',      price:'KSh 8,200',  bg:'#efefed',page:'men.html'},
    {id:'nura-013',img:'images/slimtaper.webp',brand:'Ann McCreath', name:'Slim Tapered Trousers',    price:'KSh 12,800', bg:'#c8c8c6',page:'men.html'},
    {id:'nura-014',img:'images/techfleece.webp',brand:'Nike',         name:'Tech Fleece Jacket',       price:'KSh 16,500', bg:'#bbbbbb',page:'men.html'},
    {id:'nura-015',img:'images/blazerevening.webp',brand:'Louis Vuitton',name:'Structured Evening Blazer',price:'KSh 32,000', bg:'#c0bab4',page:'men.html'},
    {id:'nura-016',img:'images/cargoshort.avif',brand:'KikoRomeo',    name:'Cargo Shorts',             price:'KSh 4,800',  bg:'#cccccc',page:'men.html'},
    {id:'nura-017',img:'images/breastedsuit.webp',brand:'Ann McCreath', name:'Double-Breasted Suit',     price:'KSh 45,000', bg:'#b8b4b0',page:'men.html'},
    {id:'nura-018',img:'images/airmax.avif',brand:'Nike',         name:'Air Max 270 Sneakers',     price:'KSh 9,750',  bg:'#e8eaed',page:'sale.html'},
    {id:'nura-019',img:'images/drifit.webp',brand:'Nike',         name:'Dri-FIT Training Shorts',  price:'KSh 3,200',  bg:'#dce4ec',page:'sale.html'},
    {id:'nura-020',img:'images/satinskirt.webp',brand:'Zara',         name:'Satin Midi Slip Skirt',    price:'KSh 3,600',  bg:'#d4ccd8',page:'sale.html'},
    {id:'nura-021',img:'images/leatherbelt.webp',brand:'KikoRomeo',    name:'Woven Leather Belt',       price:'KSh 2,100',  bg:'#c8b89a',page:'sale.html'}
  ];

  var overlay = document.getElementById('searchOverlay');
  var input = document.getElementById('searchInput');
  var results = document.getElementById('searchResults');

  function open() {
    if (!overlay) return;
    overlay.classList.add('open');
    NURA.lockScroll(true);
    setTimeout(function () { input.focus(); }, 100);
  }
  function close() {
    if (!overlay || !overlay.classList.contains('open')) return;
    overlay.classList.remove('open');
    NURA.lockScroll(false);
    input.value = '';
    results.innerHTML = '';
  }
  function run(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) { results.innerHTML = ''; return; }
    var matches = NURA_PRODUCTS.filter(function (p) {
      return p.name.toLowerCase().indexOf(q) > -1 || p.brand.toLowerCase().indexOf(q) > -1;
    });
    if (!matches.length) { results.innerHTML = '<div class="search-overlay__empty">No results</div>'; return; }
    results.innerHTML = matches.map(function (p) {
      var bg = esc(p.bg);
      return '<a class="search-result" href="' + esc(p.page) + '">'
        + (p.img
            ? '<div class="search-result__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(p.img) + '" alt="" style="width:100%;height:100%;object-fit:cover;"></div>'
            : '<div class="search-result__img" style="background:' + bg + '"></div>')
        + '<p class="search-result__brand">' + esc(p.brand) + '</p>'
        + '<p class="search-result__name">' + esc(p.name) + '</p>'
        + '<p class="search-result__price">' + esc(p.price) + '</p>'
        + '</a>';
    }).join('');
  }

  NURA.on('open-search', open);
  if (input) input.addEventListener('input', function () { run(this.value); });
  if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  NURA.onEscape(close);
})();
