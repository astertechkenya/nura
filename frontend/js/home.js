/* NURA home.js: homepage newsletter. Phase 1 sends the email to POST /api/newsletter
   and shows the toast only after the server answers. */
(function () {
  'use strict';
  var form = document.querySelector('.newsletter__form');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = form.querySelector('[type="email"]');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value)) {
      alert('Please enter a valid email address.');
      return;
    }
    input.value = '';
    var toast = document.getElementById('subToast');
    if (toast) {
      toast.classList.add('show');
      setTimeout(function () { toast.classList.remove('show'); }, 3000);
    }
  });
})();
