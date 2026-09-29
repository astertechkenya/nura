/* NURA auth.js: sign-in modal, forgot password, account dropdown, nav state.

   Phase 2: accounts live on the server. This file never sees a password again after sending
   it, and never stores anything about the account in the browser: the session is an httpOnly
   cookie that JavaScript can't read. "Who am I?" is always asked of GET /api/auth/me. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var byId = function (id) { return document.getElementById(id); };

  // The pre-Phase-2 browser "accounts" held plaintext passwords. Remove them from this browser.
  NURA.store.remove('nura_accounts');
  NURA.store.remove('nura_user');

  var currentUser = null;

  function syncNav() {
    var mwlb = byId('mobWLBadge');
    if (mwlb && NURA.wishlist) {
      var wln = NURA.wishlist.count();
      mwlb.textContent = wln; mwlb.className = 'mob-badge' + (wln > 0 ? ' visible' : '');
    }
    var user = currentUser, icon = byId('accountIcon'), avatar = byId('accountAvatar');
    var msi = byId('mobileSignIn'), mus = byId('mobileUserSection'), mun = byId('mobileUserName');
    if (!icon || !avatar) return;
    if (user) {
      avatar.textContent = user.name.split(/\s+/).filter(Boolean).map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
      avatar.setAttribute('aria-label', 'My account: ' + user.name);
      avatar.classList.add('visible');
      icon.classList.add('hidden');
      if (byId('dropdownName')) byId('dropdownName').textContent = user.name;
      if (msi) msi.style.display = 'none';
      if (mus) mus.style.display = 'block';
      if (mun) mun.textContent = user.name;
    } else {
      avatar.classList.remove('visible');
      icon.classList.remove('hidden');
      if (msi) msi.style.display = 'block';
      if (mus) mus.style.display = 'none';
    }
  }

  function setUser(user) {
    currentUser = user;
    syncNav();
    document.dispatchEvent(new CustomEvent('nura:auth', { detail: { user: user } }));
  }

  /* ── Form helpers ─────────────────────────────────────────────────── */
  function clearErrors() {
    document.querySelectorAll('.auth-error').forEach(function (e) { e.classList.remove('show'); });
    document.querySelectorAll('.auth-input').forEach(function (i) {
      i.classList.remove('error');
      i.removeAttribute('aria-invalid');
    });
  }
  function showError(id, inputId, text) {
    var e = byId(id);
    if (e) { if (text) e.textContent = text; e.classList.add('show'); }
    var input = inputId && byId(inputId);
    if (input) { input.classList.add('error'); input.setAttribute('aria-invalid', 'true'); }
  }
  /** Disables a form's button while a request runs, so a double click can't send twice. */
  function busy(form, on, label) {
    var btn = form.querySelector('.auth-submit');
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait…'; }
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
    btn.disabled = on;
  }

  var FORMS = ['loginForm', 'signupForm', 'forgotForm'];
  function switchTab(tab) {
    var show = tab === 'signup' ? 'signupForm' : tab === 'forgot' ? 'forgotForm' : 'loginForm';
    byId('loginTab').classList.toggle('active', show === 'loginForm');
    byId('signupTab').classList.toggle('active', show === 'signupForm');
    FORMS.forEach(function (id) { if (byId(id)) byId(id).classList.toggle('hidden', id !== show); });
    byId('successState').classList.add('hidden');
    var done = byId('forgotDone');
    if (done) done.hidden = true;
    var forgot = byId('forgotForm');
    if (forgot) forgot.querySelectorAll('.auth-field, .auth-submit').forEach(function (el) { el.hidden = false; });
    clearErrors();
    var first = byId(show) && byId(show).querySelector('input:not([name="bot-field"])');
    if (first && byId('authModal').classList.contains('open')) setTimeout(function () { first.focus(); }, 50);
  }
  function openModal(tab) {
    byId('authOverlay').classList.add('open');
    byId('authModal').classList.add('open');
    NURA.lockScroll(true);
    switchTab(tab || 'login');
  }
  function closeModal() {
    var m = byId('authModal');
    if (!m || !m.classList.contains('open')) return;
    byId('authOverlay').classList.remove('open');
    m.classList.remove('open');
    NURA.lockScroll(false);
  }
  function showSuccess(title, sub) {
    FORMS.forEach(function (id) { if (byId(id)) byId(id).classList.add('hidden'); });
    byId('successState').classList.remove('hidden');
    byId('successTitle').textContent = title;
    byId('successSub').textContent = sub;
    setTimeout(closeModal, 2000);
  }
  var firstName = function (u) { return u.name.split(/\s+/)[0]; };

  /* ── Sign in / sign up / forgot ───────────────────────────────────── */
  function handleLogin(e) {
    e.preventDefault(); clearErrors();
    var form = e.currentTarget;
    var email = byId('loginEmail').value.trim();
    var pass = byId('loginPassword').value;
    var valid = true;
    if (!EMAIL_RE.test(email)) { showError('loginEmailErr', 'loginEmail'); valid = false; }
    if (!pass) { showError('loginPassErr', 'loginPassword'); valid = false; }
    if (!valid) return;

    busy(form, true, 'Signing in…');
    NURA.api('/auth/login', { method: 'POST', body: { email: email, password: pass } })
      .then(function (data) {
        byId('loginPassword').value = '';
        setUser(data.user);
        showSuccess('Welcome back, ' + firstName(data.user) + '!', 'You are signed in to NURA.');
      }, function (err) {
        showError('loginErr', null, err.message);   // "Incorrect email or password." or a rate-limit message
      })
      .finally(function () { busy(form, false); });
  }

  function handleSignup(e) {
    e.preventDefault(); clearErrors();
    var form = e.currentTarget;
    var name = byId('signupName').value.trim();
    var email = byId('signupEmail').value.trim();
    var pass = byId('signupPassword').value;
    var valid = true;
    if (!name) { showError('signupNameErr', 'signupName'); valid = false; }
    if (!EMAIL_RE.test(email)) { showError('signupEmailErr', 'signupEmail'); valid = false; }
    if (pass.length < 8) { showError('signupPassErr', 'signupPassword'); valid = false; }
    if (!valid) return;

    busy(form, true, 'Creating account…');
    NURA.api('/auth/register', { method: 'POST', body: { name: name, email: email, password: pass } })
      .then(function (data) {
        byId('signupPassword').value = '';
        setUser(data.user);
        showSuccess('Welcome to NURA, ' + firstName(data.user) + '!', 'Your account has been created.');
      }, function (err) {
        showError('signupErr', null, err.message);
      })
      .finally(function () { busy(form, false); });
  }

  function handleForgot(e) {
    e.preventDefault(); clearErrors();
    var form = e.currentTarget;
    var email = byId('forgotEmail').value.trim();
    if (!EMAIL_RE.test(email)) { showError('forgotEmailErr', 'forgotEmail'); return; }

    busy(form, true, 'Sending…');
    NURA.api('/auth/forgot', { method: 'POST', body: { email: email } })
      .then(function (data) {
        // The same message whether or not the account exists (the server decides the wording).
        form.querySelectorAll('.auth-field, .auth-submit').forEach(function (el) { el.hidden = true; });
        var done = byId('forgotDone');
        done.textContent = data.message;
        done.hidden = false;
      }, function (err) {
        showError('forgotErr', null, err.message);
      })
      .finally(function () { busy(form, false); });
  }

  /* ── Account menu ─────────────────────────────────────────────────── */
  function closeDropdown() { var dd = byId('authDropdown'); if (dd) dd.classList.remove('open'); }
  function logout() {
    closeDropdown();
    return NURA.api('/auth/logout', { method: 'POST' })
      .catch(function () { /* already signed out, or offline: the UI still resets */ })
      .then(function () { setUser(null); });
  }

  NURA.on('open-auth', function (el) { openModal(el.dataset.tab); });
  NURA.on('close-auth', closeModal);
  NURA.on('auth-tab', function (el) { switchTab(el.dataset.tab); });
  NURA.on('toggle-account', function () {
    if (!currentUser) { openModal('login'); return; }
    var dd = byId('authDropdown');
    if (dd) dd.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    var wrap = document.querySelector('.nav__account-wrap'), dd = byId('authDropdown');
    if (dd && wrap && !wrap.contains(e.target)) dd.classList.remove('open');
  });
  if (byId('loginForm')) byId('loginForm').addEventListener('submit', handleLogin);
  if (byId('signupForm')) byId('signupForm').addEventListener('submit', handleSignup);
  if (byId('forgotForm')) byId('forgotForm').addEventListener('submit', handleForgot);
  NURA.onEscape(closeModal);

  // Arriving from "Create account" on the order-confirmed page: open sign-up with the email
  // from the order already filled in.
  if (location.hash === '#create-account' && byId('authModal')) {
    history.replaceState(null, '', location.pathname);
    openModal('signup');
    try {
      var remembered = sessionStorage.getItem('nura_signup_email');
      if (remembered && byId('signupEmail')) byId('signupEmail').value = remembered;
      sessionStorage.removeItem('nura_signup_email');
    } catch (e) { /* storage blocked: the shopper types it */ }
  }

  // Who is signed in? Asked once per page load. Until it answers, the nav shows "signed out".
  syncNav();
  NURA.api('/auth/me').then(function (data) { setUser(data.user); }, function () { /* API asleep: stay signed-out looking */ });

  NURA.auth = { logout: logout, user: function () { return currentUser; } };
})();
