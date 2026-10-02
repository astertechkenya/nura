/* NURA home.js: homepage newsletter, saved by POST /api/newsletter (pending until the
   emailed link is confirmed on newsletter.html).
   The toast only appears after the server has confirmed; before Phase 1 it appeared
   immediately and the email went nowhere. */
(function () {
  'use strict';
  var NURA = window.NURA;
  var form = document.querySelector('.newsletter__form');
  if (!form) return;

  var input = form.querySelector('[type="email"]');
  var trap = form.querySelector('[name="bot-field"]');   // honeypot, hidden from people
  var button = form.querySelector('[type="submit"]');
  var toast = document.getElementById('subToast');

  function showToast(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 3500);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      input.setAttribute('aria-invalid', 'true');
      showToast('Please enter a valid email address.');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    button.disabled = true;                 // no double submits while waiting

    NURA.api('/newsletter', { method: 'POST', body: { email: email, botField: trap ? trap.value : '' } })
      .then(function () {
        input.value = '';
        showToast('Almost there: check your inbox and confirm.');
      }, function (err) {
        showToast(err.message);             // messages from the API are written for shoppers
      })
      .finally(function () { button.disabled = false; });
  });
})();
