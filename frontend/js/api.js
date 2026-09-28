/* NURA api.js: every request to the backend goes through NURA.api().

   Why a wrapper instead of calling fetch() everywhere:
   - One place decides the URL (/api/..., same origin thanks to the Netlify proxy), the
     JSON handling and the error shape, so every feature behaves the same way.
   - Cold starts. The free Render server sleeps when idle and needs 30-60 s to wake, but
     Netlify's proxy gives up after 26 s and answers 504. Reads (GET) are therefore retried
     with growing pauses until the server is up. Writes (POST...) are never retried
     automatically: repeating a checkout because a response was slow could charge twice. */
(function () {
  'use strict';
  var NURA = window.NURA;

  var RETRY_DELAYS_MS = [2000, 4000, 8000, 15000]; // up to ~2 minutes in total, covering a cold start
  var ATTEMPT_TIMEOUT_MS = 30000;                  // a little longer than Netlify's 26 s limit
  var RETRYABLE = { 502: true, 503: true, 504: true };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function attempt(path, opts) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ATTEMPT_TIMEOUT_MS);
    return fetch('/api' + path, {
      method: opts.method,
      credentials: 'same-origin',                   // sends the session cookie (Phase 2)
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    }).finally(function () { clearTimeout(timer); });
  }

  /** NURA.api('/products?sale=true') or NURA.api('/newsletter', { method: 'POST', body: {...} }).
   *  Resolves with the parsed JSON; rejects with an Error that has .status (0 = network). */
  NURA.api = function (path, opts) {
    opts = opts || {};
    opts.method = (opts.method || 'GET').toUpperCase();
    var canRetry = opts.method === 'GET';

    function run(tryNo) {
      return attempt(path, opts).then(function (res) {
        if (canRetry && RETRYABLE[res.status] && tryNo < RETRY_DELAYS_MS.length) {
          return wait(RETRY_DELAYS_MS[tryNo]).then(function () { return run(tryNo + 1); });
        }
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'Something went wrong. Please try again.');
            err.status = res.status;
            throw err;
          }
          return data;
        });
      }, function (networkError) {
        // No response at all: offline, DNS, or our own timeout while the server wakes up.
        if (canRetry && tryNo < RETRY_DELAYS_MS.length) {
          return wait(RETRY_DELAYS_MS[tryNo]).then(function () { return run(tryNo + 1); });
        }
        var err = new Error('Can’t reach NURA right now. Check your connection and try again.');
        err.status = 0;
        err.cause = networkError;
        throw err;
      });
    }
    return run(0);
  };

  /** The whole catalogue, fetched at most once per page and shared by every script that needs it. */
  var catalogue = null;
  NURA.products = function () {
    if (!catalogue) {
      catalogue = NURA.api('/products').catch(function (err) {
        catalogue = null; // let a later call try again
        throw err;
      });
    }
    return catalogue;
  };
})();
