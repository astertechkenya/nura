/* NURA auth.js: sign-in modal, account dropdown, nav state.
   Browser-only demo accounts until Phase 2 replaces this with the API.
   Stage A fixes: unknown email or wrong password always fails, and signing in
   no longer empties the cart or wishlist. */
(function () {
  'use strict';
  var NURA = window.NURA, USER_KEY = 'nura_user', ACCOUNTS_KEY = 'nura_accounts';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var byId = function (id) { return document.getElementById(id); };

  function getUser() { return NURA.store.get(USER_KEY, null); }
  function saveUser(u) { NURA.store.set(USER_KEY, { name: u.name, email: u.email }); }

  function syncNav() {
    var mwlb = byId('mobWLBadge');
    if (mwlb && NURA.wishlist) {
      var wln = NURA.wishlist.count();
      mwlb.textContent = wln; mwlb.className = 'mob-badge' + (wln > 0 ? ' visible' : '');
    }
    var user = getUser(), icon = byId('accountIcon'), avatar = byId('accountAvatar');
    var msi = byId('mobileSignIn'), mus = byId('mobileUserSection'), mun = byId('mobileUserName');
    if (!icon || !avatar) return;
    if (user) {
      avatar.textContent = user.name.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
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

  function clearErrors() {
    document.querySelectorAll('.auth-error').forEach(function (e) { e.classList.remove('show'); });
    document.querySelectorAll('.auth-input').forEach(function (i) { i.classList.remove('error'); });
  }
  function showError(id, inputId, text) {
    var e = byId(id);
    if (e) { if (text) e.textContent = text; e.classList.add('show'); }
    if (inputId && byId(inputId)) byId(inputId).classList.add('error');
  }

  function switchTab(tab) {
    var isLogin = tab !== 'signup';
    byId('loginTab').classList.toggle('active', isLogin);
    byId('signupTab').classList.toggle('active', !isLogin);
    byId('loginForm').classList.toggle('hidden', !isLogin);
    byId('signupForm').classList.toggle('hidden', isLogin);
    byId('successState').classList.add('hidden');
    clearErrors();
  }
  function openModal(tab) {
    switchTab(tab || 'login');
    byId('authOverlay').classList.add('open');
    byId('authModal').classList.add('open');
    NURA.lockScroll(true);
  }
  function closeModal() {
    var m = byId('authModal');
    if (!m || !m.classList.contains('open')) return;
    byId('authOverlay').classList.remove('open');
    m.classList.remove('open');
    NURA.lockScroll(false);
  }
  function showSuccess(title, sub) {
    byId('loginForm').classList.add('hidden');
    byId('signupForm').classList.add('hidden');
    byId('successState').classList.remove('hidden');
    byId('successTitle').textContent = title;
    byId('successSub').textContent = sub;
    syncNav();
    setTimeout(closeModal, 2000);
  }

  function handleLogin(e) {
    e.preventDefault(); clearErrors();
    var email = byId('loginEmail').value.trim().toLowerCase();
    var pass = byId('loginPassword').value;
    var valid = true;
    if (!EMAIL_RE.test(email)) { showError('loginEmailErr', 'loginEmail'); valid = false; }
    if (!pass) { showError('loginPassErr', 'loginPassword'); valid = false; }
    if (!valid) return;
    var account = NURA.store.get(ACCOUNTS_KEY, []).find(function (a) {
      return String(a.email).toLowerCase() === email && a.password === pass;
    });
    if (!account) {
      // Same message for an unknown email and a wrong password.
      showError('loginErr', null, 'Incorrect email or password.');
      return;
    }
    saveUser(account);
    showSuccess('Welcome back, ' + account.name.split(' ')[0] + '!', 'You are signed in to NURA.');
  }

  function handleSignup(e) {
    e.preventDefault(); clearErrors();
    var name = byId('signupName').value.trim();
    var email = byId('signupEmail').value.trim().toLowerCase();
    var pass = byId('signupPassword').value;
    var valid = true;
    if (!name) { showError('signupNameErr', 'signupName'); valid = false; }
    if (!EMAIL_RE.test(email)) { showError('signupEmailErr', 'signupEmail'); valid = false; }
    if (pass.length < 6) { showError('signupPassErr', 'signupPassword'); valid = false; }
    if (!valid) return;
    var accounts = NURA.store.get(ACCOUNTS_KEY, []);
    if (accounts.some(function (a) { return String(a.email).toLowerCase() === email; })) {
      showError('signupErr', null, 'An account with this email already exists.');
      return;
    }
    var user = { name: name, email: email, password: pass };
    accounts.push(user);
    NURA.store.set(ACCOUNTS_KEY, accounts);
    saveUser(user);
    showSuccess('Welcome to NURA, ' + name.split(' ')[0] + '!', 'Your account has been created.');
  }

  function closeDropdown() { var dd = byId('authDropdown'); if (dd) dd.classList.remove('open'); }
  function logout() { NURA.store.remove(USER_KEY); closeDropdown(); syncNav(); }

  NURA.on('open-auth', function (el) { openModal(el.dataset.tab); });
  NURA.on('close-auth', closeModal);
  NURA.on('auth-tab', function (el) { switchTab(el.dataset.tab); });
  NURA.on('toggle-account', function () {
    if (!getUser()) { openModal('login'); return; }
    var dd = byId('authDropdown');
    if (dd) dd.classList.toggle('open');
  });
  document.addEventListener('click', function (e) {
    var wrap = document.querySelector('.nav__account-wrap'), dd = byId('authDropdown');
    if (dd && wrap && !wrap.contains(e.target)) dd.classList.remove('open');
  });
  if (byId('loginForm')) byId('loginForm').addEventListener('submit', handleLogin);
  if (byId('signupForm')) byId('signupForm').addEventListener('submit', handleSignup);
  NURA.onEscape(closeModal);

  syncNav();
  NURA.auth = { logout: logout, user: getUser };
})();
