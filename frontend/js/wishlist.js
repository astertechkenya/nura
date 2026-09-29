/* NURA wishlist.js: hearts, badge and drawer.

   Phase 3: two homes for the same list.
   - Signed in: the list lives on the server (/api/wishlist), so it follows you across devices.
   - Guest: the browser keeps just the product codes ("nura-003") in localStorage. Nothing
     private, nothing priced: names, prices and sizes always come from the live catalogue.
   On sign-in the guest list is sent to the server once and the browser copy is cleared. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc, KEY = 'nura_wishlist';
  var byId = function (id) { return document.getElementById(id); };

  var user = null;          // set by auth.js through the nura:auth event
  var items = [];           // product objects, newest first, as drawn in the drawer
  var skus = [];            // what's saved, for hearts and the badge (known before products load)

  /* ── Guest storage: product codes only. Older versions stored whole items (with prices
        typed into the page); keep only their codes. ─────────────────────────────────── */
  function localSkus() {
    return NURA.store.get(KEY, []).map(function (x) { return typeof x === 'string' ? x : x && x.id; })
      .filter(function (s) { return typeof s === 'string' && /^[a-z0-9-]{1,40}$/.test(s); });
  }
  function saveLocal(list) { NURA.store.set(KEY, list); }

  /* ── State → screen ────────────────────────────────────────────────────────────── */
  function syncBadge() {
    var n = skus.length;
    var b = byId('wishlistBadge');
    if (b) { b.textContent = n; b.style.display = n > 0 ? 'flex' : 'none'; }
    var mb = byId('mobWLBadge');
    if (mb) { mb.textContent = n; mb.className = 'mob-badge' + (n > 0 ? ' visible' : ''); }
    var dc = byId('drawerCount');
    if (dc) dc.textContent = n + ' item' + (n !== 1 ? 's' : '');
  }
  function syncHearts() {
    document.querySelectorAll('[data-wishlist-id]').forEach(function (btn) {
      var on = skus.indexOf(btn.dataset.wishlistId) > -1;
      btn.classList.toggle('wishlisted', on);
      btn.setAttribute('aria-label', on ? 'Remove from wishlist' : 'Add to wishlist');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      var svg = btn.querySelector('svg');
      if (svg) { svg.style.fill = on ? 'var(--purple)' : 'none'; svg.style.stroke = on ? 'var(--purple)' : 'currentColor'; }
    });
  }
  function show(list) {                     // list = product objects from the server or catalogue
    items = list;
    skus = list.map(function (p) { return p.sku; });
    syncBadge(); syncHearts(); render();
  }

  /** Guest: turn saved codes into products using the shared catalogue. */
  function showLocal() {
    var codes = localSkus();
    skus = codes; syncBadge(); syncHearts();          // hearts right away, before the catalogue arrives
    if (!codes.length) { show([]); return Promise.resolve(); }
    return NURA.products().then(function (data) {
      var bySku = {};
      data.products.forEach(function (p) { bySku[p.sku] = p; });
      var list = codes.slice().reverse().map(function (s) { return bySku[s]; }).filter(Boolean); // newest first
      if (list.length !== codes.length) saveLocal(list.map(function (p) { return p.sku; }).reverse()); // drop removed products
      show(list);
    }, function () { /* catalogue asleep: hearts and badge still right */ });
  }

  function fromServer(promise) {
    return promise.then(function (d) { show(d.items); })
      .catch(function (err) { NURA.toast(err.message); syncHearts(); throw err; });
  }

  /* ── Actions ───────────────────────────────────────────────────────────────────── */
  function toggle(btn) {
    var sku = btn.dataset.wishlistId;
    if (!sku) return;
    var on = skus.indexOf(sku) > -1;
    // Update the heart immediately; the server call catches up (and undoes it if it fails).
    skus = on ? skus.filter(function (s) { return s !== sku; }) : skus.concat(sku);
    syncHearts(); syncBadge();
    if (user) {
      fromServer(on ? NURA.api('/wishlist/' + encodeURIComponent(sku), { method: 'DELETE' })
                    : NURA.api('/wishlist', { method: 'POST', body: { skus: [sku] } })).catch(function () {});
    } else {
      var codes = localSkus().filter(function (s) { return s !== sku; });
      if (!on) codes.push(sku);
      saveLocal(codes);
      showLocal();
    }
  }
  function remove(sku) {
    if (user) return fromServer(NURA.api('/wishlist/' + encodeURIComponent(sku), { method: 'DELETE' })).catch(function () {});
    saveLocal(localSkus().filter(function (s) { return s !== sku; }));
    showLocal();
  }
  function clearAll() {
    if (user) return fromServer(NURA.api('/wishlist', { method: 'DELETE' })).catch(function () {});
    saveLocal([]);
    show([]);
  }

  /* ── Drawer ────────────────────────────────────────────────────────────────────── */
  var X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var oneSize = function (p) { return p.variants.length === 1; };
  var soldOut = function (p) { return p.totalStock === 0; };

  function render() {
    var list = byId('wishlistItems');
    if (!list) return;
    var footer = byId('wishlistFooter'), addAll = document.querySelector('[data-action="wishlist-add-all"]');
    if (!items.length) {
      list.innerHTML = '<div class="wishlist-empty"><p>Nothing saved yet</p><p>Hit the heart on any product to save it here.</p></div>';
      if (footer) footer.style.display = 'none';
      return;
    }
    if (footer) footer.style.display = 'block';
    // "Add all" only makes sense when there are no sizes to choose; otherwise each row has its own button.
    if (addAll) addAll.hidden = !items.every(function (p) { return oneSize(p) && !soldOut(p); });
    list.innerHTML = items.map(function (p) {
      var bg = esc(p.cardBg || '#efefed');
      // data-wl-sku, not data-sku: [data-sku] means "a product card" to the rest of the site
      // (catalogue hydration, #sku links, counts), and these rows are not cards.
      return '<div class="wishlist-item" data-wl-sku="' + esc(p.sku) + '">'
        + (p.imageUrl
            ? '<div class="wishlist-item__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(p.imageUrl) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;"></div>'
            : '<div class="wishlist-item__img" style="background:' + bg + '"></div>')
        + '<div class="wishlist-item__info">'
        + '<p class="wishlist-item__brand">' + esc(p.brand.name) + '</p>'
        + '<p class="wishlist-item__name">' + esc(p.name) + '</p>'
        + '<p class="wishlist-item__price">' + NURA.fmtKsh(p.priceKes)
        +   (p.onSale ? ' <s class="wishlist-item__was">' + NURA.fmtKsh(p.compareAtKes) + '</s>' : '') + '</p>'
        + (soldOut(p)
            ? '<p class="wishlist-item__out">Sold out</p>'
            : '<button type="button" class="wishlist-item__add" data-action="wishlist-add" aria-label="Add ' + esc(p.name) + ' to cart">Add to cart</button>')
        + '</div>'
        + '<button type="button" class="wishlist-item__remove" data-action="wishlist-remove" data-id="' + esc(p.sku) + '" aria-label="Remove ' + esc(p.name) + ' from wishlist">' + X_ICON + '</button>'
        + '</div>';
    }).join('');
  }

  function open() {
    render();
    byId('wishlistDrawer').classList.add('open');
    byId('wishlistOverlay').classList.add('open');
    NURA.lockScroll(true);
  }
  function close() {
    var d = byId('wishlistDrawer');
    if (!d || !d.classList.contains('open')) return;
    d.classList.remove('open');
    byId('wishlistOverlay').classList.remove('open');
    NURA.lockScroll(false);
  }

  NURA.on('wishlist', toggle);
  NURA.on('wishlist-remove', function (el) { remove(el.dataset.id); });
  NURA.on('open-wishlist', open);
  NURA.on('close-wishlist', close);
  NURA.on('clear-wishlist', function () {
    if (confirm('Clear your entire wishlist?')) { clearAll(); close(); }
  });
  // One row: add it (one size), or show its sizes right there in the row.
  NURA.on('wishlist-add', function (btn) {
    var row = btn.closest('.wishlist-item');
    var p = items.filter(function (x) { return x.sku === row.dataset.wlSku; })[0];
    if (p) NURA.addToCart(p, btn, row, true, function () { NURA.toast('Added to your cart'); });
  });
  // Shown only when every saved item is one size and in stock (see render).
  NURA.on('wishlist-add-all', function (btn) {
    btn.disabled = true;
    items.reduce(function (chain, p) {
      return chain.then(function () {
        return NURA.api('/cart/items', { method: 'POST', body: { variantId: p.variants[0].id, qty: 1 } })
          .catch(function (err) { NURA.toast(p.name + ': ' + err.message); });
      });
    }, Promise.resolve()).then(function () {
      btn.disabled = false;
      close();
      NURA.cart.reload().then(NURA.cart.open, NURA.cart.open);
    });
  });
  NURA.onEscape(close);

  // Who's signed in decides where the list lives.
  document.addEventListener('nura:auth', function (e) {
    var was = user;
    user = e.detail.user;
    if (!user) { if (was) showLocal(); return; }               // signed out: back to this browser's (empty) list
    var codes = localSkus();
    var req = codes.length
      ? NURA.api('/wishlist', { method: 'POST', body: { skus: codes.slice(-50) } })   // move the guest list in, once
      : NURA.api('/wishlist');
    fromServer(req).then(function () { if (codes.length) saveLocal([]); }, function () {});
  });

  showLocal();              // guests (and everyone, until /auth/me answers)
  NURA.wishlist = { count: function () { return skus.length; } };
})();
