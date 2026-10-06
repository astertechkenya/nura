// security-probe.mjs: tries the attacks in SECURITY.md that can be tried safely against the
// LIVE site, and prints the results as a table to paste into SECURITY.md.
//
//   cd C:\dev\nura\api
//   node ops/security-probe.mjs
//
// Safe to run any time: it never signs in, never places an order and never changes anything
// that matters. The one thing it creates is an anonymous guest cart line (to read the cookie's
// flags), which it removes again. It needs no secrets: it attacks from the outside, as a
// stranger would. Exit code 1 if any check fails.
//
// NURA_PROBE_SITE / NURA_PROBE_API point it elsewhere (e.g. a local rehearsal).
const SITE = (process.env.NURA_PROBE_SITE ?? 'https://nurafashion.netlify.app').replace(/\/$/, '');
const API = (process.env.NURA_PROBE_API ?? 'https://nura-api-w1nm.onrender.com').replace(/\/$/, '');
const HTTPS = SITE.startsWith('https://');
const EVIL = 'https://evil.example';

const results = [];
const check = (id, what, expected, actual, pass) => results.push({ id, what, expected, actual: String(actual), pass: Boolean(pass) });
const get = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(90_000), ...init });
const post = (url, body, headers = {}) => get(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// Render's free plan sleeps: wake it first, so a cold start isn't mistaken for a failure.
process.stdout.write('Waking the API (up to a minute on a cold start)… ');
for (let i = 0; i < 6; i++) {
  try { if ((await get(`${API}/api/ping`, { signal: AbortSignal.timeout(20_000) })).ok) break; } catch { /* still asleep */ }
}
console.log('awake.\n');

// 1. Security headers on the storefront and on a product page (rendered by the API).
const home = await get(`${SITE}/`);
const csp = home.headers.get('content-security-policy') ?? '';
check('H1', 'Storefront sends an ENFORCED CSP that blocks outside scripts and framing',
  "script-src 'self', frame-ancestors 'none'", csp ? csp.slice(0, 60) + '…' : '(none)',
  /script-src 'self'(;|$)/.test(csp) && csp.includes("frame-ancestors 'none'") && !home.headers.has('content-security-policy-report-only'));
check('H2', 'Storefront: nosniff, no framing, HTTPS-only (HSTS)', 'all three present',
  ['x-content-type-options', 'x-frame-options', 'strict-transport-security'].map((h) => `${h}=${home.headers.get(h) ?? '-'}`).join('; '),
  home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY'
    && (!HTTPS || /max-age=\d{7,}/.test(home.headers.get('strict-transport-security') ?? '')));
const products = await (await get(`${SITE}/api/products`)).json();
const p = products.products.find((x) => x.totalStock > 0) ?? products.products[0];
const page = await get(`${SITE}/p/${p.slug}`);
// A response can carry the policy twice (the API's, plus Netlify's _headers on the proxied
// path); fetch joins repeats with ", ". Policies contain no commas, so split them back.
const policies = (h) => (h ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const pagePolicies = policies(page.headers.get('content-security-policy'));
const samePolicy = pagePolicies.length > 0 && pagePolicies.every((x) => x === policies(csp)[0]);
check('H3', 'A product page (rendered by the API) carries the same CSP', 'identical to the storefront',
  samePolicy ? `identical${pagePolicies.length > 1 ? ` (sent ${pagePolicies.length} times)` : ''}` : `${page.status}, ${pagePolicies.length ? 'different policy' : 'no policy'}`,
  page.status === 200 && samePolicy);
const apiPing = await get(`${API}/api/ping`);
check('H4', 'The API hides its framework and sends helmet headers', 'no X-Powered-By; nosniff',
  `x-powered-by=${apiPing.headers.get('x-powered-by') ?? '-'}; nosniff=${apiPing.headers.get('x-content-type-options') ?? '-'}`,
  !apiPing.headers.has('x-powered-by') && apiPing.headers.get('x-content-type-options') === 'nosniff');
if (HTTPS) {
  const plain = await get(SITE.replace('https://', 'http://') + '/');
  check('H5', 'Plain http:// is sent to https://', '301 to https', `${plain.status} → ${plain.headers.get('location') ?? '-'}`,
    [301, 308].includes(plain.status) && (plain.headers.get('location') ?? '').startsWith('https://'));
}

// 2. Cross-site requests (CSRF): a write sent from another website's page.
const csrf = await post(`${SITE}/api/cart/items`, { variantId: p.variants[0].id }, { Origin: EVIL });
check('C1', 'A write from another website (Origin: evil.example) is refused', '403', csrf.status, csrf.status === 403);

// 3. Session cookie flags, read from the guest-cart cookie (same settings as the sign-in one).
const add = await post(`${SITE}/api/cart/items`, { variantId: p.variants[0].id });
const cookie = add.headers.get('set-cookie') ?? '';
check('S1', 'Cookies are HttpOnly, SameSite=Lax and (on HTTPS) Secure', 'HttpOnly; SameSite=Lax; Secure',
  cookie.replace(/=[^;]+/, '=…').split(';').slice(1).map((s) => s.trim()).join('; ') || `(no cookie, status ${add.status})`,
  /httponly/i.test(cookie) && /samesite=lax/i.test(cookie) && (!HTTPS || /;\s*secure/i.test(cookie)));
if (add.ok) {                                             // tidy up: remove the line just added
  const jar = cookie.split(';')[0];
  const cart = await (await get(`${SITE}/api/cart`, { headers: { Cookie: jar } })).json();
  for (const line of cart.cart?.items ?? cart.items ?? []) {
    await get(`${SITE}/api/cart/items/${line.id}`, { method: 'DELETE', headers: { Cookie: jar, Origin: SITE } });
  }
}

// 4. Access control.
const admin = await get(`${SITE}/api/admin/summary`);
check('A1', 'The admin API refuses a stranger', '401', admin.status, admin.status === 401);
const order = await get(`${SITE}/api/orders/${crypto.randomUUID()}`);
check('A2', "Someone else's order, by guessing its id (IDOR)", '404, nothing shown', order.status, order.status === 404);
const account = await get(`${SITE}/api/account`);
check('A3', 'Account data without signing in', '401', account.status, account.status === 401);

// 5. Tampering: prices and totals come from the server, never from the request.
const tamper = await post(`${SITE}/api/checkout`, { totalKes: 1, priceKes: 1 });
check('T1', 'A checkout that sends its own total or price is refused before anything happens', '400', tamper.status, tamper.status === 400);

// 6. Forged payment notifications, sent straight to Render as an attacker would.
const paystack = await post(`${API}/api/payments/paystack/webhook`,
  { event: 'charge.success', data: { reference: crypto.randomUUID() } }, { 'x-paystack-signature': 'f'.repeat(128), Origin: '' });
check('P1', 'A forged Paystack "paid" with a wrong signature', '401, nothing changes', paystack.status, paystack.status === 401);
const mpesa = await post(`${API}/api/payments/mpesa/callback/guessed-secret`,
  { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_forged', ResultCode: 0 } } }, { Origin: '' });
check('P2', 'A forged M-Pesa callback without the secret address', '404, as if it did not exist', mpesa.status, mpesa.status === 404);

// 7. Information leaks.
const bad = await post(`${SITE}/api/cart/items`, '{"broken json');
const badText = await bad.text();
check('L1', 'Malformed input gets a plain error: no stack trace, file paths or SQL', '400, short message',
  `${bad.status}, ${badText.length} bytes`, bad.status === 400 && !/\n\s+at |node_modules|[\\/]src[\\/]|\bselect\b[\s\S]*\bfrom\b|\binsert into\b/i.test(badText));
const leaks = [];
for (const path of ['/.env', '/api/.env', '/.git/config', '/api/src/config.js', '/server.py']) {
  const r = await get(`${SITE}${path}`);
  const body = r.ok ? await r.text() : '';
  if (/DATABASE_URL|SESSION_SECRET|\[core\]|sk_(test|live)_|re_[A-Za-z0-9]{10}/.test(body)) leaks.push(path);
}
check('L2', 'Secret files (.env, .git, source, server.py) are not served', 'none readable', leaks.length ? leaks.join(', ') : 'none readable', !leaks.length);

// The table.
const when = new Date().toISOString().slice(0, 10);
console.log(`Live probe of ${SITE} (API ${API}), ${when}\n`);
console.log('| # | Attack tried | Expected | Actual | Result |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.id} | ${r.what} | ${r.expected} | ${r.actual.replace(/\|/g, '\\|')} | ${r.pass ? 'PASS' : '**FAIL**'} |`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
process.exitCode = failed.length ? 1 : 0;
