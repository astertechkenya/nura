/* NURA reset.js: the page opened from a password-reset email (reset.html#token=...).

   The token arrives in the URL *fragment* (after #). Browsers never send fragments to any
   server, so the token can't end up in Netlify's or Render's logs or in a Referer header.
   As soon as it's read, it's also removed from the address bar and history. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var byId = function (id) { return document.getElementById(id); };
  var form = byId('resetForm');

  var match = location.hash.match(/token=([A-Za-z0-9_-]{20,200})/);
  var token = match ? match[1] : null;
  history.replaceState(null, '', location.pathname);   // forget the token in the URL

  function show(id) {
    form.hidden = true;
    byId('resetIntro').hidden = true;
    byId(id).hidden = false;
  }
  if (!token) { show('resetInvalid'); return; }

  function error(id, inputId, text) {
    var e = byId(id);
    if (text) e.textContent = text;
    e.classList.add('show');
    if (inputId) { byId(inputId).classList.add('error'); byId(inputId).setAttribute('aria-invalid', 'true'); }
  }
  function clear() {
    form.querySelectorAll('.auth-error').forEach(function (e) { e.classList.remove('show'); });
    form.querySelectorAll('.auth-input').forEach(function (i) { i.classList.remove('error'); i.removeAttribute('aria-invalid'); });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault(); clear();
    var pw = byId('resetPassword').value, again = byId('resetConfirm').value;
    if (pw.length < 8) { error('resetPassErr', 'resetPassword'); return; }
    if (pw !== again) { error('resetConfirmErr', 'resetConfirm'); return; }

    var btn = form.querySelector('.auth-submit');
    btn.disabled = true; btn.textContent = 'Saving…';
    NURA.api('/auth/reset', { method: 'POST', body: { token: token, password: pw } })
      .then(function () { show('resetDone'); }, function (err) {
        if (err.status === 400 && /expired|used/.test(err.message)) { show('resetInvalid'); return; }
        error('resetErr', null, err.message);
      })
      .finally(function () { btn.disabled = false; btn.textContent = 'Save new password'; });
  });
})();
