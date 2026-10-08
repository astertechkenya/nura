/* NURA cart.js: size picker, cart drawer and badge. Phase 3: the cart lives on the server.

   What changed from the localStorage cart, and why:
   - The browser no longer keeps a copy of the cart. It asks GET /api/cart and draws exactly
     what comes back, including prices and totals. Editing a price in dev tools changes nothing
     that matters: the server never reads a price from the browser.
   - A cart line is a *size* of a product (a variant), because that's what gets packed and
     what stock is counted in. So "Add to cart" first asks for a size, unless there is only one.
   - Guests have a cart too, tied to an httpOnly cookie the server sets. Signing in moves it
     into the account (the server does the merge), and this file simply reloads. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var byId = function (id) { return document.getElementById(id); };

  NURA.store.remove('nura_cart');       // the old browser-only cart; it held prices typed into the page

  var cart = null;                      // the last cart the server sent; null until the first answer

  /* ── Toast: short, spoken messages ("Added", "Only 2 left") ────────────────────── */
  var toastTimer;
  NURA.toast = function (text) {
    var t = byId('nuraToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'nuraToast';
      t.className = 'nura-toast';
      t.setAttribute('role', 'status');        // screen readers announce it without moving focus
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  };

  /* ── Talking to the API ───────────────────────────────────────────────────────────── */
  // Every request is numbered; an answer older than one already drawn is dropped (Oct 2026).
  // Without this, opening the drawer (GET) and tapping + at once on a slow connection could
  // draw the newer quantity, then have the older GET arrive and put the old one back.
  var sent = 0, drawn = 0;
  function newer(n) { if (n < drawn) return false; drawn = n; return true; }
  function setCart(next) {
    cart = next;
    refreshBadge();
    render();
    markCards();
    return cart;
  }
  /* Product cards whose product is in the cart get .in-cart on their add button: on phones the
     bag icon is then filled black (shared.css), like a saved heart. Runs whenever the cart
     changes, and when a grid of cards is drawn (nura:grid), since cards can arrive later. */
  function markCards() {
    if (!cart) return;
    var inCart = {};
    cart.items.forEach(function (it) { inCart[it.product.sku] = true; });
    document.querySelectorAll('[data-sku] [data-action="add-to-cart"]').forEach(function (btn) {
      btn.classList.toggle('in-cart', !!inCart[btn.closest('[data-sku]').dataset.sku]);
    });
  }
  document.addEventListener('nura:grid', markCards);
  function load() {
    var n = ++sent;
    return NURA.api('/cart').then(function (d) { return newer(n) ? setCart(d.cart) : cart; });
  }
  /** Every write answers with the whole cart. While it runs the drawer is marked busy, so a
   *  double tap on + can't send two changes built on the same old quantity. */
  function write(method, path, body) {
    var drawer = byId('cartDrawer');
    if (drawer) drawer.setAttribute('aria-busy', 'true');
    var n = ++sent;
    return NURA.api(path, { method: method, body: body })
      .then(function (d) { return newer(n) ? setCart(d.cart) : cart; })
      .catch(function (err) {
        NURA.toast(err.message);               // the API writes its messages for shoppers
        if (err.status === 404 || err.status === 409) load().catch(function () {}); // resync
        throw err;
      })
      .finally(function () { if (drawer) drawer.removeAttribute('aria-busy'); });
  }
  function addVariant(variantId) {
    return write('POST', '/cart/items', { variantId: variantId, qty: 1 }).then(function (c) {
      flashNav();
      return c;
    });
  }

  function refreshBadge() {
    var n = cart ? cart.count : 0;
    var cb = byId('cartBadge');
    if (cb) { cb.textContent = n; cb.style.display = n > 0 ? 'flex' : 'none'; }
    // The badge is only a picture: the button says the count too, like the wishlist's heart.
    document.querySelectorAll('.nav__cart').forEach(function (btn) {
      btn.setAttribute('aria-label', n ? 'Open cart, ' + n + ' item' + (n !== 1 ? 's' : '') : 'Open cart');
    });
  }
  function flashNav() {
    document.querySelectorAll('.nav__cart').forEach(function (btn) {
      btn.style.background = 'var(--purple)';
      setTimeout(function () { btn.style.background = ''; }, 700);
    });
  }

  /* ── Size picker ─────────────────────────────────────────────────────────────────── */
  var picker = null;                    // { el, trigger } while one is open

  function closePicker(returnFocus) {
    if (!picker) return;
    var p = picker;
    picker = null;
    p.el.remove();
    if (p.host) p.host.classList.remove('is-picking');
    if (returnFocus && p.trigger && document.contains(p.trigger)) p.trigger.focus();
  }

  /**
   * Shows the sizes of `product` inside `container`, just above the Add to cart button.
   * Sold-out sizes stay visible but disabled, so the shopper knows the size exists.
   * `onDone` runs after a size was added successfully.
   */
  function openPicker(product, container, trigger, inline, onDone) {
    closePicker(false);
    var el = document.createElement('div');
    el.className = 'size-picker' + (inline ? ' size-picker--inline' : '');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Choose a size for ' + product.name);
    var low = product.variants.filter(function (v) { return v.stock > 0 && v.stock <= 3; });
    el.innerHTML =
        '<div class="size-picker__head">'
      +   '<span class="size-picker__title">Select size</span>'
      +   '<button type="button" class="size-picker__close" data-action="size-close" aria-label="Close sizes">&times;</button>'
      + '</div>'
      + '<div class="size-picker__sizes">'
      + product.variants.map(function (v) {
          var out = v.stock === 0;
          return '<button type="button" class="size-chip" data-action="size-pick" data-variant="' + esc(v.id) + '"'
            + (out ? ' disabled aria-label="' + esc(v.size) + ', sold out"' : '')
            + '>' + esc(v.size) + '</button>';
        }).join('')
      + '</div>'
      + (low.length ? '<p class="size-picker__note">Only ' + low.map(function (v) { return v.stock + ' left in ' + esc(v.size); }).join(', ') + '</p>' : '');
    container.appendChild(el);
    var host = trigger.closest('[data-sku]');
    if (host && !inline) host.classList.add('is-picking');
    picker = { el: el, trigger: trigger, host: host, onDone: onDone };
    var first = el.querySelector('.size-chip:not(:disabled)');
    if (first) first.focus();
  }

  function productFor(sku) {
    return NURA.products().then(function (data) {
      var p = data.products.filter(function (x) { return x.sku === sku; })[0];
      if (!p) throw new Error('This item is no longer available.');
      return p;
    });
  }

  /** One entry point for every "Add to cart": on product cards and in the wishlist. */
  NURA.addToCart = function (product, trigger, container, inline, onDone) {
    var inStock = product.variants.filter(function (v) { return v.stock > 0; });
    if (!inStock.length) { NURA.toast('Sorry, this item is sold out.'); return; }
    if (product.variants.length === 1) {       // ONE SIZE: nothing to choose
      trigger.disabled = true;
      addVariant(product.variants[0].id)
        .then(function () { if (onDone) onDone(); }, function () {})
        .finally(function () { trigger.disabled = false; });
      return;
    }
    openPicker(product, container, trigger, inline, onDone);
  };

  function addFromCard(btn) {
    var card = btn.closest('[data-sku]');
    if (!card) return;
    if (picker && picker.host === card) { closePicker(true); return; }   // a second click closes it
    // The sizes come from the catalogue, normally loaded already. If the free server is still
    // waking up, say so instead of leaving a click that seems to do nothing.
    var slow = setTimeout(function () { NURA.toast('One moment, the shop is waking up…'); }, 1500);
    productFor(card.dataset.sku).then(function (p) {
      var holder = card.querySelector('.product-card__img, .product__img') || card;
      NURA.addToCart(p, btn, holder, false, function () { confirmOnCard(btn); });
    }, function (err) { NURA.toast(err.message); })
      .finally(function () { clearTimeout(slow); });
  }
  function confirmOnCard(btn) {
    // Only the words change: the button also holds the bag icon that phones show instead.
    var label = btn.querySelector('.card-add__label') || btn;
    label.textContent = 'Added';
    btn.classList.add('is-added');
    setTimeout(function () { label.textContent = 'Add to cart'; btn.classList.remove('is-added'); }, 1500);
    NURA.toast('Added to your cart');
  }

  NURA.on('add-to-cart', addFromCard);
  NURA.on('size-close', function () { closePicker(true); });
  NURA.on('size-pick', function (chip) {
    if (!picker || chip.disabled || chip.getAttribute('aria-disabled')) return;   // sold out, or a request already running
    var p = picker;
    chip.classList.add('is-busy');
    p.el.querySelectorAll('.size-chip').forEach(function (c) { c.setAttribute('aria-disabled', 'true'); });
    addVariant(chip.dataset.variant).then(function () {
      closePicker(true);
      if (p.onDone) p.onDone();
    }, function () {
      chip.classList.remove('is-busy');
      p.el.querySelectorAll('.size-chip').forEach(function (c) { c.removeAttribute('aria-disabled'); });
    });
  });
  // Clicking anywhere else closes the picker, like any popover.
  document.addEventListener('click', function (e) {
    if (picker && !picker.el.contains(e.target) && e.target !== picker.trigger && !picker.trigger.contains(e.target)) closePicker(false);
  });

  /* ── Drawer ──────────────────────────────────────────────────────────────────────── */
  var X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function lineHtml(it) {
    var p = it.product, id = esc(it.id), bg = esc(p.cardBg || '#efefed');
    var maxQty = Math.min(it.variant.stock, 10);
    var sized = it.variant.size !== 'ONE SIZE';
    // Photo and name open the product page (Oct 2026). Not for a product taken off the shop:
    // its page no longer exists. The photo link is out of the Tab order and hidden from screen
    // readers: the name link right beside it goes to the same place, and one stop is enough.
    var href = p.isActive === false ? '' : esc(NURA.productUrl(p));
    // lazy: the drawer is drawn (closed, off-screen) on every page load; its photos load when it opens.
    var img = p.imageUrl ? '<img src="' + esc(NURA.photo(p.imageUrl)) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">' : '';
    return '<div class="cart-item' + (it.problem ? ' has-problem' : '') + '" data-id="' + id + '">'
      + (href
          ? '<a class="cart-item__img item-photo" href="' + href + '" tabindex="-1" aria-hidden="true" style="background:' + bg + ';overflow:hidden;">' + img + '</a>'
          : '<div class="cart-item__img" style="background:' + bg + ';overflow:hidden;">' + img + '</div>')
      + '<div><p class="cart-item__brand">' + esc(p.brand) + '</p>'
      + '<p class="cart-item__name">' + (href ? '<a class="item-link" href="' + href + '">' + esc(p.name) + '</a>' : esc(p.name)) + '</p>'
      + (sized ? '<p class="cart-item__size">Size ' + esc(it.variant.size) + '</p>' : '')
      + '<div class="cart-item__qty">'
      + '<button type="button" class="cart-qty-btn" data-action="cart-set" data-id="' + id + '" data-qty="' + (it.qty - 1) + '"'
      +   ' aria-label="Decrease quantity of ' + esc(p.name) + '"' + (it.qty <= 1 ? ' disabled' : '') + '>&minus;</button>'
      + '<span class="cart-qty-num" aria-label="Quantity">' + Number(it.qty) + '</span>'
      + '<button type="button" class="cart-qty-btn" data-action="cart-set" data-id="' + id + '" data-qty="' + (it.qty + 1) + '"'
      +   ' aria-label="Increase quantity of ' + esc(p.name) + '"' + (it.qty >= maxQty ? ' disabled' : '') + '>+</button>'
      + '</div>'
      + (it.problem ? '<p class="cart-item__problem">' + esc(it.problem) + '</p>' : '')
      + '</div>'
      + '<div class="cart-item__right">'
      + '<p class="cart-item__price">' + (it.problem && it.lineTotalKes === 0 ? '&mdash;' : NURA.fmtKsh(it.lineTotalKes)) + '</p>'
      + '<button type="button" class="cart-remove" data-action="cart-remove" data-id="' + id + '" aria-label="Remove ' + esc(p.name) + ' from cart">' + X_ICON + '</button>'
      + '</div></div>';
  }

  function render() {
    var list = byId('cartItems'), footer = byId('cartFooter'), count = byId('cartDrawerCount');
    if (!list) return;
    if (!cart) { list.innerHTML = '<div class="cart-empty"><p class="cart-empty__sub">Loading your cart…</p></div>'; return; }
    if (count) count.textContent = cart.count + ' item' + (cart.count !== 1 ? 's' : '');
    if (footer) footer.style.display = cart.items.length ? 'block' : 'none';
    if (!cart.items.length) {
      list.innerHTML = '<div class="cart-empty"><p class="cart-empty__title">Your cart is empty</p><p class="cart-empty__sub">Add items from any page to get started.</p></div>';
      return;
    }
    // Redrawing replaces the buttons, so note which one had focus (+, − or ×) and put it back
    // on the new one: otherwise a keyboard user's focus drops to the top of the page.
    var had = document.activeElement && list.contains(document.activeElement) && document.activeElement.dataset
      ? { action: document.activeElement.dataset.action, id: document.activeElement.dataset.id, label: document.activeElement.getAttribute('aria-label') } : null;
    list.innerHTML = cart.items.map(lineHtml).join('');
    if (had) {
      var back = [].filter.call(list.querySelectorAll('[data-action="' + had.action + '"]'), function (b) { return b.dataset.id === had.id && b.getAttribute('aria-label') === had.label; })[0];
      if (back && !back.disabled) back.focus();
      else { var any = list.querySelector('button:not([disabled])'); (any || byId('cartClose') || list).focus(); }
    }

    var sub = byId('cartSubtotal'), ship = byId('cartShipping'), tot = byId('cartTotal'), note = byId('cartShipNote');
    if (sub) sub.textContent = NURA.fmtKsh(cart.subtotalKes);
    if (ship) ship.textContent = cart.shipping.feeKes ? NURA.fmtKsh(cart.shipping.feeKes) : 'Free';
    if (tot) tot.textContent = NURA.fmtKsh(cart.totalKes);
    if (note) {
      note.textContent = cart.shipping.awayKes > 0
        ? 'You’re ' + NURA.fmtKsh(cart.shipping.awayKes) + ' away from free delivery.'
        : 'Free delivery unlocked.';
    }
  }

  function open() {
    render();
    var d = byId('cartDrawer'), o = byId('cartOverlay');
    if (d) d.classList.add('open');
    if (o) o.classList.add('open');
    NURA.lockScroll(true);
    NURA.panel.open(d, { focus: byId('cartClose') });
    load().catch(function () {});             // fresh stock and prices every time it opens
  }
  function close() {
    var d = byId('cartDrawer'), o = byId('cartOverlay');
    if (!d || !d.classList.contains('open')) return;
    d.classList.remove('open');
    if (o) o.classList.remove('open');
    NURA.lockScroll(false);
    NURA.panel.close(d);
  }

  NURA.on('cart-set', function (el) {
    write('PATCH', '/cart/items/' + encodeURIComponent(el.dataset.id), { qty: Number(el.dataset.qty) }).catch(function () {});
  });
  NURA.on('cart-remove', function (el) {
    write('DELETE', '/cart/items/' + encodeURIComponent(el.dataset.id)).catch(function () {});
  });

  if (byId('cartClose')) byId('cartClose').addEventListener('click', close);
  if (byId('cartOverlay')) byId('cartOverlay').addEventListener('click', close);
  if (byId('cartClear')) byId('cartClear').addEventListener('click', function () {
    if (confirm('Clear your cart?')) write('DELETE', '/cart').then(close, function () {});
  });
  if (byId('cartCheckout')) byId('cartCheckout').addEventListener('click', function () { location.href = 'checkout.html'; });
  document.querySelectorAll('.nav__cart').forEach(function (btn) { btn.addEventListener('click', open); });
  NURA.onEscape(function () { closePicker(true); close(); });

  // Signing in merges the guest cart on the server; signing out starts an empty guest cart.
  // Either way, ask again. The first nura:auth of a page load is just "who am I", not a change.
  var knownUser;
  document.addEventListener('nura:auth', function (e) {
    var who = e.detail.user ? e.detail.user.email : null;
    if (knownUser !== undefined && knownUser !== who) load().catch(function () {});
    knownUser = who;
  });

  load().catch(function () { /* API asleep: the badge stays hidden until it wakes */ });

  NURA.cart = { open: open, close: close, reload: load, add: addVariant, count: function () { return cart ? cart.count : 0; } };
})();
