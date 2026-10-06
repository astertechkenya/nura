# Security

NURA is a fashion shop (storefront on Netlify, API on Render, PostgreSQL on Neon) that takes
M-Pesa and card payments. This page explains how it is protected, how each protection is
tested, and what is knowingly not covered.

**Found a problem?** Please don't open a public issue. Use **Security → Report a vulnerability**
on this repository (GitHub's private reporting), and I'll reply within a few days.

Payments run in **test mode** (Paystack test keys, Safaricom's Daraja sandbox): no real money
can move through this deployment.

## How it was checked

Every item below was checked **by trying the attack**, in two ways:

- **Automated tests** (`api/test/`, 441 tests) run on every push in GitHub Actions against a
  fresh PostgreSQL. A protection that is removed or broken turns the build red.
- **A live probe** (`api/ops/security-probe.mjs`) tries the attacks that are safe to aim at
  the real site, from the outside, with no secrets. The latest run is at the end of this page.

## The 14 checks

| # | Area | The attack tried | What happens | Proven by |
|---|---|---|---|---|
| 1 | **Prices** | Send your own price or total with a cart line or a checkout; ask for -1, 0 or 1,000 of an item | Refused (400). Prices and totals are read from the database and computed on the server; quantities are whole numbers from 1 to a maximum | `cart.test.js`, `checkout.test.js`, `security.test.js`; probe T1 |
| 2 | **Other people's orders and carts (IDOR)** | Open another shopper's order by its id; reuse, alter or borrow an emailed order link; change a line in someone else's cart | 404 or nothing happens. Guest orders open only in the browser that placed them, or with an HMAC-signed link that expires; account orders need that account | `orders.test.js`, `email.test.js`, `cart.test.js`, `card.test.js`; probe A2, A3 |
| 3 | **Forged payment notifications** | Post a fake "paid" to the M-Pesa callback or the Paystack webhook | M-Pesa: the address holds a secret (404 without it), and even then nothing is marked paid until Safaricom confirms it to us directly. Paystack: the signature is checked (401), and the payment is then verified with Paystack | `mpesa.test.js`, `card.test.js`; probe P1, P2 |
| 4 | **Paying twice, or the wrong amount** | The same payment reported several times at once; a payment for a different amount or currency | Each payment settles exactly once (row lock, conditional updates). A wrong amount is FLAGGED, never paid; the owner is emailed and decides (accept, or reject and refund) | `mpesa.test.js`, `card.test.js`, `email.test.js`, `alerts.test.js` |
| 5 | **Passwords** | Guess a password quickly; use a reset link twice or late; find out whether an email has an account via "forgot password" | Stored with argon2id. The 6th quick attempt is refused. Reset links work once, for 30 minutes. "Forgot password" answers the same way, in the same time, whether or not the account exists | `auth.test.js`, `account.test.js` |
| 6 | **Sessions** | Steal the cookie with page script; fix a session ID before sign-in; reuse a session after signing out or after a password change | The cookie is HttpOnly, SameSite=Lax and Secure. Every sign-in gets a new session ID. Sign-out ends the session on the server. A password change signs out every other device | `auth.test.js`, `account.test.js`; probe S1 |
| 7 | **Cross-site requests (CSRF)** | A page on another website submits a form or `fetch` to NURA's API | Refused (403) when the Origin is another site; the SameSite cookie isn't sent on cross-site posts anyway | `auth.test.js`, `cart.test.js`; probe C1 |
| 8 | **Script injection (XSS)** | A product or customer name like `<img src=x onerror=…>`, in the shop, the product pages, the admin and the emails | Shown as text everywhere. An enforced Content-Security-Policy also stops any injected script from loading or sending data out, and violations are reported | `pages.test.js`, `email.test.js`, `alerts.test.js`, `logging.test.js`; probe H1, H3 |
| 9 | **The admin** | Open the admin API as a stranger or a shopper; guess the 6-digit code from many IP addresses; keep using a demoted admin's session; change something as the demo admin | 401 or 403. The admin needs a password **and** an authenticator code; wrong codes are limited per account, whatever the IP. A demotion applies on the next request. Sessions end after 8 idle hours. The demo admin sees masked data and can't change anything | `admin.test.js`, `customers-admin.test.js`, `products-admin.test.js`; probe A1 |
| 10 | **Unexpected fields (mass assignment)** | Sign up with `"role": "ADMIN"`; add unknown fields to any request | Refused (400). Every request body is checked against a strict schema; the role is never taken from a request | `auth.test.js`, `security.test.js` |
| 11 | **SQL injection** | `' OR '1'='1`, `'; DROP TABLE…`, `UNION SELECT…` and LIKE wildcards in the shop and admin searches | Plain text: no error, no extra rows, nothing dropped. Every query uses parameters; LIKE wildcards are escaped | `security.test.js` |
| 12 | **Floods and abuse** | Many accounts, sign-in attempts or newsletter sign-ups from one shopper; dodge the limit with a fake client-IP header; flood someone's inbox through the newsletter; send many M-Pesa prompts to one phone; flood the CSP report endpoint | Limited (429). The client IP is trusted only from Netlify's signed header. One newsletter email per address per hour; a few prompts per phone per hour; reports are capped | `auth.test.js`, `newsletter.test.js`, `mpesa.test.js`, `logging.test.js` |
| 13 | **Secrets and infrastructure** | Look for keys in the code or its history; fetch `.env` or `.git` from the site; reach production's database with a leaked laptop login | No secrets in the repository or its history (gitleaks in CI, GitHub push protection). Secret files are never served. Production uses its own database and a login that can only read and write rows, over certificate-checked TLS; the server refuses to start otherwise. The laptop and Render use separate secrets and keys. HTTPS only (HSTS) | `config.test.js`, CI `secrets` job; probe L2, H2, H5 |
| 14 | **Leaking personal data** | Make the API fail and read the error; read the logs, error reports and alert emails; export customers into a spreadsheet that runs formulas | Errors are short messages with a request id, never a stack trace or SQL. Logs and Sentry reports drop headers, cookies, query values and database values. Alert emails carry no names, phones or addresses. The demo admin sees masked data. The CSV export is formula-safe. Shoppers can delete their account | `logging.test.js`, `sentry.test.js`, `alerts.test.js`, `customers-admin.test.js`, `account.test.js`; probe L1 |

## Known and accepted

These are deliberate, for a portfolio deployment on free plans:

- **Sign-up says when an email already has an account.** "Forgot password" hides it, but
  sign-up doesn't, as on most shops. Sign-ups are rate-limited, so this can't be used to check
  addresses in bulk. Fully hiding it would need email verification before sign-up.
- **Writes with no Origin header are allowed.** Browsers always send an Origin on cross-site
  writes; a tool that omits it (curl, a script) doesn't have a shopper's cookie, so it can only
  act as itself.
- **Email reaches only the owner's address** until a domain of its own is verified
  (`MAIL_ONLY_TO`); shoppers' emails are held and logged, not sent.
- **Free plans:** Render sleeps after 15 idle minutes (a 30–60 s first load), and Neon can
  restore only the last 6 hours. A real shop would need paid plans and nightly backups.
- **A moderate advisory in a development tool** (esbuild, used by drizzle-kit on the laptop) has
  no fix that doesn't break drizzle-kit. It never runs in production; `npm audit --omit=dev`,
  which CI enforces, is clean.

## Latest live probe

Run on **6 October 2026** against https://nurafashion.netlify.app (API https://nura-api-w1nm.onrender.com):
**15 of 15 passed.** To repeat it: `node ops/security-probe.mjs` from `api/`, then replace this table.

| # | Attack tried | Expected | Actual | Result |
|---|---|---|---|---|
| H1 | Storefront sends an enforced CSP that blocks outside scripts and framing | script-src 'self', frame-ancestors 'none' | enforced, both present | PASS |
| H2 | Storefront: nosniff, no framing, HTTPS-only (HSTS) | all three present | nosniff; DENY; max-age=31536000; includeSubDomains; preload | PASS |
| H3 | A product page (rendered by the API) carries the same CSP | identical to the storefront | identical | PASS |
| H4 | The API hides its framework and sends helmet headers | no X-Powered-By; nosniff | no X-Powered-By; nosniff | PASS |
| H5 | Plain http:// is sent to https:// | 301 to https | 301 → https://nurafashion.netlify.app/ | PASS |
| C1 | A write from another website (Origin: evil.example) is refused | 403 | 403 | PASS |
| S1 | Cookies are HttpOnly, SameSite=Lax and Secure | HttpOnly; SameSite=Lax; Secure | HttpOnly; Secure; SameSite=Lax | PASS |
| A1 | The admin API refuses a stranger | 401 | 401 | PASS |
| A2 | Someone else's order, by guessing its id (IDOR) | 404, nothing shown | 404 | PASS |
| A3 | Account data without signing in | 401 | 401 | PASS |
| T1 | A checkout that sends its own total or price is refused | 400 | 400 | PASS |
| P1 | A forged Paystack "paid" with a wrong signature | 401, nothing changes | 401 | PASS |
| P2 | A forged M-Pesa callback without the secret address | 404, as if it did not exist | 404 | PASS |
| L1 | Malformed input gets a plain error: no stack trace, file paths or SQL | 400, short message | 400, 124 bytes | PASS |
| L2 | Secret files (.env, .git, source, server.py) are not served | none readable | none readable | PASS |
