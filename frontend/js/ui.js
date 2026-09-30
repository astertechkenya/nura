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
  NURA.lockScroll = function (on) { document.body.style.overflow = on ? 'hidden' : ''; };

  /* Reads a product card into a plain object (used by cart and wishlist). */
  NURA.readCard = function (el) {
    var card = el.closest('[data-sku]');
    if (!card) return null;
    var txt = function (sel, d) { var n = card.querySelector(sel); return n ? n.textContent.trim() : d; };
    var img = card.querySelector('img[src]');
    return {
      id: card.dataset.sku,
      brand: txt('.product-card__brand, .product__brand', 'NURA'),
      name: txt('.product-card__name, .product__name', 'Item'),
      price: txt('.product-card__price, .product__price', 'KSh 0'),
      bg: card.dataset.bg || '#efefed',
      img: img ? img.getAttribute('src') : ''
    };
  };

  /* Action router: <button data-action="open-cart close-menu" data-tab="login">.
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
  // Keyboard support for non-button elements such as the subcategory tiles (role="link").
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target.closest('[data-action][role="link"]');
    if (el) { e.preventDefault(); run(el, e); }
  });

  /* Escape closes everything; each module adds its own closer. */
  var closers = [];
  NURA.onEscape = function (fn) { closers.push(fn); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closers.forEach(function (fn) { fn(); });
  });

  /* Custom cursor */
  var cursor = document.getElementById('cursor');
  var ring = document.getElementById('cursorRing');
  if (cursor && ring) {
    var mx = 0, my = 0, rx = 0, ry = 0;
    document.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      cursor.style.left = mx + 'px'; cursor.style.top = my + 'px';
    });
    (function animRing() {
      rx += (mx - rx) * 0.12; ry += (my - ry) * 0.12;
      ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
      requestAnimationFrame(animRing);
    })();
    var HOVER = 'a, button, .category, .product, .product-card, .size-pill, .subcat';
    document.addEventListener('mouseover', function (e) {
      document.body.classList.toggle('cursor-hover', !!e.target.closest(HOVER));
    });
  }

  /* Mobile menu */
  var menuToggle = document.getElementById('menuToggle');
  var mobileMenu = document.getElementById('mobileMenu');
  var menuOverlay = document.getElementById('mobMenuOverlay');
  function openMenu() {
    if (!mobileMenu) return;
    mobileMenu.classList.add('open');
    if (menuOverlay) menuOverlay.classList.add('open');
    NURA.lockScroll(true);
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    if (!mobileMenu || !mobileMenu.classList.contains('open')) return;
    mobileMenu.classList.remove('open');
    if (menuOverlay) menuOverlay.classList.remove('open');
    NURA.lockScroll(false);
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
  }
  NURA.closeMenu = closeMenu;
  if (menuToggle) menuToggle.addEventListener('click', openMenu);
  var menuClose = document.getElementById('menuClose');
  if (menuClose) menuClose.addEventListener('click', closeMenu);
  NURA.on('close-menu', closeMenu);
  document.addEventListener('click', function (e) {
    if (!mobileMenu || !mobileMenu.classList.contains('open')) return;
    if (!mobileMenu.contains(e.target) && !(menuToggle && menuToggle.contains(e.target))) closeMenu();
  });
  NURA.onEscape(closeMenu);

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
    var sku = decodeURIComponent(location.hash.slice(1));
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
  function closeSignout() { if (signout) signout.classList.remove('open'); }
  NURA.on('open-signout', function () { if (signout) signout.classList.add('open'); });
  NURA.on('close-signout', closeSignout);
  NURA.on('confirm-signout', function () {
    closeSignout();
    if (NURA.auth) NURA.auth.logout();
    closeMenu();
  });
  NURA.onEscape(closeSignout);
})();
