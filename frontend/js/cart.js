/* NURA cart.js: cart drawer. Stored in localStorage until Phase 3 moves it to the API. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc, KEY = 'nura_cart';

  function getCart() { return NURA.store.get(KEY, []); }
  function saveCart(c) { NURA.store.set(KEY, c); }

  function addItem(item) {
    var cart = getCart();
    var line = cart.find(function (i) { return i.id === item.id; });
    if (line) line.qty += 1;
    else cart.push({ id: item.id, brand: item.brand, name: item.name, price: item.price,
                     bg: item.bg || '#efefed', img: item.img || '', qty: 1 });
    saveCart(cart); refreshBadge(); flashNav();
  }
  function removeItem(id) {
    saveCart(getCart().filter(function (i) { return i.id !== id; }));
    refreshBadge(); render();
  }
  function changeQty(id, delta) {
    var cart = getCart(), idx = cart.findIndex(function (i) { return i.id === id; });
    if (idx === -1) return;
    cart[idx].qty += delta;
    if (cart[idx].qty <= 0) cart.splice(idx, 1);
    saveCart(cart); refreshBadge(); render();
  }
  function clearAll() { saveCart([]); refreshBadge(); }

  function refreshBadge() {
    var n = getCart().reduce(function (s, i) { return s + i.qty; }, 0);
    var cb = document.getElementById('cartBadge');
    if (cb) { cb.textContent = n; cb.style.display = n > 0 ? 'flex' : 'none'; }
  }
  function flashNav() {
    document.querySelectorAll('.nav__cart').forEach(function (btn) {
      btn.style.background = 'var(--purple)';
      setTimeout(function () { btn.style.background = ''; }, 700);
    });
  }

  var X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function render() {
    var list = document.getElementById('cartItems'),
        footer = document.getElementById('cartFooter'),
        count = document.getElementById('cartDrawerCount');
    if (!list) return;
    var cart = getCart(),
        total = cart.reduce(function (s, i) { return s + NURA.parseKsh(i.price) * i.qty; }, 0),
        qty = cart.reduce(function (s, i) { return s + i.qty; }, 0);
    if (count) count.textContent = qty + ' item' + (qty !== 1 ? 's' : '');
    if (footer) footer.style.display = cart.length ? 'block' : 'none';
    if (!cart.length) {
      list.innerHTML = '<div class="cart-empty"><p class="cart-empty__title">Your cart is empty</p><p class="cart-empty__sub">Add items from any page to get started.</p></div>';
      return;
    }
    var sub = document.getElementById('cartSubtotal'), tot = document.getElementById('cartTotal');
    if (sub) sub.textContent = NURA.fmtKsh(total);
    if (tot) tot.textContent = NURA.fmtKsh(total);
    list.innerHTML = cart.map(function (it) {
      var id = esc(it.id), bg = esc(it.bg);
      return '<div class="cart-item" data-id="' + id + '">'
        + (it.img
            ? '<div class="cart-item__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(it.img) + '" alt="" style="width:100%;height:100%;object-fit:cover;"></div>'
            : '<div class="cart-item__img" style="background:' + bg + '"></div>')
        + '<div><p class="cart-item__brand">' + esc(it.brand) + '</p>'
        + '<p class="cart-item__name">' + esc(it.name) + '</p>'
        + '<div class="cart-item__qty">'
        + '<button class="cart-qty-btn" data-action="cart-dec" data-id="' + id + '" aria-label="Decrease quantity">&minus;</button>'
        + '<span class="cart-qty-num">' + Number(it.qty) + '</span>'
        + '<button class="cart-qty-btn" data-action="cart-inc" data-id="' + id + '" aria-label="Increase quantity">+</button>'
        + '</div></div>'
        + '<div class="cart-item__right">'
        + '<p class="cart-item__price">' + NURA.fmtKsh(NURA.parseKsh(it.price) * it.qty) + '</p>'
        + '<button class="cart-remove" data-action="cart-remove" data-id="' + id + '" aria-label="Remove">' + X_ICON + '</button>'
        + '</div></div>';
    }).join('');
  }

  function open() {
    render();
    var d = document.getElementById('cartDrawer'), o = document.getElementById('cartOverlay');
    if (d) d.classList.add('open');
    if (o) o.classList.add('open');
    NURA.lockScroll(true);
  }
  function close() {
    var d = document.getElementById('cartDrawer'), o = document.getElementById('cartOverlay');
    if (!d || !d.classList.contains('open')) return;
    d.classList.remove('open');
    if (o) o.classList.remove('open');
    NURA.lockScroll(false);
  }

  function addFromCard(btn) {
    var item = NURA.readCard(btn);
    if (!item) return;
    addItem(item);
    btn.textContent = 'Added';
    btn.style.background = 'var(--purple)';
    setTimeout(function () { btn.textContent = 'Add to cart'; btn.style.background = ''; }, 1500);
  }

  NURA.on('add-to-cart', addFromCard);
  NURA.on('cart-inc', function (el) { changeQty(el.dataset.id, 1); });
  NURA.on('cart-dec', function (el) { changeQty(el.dataset.id, -1); });
  NURA.on('cart-remove', function (el) { removeItem(el.dataset.id); });

  var byId = function (id) { return document.getElementById(id); };
  if (byId('cartClose')) byId('cartClose').addEventListener('click', close);
  if (byId('cartOverlay')) byId('cartOverlay').addEventListener('click', close);
  if (byId('cartClear')) byId('cartClear').addEventListener('click', function () {
    if (confirm('Clear your cart?')) { clearAll(); close(); }
  });
  // Checkout does not exist until Phase 4; for now the button closes the drawer.
  if (byId('cartCheckout')) byId('cartCheckout').addEventListener('click', close);
  document.querySelectorAll('.nav__cart').forEach(function (btn) { btn.addEventListener('click', open); });
  NURA.onEscape(close);
  refreshBadge();

  NURA.cart = { addItem: addItem, open: open, close: close, clearAll: clearAll };
})();
