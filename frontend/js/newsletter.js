/* NURA newsletter.js: the page the newsletter emails link to (newsletter.html), Phase 7.

     #confirm.<token>   "Yes, subscribe me"   → POST /api/newsletter/confirm
     #unsub.<token>     "Unsubscribe"         → POST /api/newsletter/unsubscribe

   Nothing happens until the person presses the button. Mail scanners (Outlook, antivirus) open
   every link in an email to check it; if opening the page were enough, they would confirm or
   unsubscribe people on their own. The token is read from the #fragment, which browsers never
   send to a server, and is wiped from the address bar once read, so it isn't left in history. */
(function () {
  'use strict';
  var NURA = window.NURA, esc = NURA.esc;
  var main = document.getElementById('nlMain');
  var m = /^#(confirm|unsub)\.(.+)$/.exec(location.hash);
  if (m) history.replaceState(null, '', location.pathname);

  var PAGES = {
    confirm: {
      title: 'Confirm your subscription', text: 'New drops and offers from NURA, a few times a month. No spam, and every email has a one-click unsubscribe.',
      button: 'Yes, subscribe me', path: '/newsletter/confirm',
      done: ['You’re subscribed', 'Thank you. The next drop lands in your inbox.'],
    },
    unsub: {
      title: 'Unsubscribe', text: 'You’ll stop getting NURA’s newsletter at this address. Order emails (receipts, delivery updates) still come.',
      button: 'Unsubscribe', path: '/newsletter/unsubscribe',
      done: ['You’re unsubscribed', 'You won’t get the newsletter any more. Changed your mind? Sign up again on the homepage.'],
    },
  };

  function card(title, body) {
    main.innerHTML = '<section class="oc-card"><h1 class="co-title" id="nlTitle" tabindex="-1" style="font-size:36px;">' + esc(title) + '</h1>' + body + '</section>';
    document.getElementById('nlTitle').focus();   // screen readers hear the new state
  }

  if (!m) {
    card('This link is incomplete', '<p class="co-hint" style="margin-top:10px;font-size:13px;">Open the link straight from the email. If your email app split it over two lines, copy the whole thing.</p>'
      + '<a class="co-link" href="index.html">Back to the shop &rarr;</a>');
    return;
  }

  var page = PAGES[m[1]], token = m[2];
  card(page.title, '<p class="co-hint" style="margin:10px 0 18px;font-size:13px;">' + esc(page.text) + '</p>'
    + '<p class="ac-msg" id="nlMsg" role="alert"></p>'
    + '<button class="auth-submit" type="button" id="nlGo" style="padding:15px 26px;">' + esc(page.button) + '</button>');

  document.getElementById('nlGo').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    NURA.api(page.path, { method: 'POST', body: { token: token } }).then(function () {
      card(page.done[0], '<p class="co-hint" style="margin-top:10px;font-size:13px;">' + esc(page.done[1]) + '</p>'
        + '<a class="co-link" href="new-in.html">See what’s new &rarr;</a>');
    }, function (err) {
      document.getElementById('nlMsg').textContent = err.message;
      btn.disabled = false;
    });
  });
})();
