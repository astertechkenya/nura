/* NURA wishlist.js: hearts, badge and drawer. localStorage until Phase 3 (API for signed-in users). */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc, KEY = 'nura_wishlist';

  function getWL() { return NURA.store.get(KEY, []); }
  function saveWL(v) { NURA.store.set(KEY, v); }

  function toggle(btn) {
    var item = NURA.readCard(btn);
    if (!item) return;
    var items = getWL(), idx = items.findIndex(function (i) { return i.id === item.id; });
    if (idx > -1) items.splice(idx, 1); else items.push(item);
    saveWL(items); syncBadge(); syncHearts();
  }
  function remove(id) {
    saveWL(getWL().filter(function (i) { return i.id !== id; }));
    syncBadge(); syncHearts(); render();
  }

  function syncBadge() {
    var n = getWL().length;
    var b = document.getElementById('wishlistBadge');
    if (b) { b.textContent = n; b.style.display = n > 0 ? 'flex' : 'none'; }
    var mb = document.getElementById('mobWLBadge');
    if (mb) { mb.textContent = n; mb.className = 'mob-badge' + (n > 0 ? ' visible' : ''); }
    var dc = document.getElementById('drawerCount');
    if (dc) dc.textContent = n + ' item' + (n !== 1 ? 's' : '');
  }
  function syncHearts() {
    var ids = getWL().map(function (i) { return i.id; });
    document.querySelectorAll('[data-wishlist-id]').forEach(function (btn) {
      var on = ids.indexOf(btn.dataset.wishlistId) > -1;
      btn.classList.toggle('wishlisted', on);
      btn.setAttribute('aria-label', on ? 'Remove from wishlist' : 'Add to wishlist');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      var svg = btn.querySelector('svg');
      if (svg) { svg.style.fill = on ? 'var(--purple)' : 'none'; svg.style.stroke = on ? 'var(--purple)' : 'currentColor'; }
    });
  }

  var X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function render() {
    var list = document.getElementById('wishlistItems');
    if (!list) return;
    var items = getWL(), footer = document.getElementById('wishlistFooter');
    if (!items.length) {
      list.innerHTML = '<div class="wishlist-empty"><p>Nothing saved yet</p><p>Hit the heart on any product to save it here.</p></div>';
      if (footer) footer.style.display = 'none';
      syncBadge();
      return;
    }
    if (footer) footer.style.display = 'block';
    list.innerHTML = items.map(function (it) {
      var bg = esc(it.bg || '#efefed');
      return '<div class="wishlist-item">'
        + (it.img
            ? '<div class="wishlist-item__img" style="background:' + bg + ';overflow:hidden;"><img src="' + esc(it.img) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;"></div>'
            : '<div class="wishlist-item__img" style="background:' + bg + '"></div>')
        + '<div class="wishlist-item__info">'
        + '<p class="wishlist-item__brand">' + esc(it.brand) + '</p>'
        + '<p class="wishlist-item__name">' + esc(it.name) + '</p>'
        + '<p class="wishlist-item__price">' + esc(it.price) + '</p>'
        + '</div>'
        + '<button class="wishlist-item__remove" data-action="wishlist-remove" data-id="' + esc(it.id) + '" aria-label="Remove">' + X_ICON + '</button>'
        + '</div>';
    }).join('');
    syncBadge();
  }

  function open() {
    render();
    document.getElementById('wishlistDrawer').classList.add('open');
    document.getElementById('wishlistOverlay').classList.add('open');
    NURA.lockScroll(true);
  }
  function close() {
    var d = document.getElementById('wishlistDrawer');
    if (!d || !d.classList.contains('open')) return;
    d.classList.remove('open');
    document.getElementById('wishlistOverlay').classList.remove('open');
    NURA.lockScroll(false);
  }

  NURA.on('wishlist', toggle);
  NURA.on('wishlist-remove', function (el) { remove(el.dataset.id); });
  NURA.on('open-wishlist', open);
  NURA.on('close-wishlist', close);
  NURA.on('clear-wishlist', function () {
    if (confirm('Clear your entire wishlist?')) { saveWL([]); syncBadge(); syncHearts(); close(); }
  });
  NURA.on('wishlist-add-all', function () {
    getWL().forEach(function (it) { NURA.cart.addItem(it); });
    close();
    NURA.cart.open();
  });
  NURA.onEscape(close);

  syncBadge(); syncHearts();
  NURA.wishlist = { count: function () { return getWL().length; } };
})();
