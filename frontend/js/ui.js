/* NURA ui.js: shared helpers, the click-action router, and site-wide UI
   (cursor, mobile menu, nav, scroll reveal, sign-out modal).
   Loaded first on every page. Other files register actions with NURA.on(). */
(function () {
  'use strict';

  var NURA = window.NURA = window.NURA || {};

  /* Helpers */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  NURA.esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  };
  NURA.parseKsh = function (s) { return parseInt(String(s || '0').replace(/[^0-9]/g, ''), 10) || 0; };
  NURA.fmtKsh = function (n) { return 'KSh ' + Number(n).toLocaleString('en-KE'); };
  NURA.store = {
    get: function (key, fallback) {
      try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
    remove: function (key) { try { localStorage.removeItem(key); } catch (e) {} }
  };
  /* Page scroll is locked while any drawer or overlay is open (Oct 2026: worked out from what's
     open, not a plain on/off switch, so closing one of two open panels can't unlock the page
     under the other). Callers still say lockScroll(true/false) after opening/closing. */
  var LOCKING = '.cart-drawer.open, .wishlist-drawer.open, .auth-modal.open, .search-overlay.open';
  NURA.lockScroll = function () {
    document.body.style.overflow = document.querySelector(LOCKING) ? 'hidden' : '';
  };

  /* Drawers and overlays (Oct 2026): a closed one is `inert`, so it's out of the Tab order and
     hidden from screen readers (before, keyboard users tabbed through ~15 invisible controls).
     Opening one moves focus into it and keeps Tab inside it; closing it puts focus back on
     the button that opened it. Used by the cart, wishlist, search, sign-in and sign-out panels.
       NURA.panel.open(el, { focus: element | false })   focus: where to start (default: first control)
       NURA.panel.close(el) */
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var el = e.currentTarget;
    var all = [].filter.call(el.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
    if (!all.length) return;
    var first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  NURA.panel = {
    open: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      if (el.inert || !el._nuraOpen) el._nuraOpener = document.activeElement;
      el._nuraOpen = true;
      el.inert = false;
      if (!el._nuraTrap) { el.addEventListener('keydown', trapTab); el._nuraTrap = true; }
      if (opts.focus === false) return;
      setTimeout(function () {                   // once it's visible (focus() ignores hidden things)
        var target = opts.focus || el.querySelector(FOCUSABLE);
        if (target && !el.contains(document.activeElement)) target.focus();
      }, 60);
    },
    close: function (el) {
      if (!el) return;
      var hadFocus = el.contains(document.activeElement), opener = el._nuraOpener;
      el._nuraOpen = false; el._nuraOpener = null;
      el.inert = true;
      if (hadFocus && opener && document.contains(opener) && opener.focus) opener.focus();
    }
  };
  ['cartDrawer', 'wishlistDrawer', 'authModal', 'searchOverlay', 'signoutOverlay'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && !el.classList.contains('open')) el.inert = true;   // closed at load
  });

  /* Action router: <button data-action="open-auth" data-tab="login">.
     Several actions can be listed, separated by spaces; they run in order. */
  var actions = {};
  NURA.on = function (name, fn) { actions[name] = fn; };
  function run(el, e) {
    el.dataset.action.split(/\s+/).forEach(function (name) {
      if (actions[name]) actions[name](el, e);
    });
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (el) run(el, e);
  });

  /* Escape closes everything; each module adds its own closer. */
  var closers = [];
  NURA.onEscape = function (fn) { closers.push(fn); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closers.forEach(function (fn) { fn(); });
  });

  /* Custom cursor. Mouse only: on touch screens it's hidden by CSS, so skip the work entirely.
     The ring eases after the dot frame by frame, and the loop stops once it has caught up
     (Oct 2026: before, it ran 60 times a second for as long as the page was open, even with
     the mouse still, costing battery). Any movement starts it again. */
  var cursor = document.getElementById('cursor');
  var ring = document.getElementById('cursorRing');
  if (cursor && ring && !window.matchMedia('(pointer: coarse)').matches) {
    var mx = 0, my = 0, rx = 0, ry = 0, looping = false;
    var animRing = function () {
      rx += (mx - rx) * 0.12; ry += (my - ry) * 0.12;
      ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
      if (Math.abs(mx - rx) < 0.5 && Math.abs(my - ry) < 0.5) { looping = false; return; }
      requestAnimationFrame(animRing);
    };
    document.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      cursor.style.left = mx + 'px'; cursor.style.top = my + 'px';
      if (!looping) { looping = true; requestAnimationFrame(animRing); }
    }, { passive: true });
    var HOVER = 'a, button, .category, .product, .product-card, .size-pill, .subcat';
    document.addEventListener('mouseover', function (e) {
      document.body.classList.toggle('cursor-hover', !!e.target.closest(HOVER));
    });
  }

  /* Nav background on scroll */
  var nav = document.getElementById('nav');
  if (nav) {
    window.addEventListener('scroll', function () {
      nav.classList.toggle('scrolled', window.scrollY > 60);
    }, { passive: true });
  }

  /* Scroll reveal */
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('visible'); obs.unobserve(en.target); }
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.reveal, .reveal-stagger').forEach(function (el) { obs.observe(el); });
  } else {
    document.querySelectorAll('.reveal, .reveal-stagger').forEach(function (el) { el.classList.add('visible'); });
  }

  /* Arriving from a search result (page.html#nura-001): bring that card into view and mark it
     briefly, so the shopper sees at once which product they clicked. */
  function showLinkedCard() {
    var sku;
    try { sku = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }   // a broken #50% must not stop this script
    if (!/^[a-z0-9-]{1,40}$/.test(sku)) return;              // only product IDs, nothing else
    var card = document.querySelector('[data-sku="' + sku + '"]');
    if (!card) return;
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    card.classList.add('is-linked');
    setTimeout(function () { card.classList.remove('is-linked'); }, 2400);
  }
  // The cards are rendered from the API (grid.js), so look for the linked one once they exist.
  showLinkedCard();
  document.addEventListener('nura:grid', showLinkedCard);
  window.addEventListener('hashchange', showLinkedCard);   // result on the page you're already on

  /* Sign-out confirmation */
  var signout = document.getElementById('signoutOverlay');
  function closeSignout() {
    if (!signout || !signout.classList.contains('open')) return;
    signout.classList.remove('open');
    NURA.panel.close(signout);
  }
  NURA.on('open-signout', function () {
    if (!signout) return;
    signout.classList.add('open');
    NURA.panel.open(signout, { focus: signout.querySelector('[data-action="close-signout"]') });   // start on Cancel
  });
  NURA.on('close-signout', closeSignout);
  NURA.on('confirm-signout', function () {
    closeSignout();
    if (NURA.auth) NURA.auth.logout();
  });
  NURA.onEscape(closeSignout);

  /* ── Phones: the tab bar (Oct 2026) ──
     Shows when the page opens and whenever you scroll down, then slides away after 2 s
     without scrolling, so it's there when you're moving around and out of the way while
     you look. It stays while your finger or keyboard focus is on it. */
  var tabbar = document.querySelector('.tabbar');
  if (tabbar) {
    var hideTimer, lastY = window.scrollY, holding = false;
    var show = function () {
      tabbar.classList.add('is-shown');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { if (!holding) tabbar.classList.remove('is-shown'); }, 2000);
    };
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      if (y > lastY) show();          // scrolling down
      lastY = y;
    }, { passive: true });
    // A finger on the bar, or keyboard focus in it: keep it up until they leave.
    var hold = function () { holding = true; tabbar.classList.add('is-shown'); clearTimeout(hideTimer); };
    var release = function () { holding = false; show(); };
    tabbar.addEventListener('touchstart', hold, { passive: true });
    tabbar.addEventListener('touchend', release);
    tabbar.addEventListener('focusin', hold);
    tabbar.addEventListener('focusout', function (e) { if (!tabbar.contains(e.relatedTarget)) release(); });
    show();                            // on arrival, so shoppers learn it's there
  }

  /* ── "Are you sure?" (Oct 2026): one confirmation box for anything that can't be undone ──
     Used by Delete account (account.js) and Delete product (the admin). A real <dialog> opened
     with showModal(): the browser keeps focus inside it, Escape cancels, and the page behind
     can't be clicked. Focus goes back to the button that opened it when it closes.

     NURA.confirmDialog({
       title:    'Delete your account?',
       text:     'Are you sure you want to…',         (plain text, escaped here)
       confirm:  'Delete account',                     (the red button's label)
       cancel:   'Keep order',                         (optional: the safe button's label; default 'Cancel')
       password: 'Enter your password to confirm',     (optional: adds a password field)
       onConfirm: function (password) { return promise; }
     })
     While onConfirm's promise runs, the buttons are disabled. If it fails, its message shows
     inside the box and the box stays open; if it succeeds, the box closes. */
  NURA.confirmDialog = function (o) {
    var esc = NURA.esc, opener = document.activeElement;
    var d = document.createElement('dialog');
    d.className = 'nura-confirm';
    d.setAttribute('aria-labelledby', 'nuraConfirmTitle');
    d.setAttribute('aria-describedby', 'nuraConfirmText');
    d.innerHTML = '<form method="dialog" novalidate>'
      + '<h2 class="nura-confirm__title" id="nuraConfirmTitle">' + esc(o.title) + '</h2>'
      + '<p class="nura-confirm__text" id="nuraConfirmText">' + esc(o.text) + '</p>'
      + (o.password ? '<label class="nura-confirm__label" for="nuraConfirmPw">' + esc(o.password) + '</label>'
          + '<input class="auth-input nura-confirm__input" type="password" id="nuraConfirmPw" autocomplete="current-password" maxlength="128">' : '')
      + '<p class="nura-confirm__msg" role="alert"></p>'
      + '<div class="nura-confirm__actions">'
      +   '<button type="button" class="nura-confirm__cancel" value="cancel">' + esc(o.cancel || 'Cancel') + '</button>'
      +   '<button type="submit" class="nura-confirm__ok" value="ok">' + esc(o.confirm) + '</button>'
      + '</div></form>';
    document.body.appendChild(d);
    var form = d.querySelector('form'), msg = d.querySelector('.nura-confirm__msg');
    var pw = d.querySelector('#nuraConfirmPw'), buttons = d.querySelectorAll('button');
    var busy = false;
    function done() {
      d.close(); d.remove();
      if (opener && opener.isConnected && opener.focus) opener.focus();
    }
    d.querySelector('.nura-confirm__cancel').addEventListener('click', function () { if (!busy) done(); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); if (!busy) done(); });   // Escape
    d.addEventListener('click', function (e) { if (e.target === d && !busy) done(); });     // the dimmed backdrop
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      if (pw && !pw.value) { msg.textContent = 'Please enter your password.'; pw.focus(); return; }
      busy = true; msg.textContent = '';
      buttons.forEach(function (b) { b.disabled = true; });
      Promise.resolve(o.onConfirm(pw ? pw.value : undefined)).then(function () { busy = false; done(); }, function (err) {
        busy = false;
        buttons.forEach(function (b) { b.disabled = false; });
        msg.textContent = (err && err.message) || 'Something went wrong. Please try again.';
        if (pw) { pw.value = ''; pw.focus(); }
      });
    });
    d.showModal();
    // Start on the safe choice (Cancel), or on the password when one is asked for.
    (pw || d.querySelector('.nura-confirm__cancel')).focus();
    return d;
  };
})();
