# NURA API

Node.js + Express 5 + PostgreSQL (Drizzle ORM). Serves the NURA storefront in `../frontend`.

## Run it locally

```powershell
cd api
npm install
copy .env.example .env        # then fill in DATABASE_URL and TEST_DATABASE_URL
npm run db:migrate            # create the tables
npm run db:seed               # load the 21 products and 2 demo accounts
npm test                      # all tests, against the TEST database
npm run dev                   # http://localhost:3000/api/products
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start the API and restart it whenever a file changes |
| `npm start` | Start the API (what Render runs) |
| `npm run db:generate` | After editing `src/db/schema.js`: write a new SQL migration into `drizzle/` |
| `npm run db:migrate` | Apply migrations the database hasn't seen yet |
| `npm run db:seed` | Load or refresh the catalogue. **Development only**: it resets the price, stock and photo of the 21 seeded products, so never run it against production once the shop is live |
| `npm run db:studio` | Browse the database in your browser |
| `npm test` | Run all tests |
| `npm run create-admin -- --email you@x.com --name "You"` | Create or update an admin. Asks for the password (hidden, twice, 12+ characters) and prints a two-factor key once. `--role DEMO_ADMIN` makes a read-only admin; `--reset-2fa` issues a new key. Signs that account out everywhere |

## Layout

```
src/
  app.js            Express app: middleware and routes
  server.js         Starts the server, shuts down cleanly
  config.js         Reads and validates environment variables
  logger.js         Structured logs with secrets redacted
  db/
    schema.js       Every table, with its constraints
    client.js       Connection pool + Drizzle
    migrate.js      Applies drizzle/*.sql
    seed.js         Loads seed-catalogue.json + seed-overrides.json
  routes/           One file per area of the API
  services/         Business rules with no HTTP in them (cart and merge, order state machine, email)
  middleware/       Errors, validation, rate limits, sessions, cross-site (CSRF) check
  lib/              Small helpers (client IP behind the signed Netlify proxy)
drizzle/            Generated SQL migrations (committed, never hand-edited)
test/               Vitest + Supertest
```

## Endpoints so far

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` when the database answers |
| GET | `/api/products` | Active products with brand, sizes and stock. Filters: `department`, `sale=true`, `new=true`, `brand`, `q`, `limit` |
| GET | `/api/products/:slug` | One product, or 404 |
| POST | `/api/auth/register` | `{ name, email, password }` → account created and signed in (5 per hour per shopper) |
| POST | `/api/auth/login` | `{ email, password }` → signed in, or 401 "Incorrect email or password." (5 per 15 min per shopper+email) |
| POST | `/api/auth/logout` | Ends the session on the server |
| GET | `/api/auth/me` | `{ user: { name, email } }` or `{ user: null }` |
| POST | `/api/auth/forgot` | `{ email }` → the same answer whether or not the account exists; in development the link prints in this terminal |
| POST | `/api/auth/reset` | `{ token, password }` → new password, every other device signed out, this one signed in |
| POST | `/api/newsletter` | `{ email }` → `{ ok: true }`, the same answer whatever the address's state (5 per hour per shopper). A new or unconfirmed address gets a confirmation email, at most one an hour |
| POST | `/api/newsletter/confirm` | `{ token }` from the confirmation email (pressed on `newsletter.html`) → confirmed. Expires after 7 days; never undoes an unsubscribe |
| POST | `/api/newsletter/unsubscribe` | `{ token }` from a newsletter's unsubscribe link → unsubscribed. Never expires |
| GET | `/api/cart` | The cart with live prices, line totals, subtotal, delivery fee and "KSh N away from free delivery". Works for guests (httpOnly `nura.guest` cookie) and signed-in shoppers |
| POST | `/api/cart/items` | `{ variantId, qty }` → adds a size (adds to an existing line). 409 above stock or above 10 |
| PATCH | `/api/cart/items/:id` | `{ qty }` → sets a line's quantity (only lines in *your* cart) |
| DELETE | `/api/cart/items/:id` | Removes a line |
| DELETE | `/api/cart` | Empties the cart |
| GET | `/api/wishlist` | Signed-in only: saved products, newest first |
| POST | `/api/wishlist` | `{ skus: [...] }` → saves one or many (a guest's list moves in this way on sign-in) |
| DELETE | `/api/wishlist/:sku` | Unsaves one; `DELETE /api/wishlist` clears |

Signing in (register, login or reset) moves this browser's guest cart into the account: quantities are added, capped at stock and 10, and the guest cart is deleted.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/checkout/options` | Counties, which payment methods work today, COD rules, delivery fee |
| POST | `/api/checkout` | `{ checkoutKey, email, phone, name, addressLine1, area, county, notes?, paymentMethod }` → an order from this browser's cart. Stock is taken in the same transaction; the cart is emptied. Sending the same `checkoutKey` twice returns the same order. 10 per hour per shopper |
| GET | `/api/orders` | Signed-in: order history |
| GET | `/api/orders/:id` | One order, to its owner only (the account, or the guest browser that placed it); 404 for anyone else |
| POST | `/api/orders/:id/pay` | `{ phone? }` → M-Pesa: send another prompt (3 per order, 5 per hour per number). Owner only |
| POST | `/api/payments/mpesa/callback/:secret` | Safaricom's STK result. Server to server; wrong secret = 404 |
| POST | `/api/orders/:id/check` | Card: "I'm back from Paystack". Asks Paystack now and settles the payment. Owner only |
| POST | `/api/payments/paystack/webhook` | Paystack's events, signed (HMAC-SHA512 of the raw body with our secret key); bad signature = 401 |

**How a card payment works.** Checkout opens a payment on Paystack (`/transaction/initialize`, cards and Apple Pay only) and sends the shopper to Paystack's page, so card numbers never reach NURA. Paystack sends them back to `order-confirmed.html?order=…`, which calls `/check`; the signed webhook and the every-minute job are the backups. Every path settles through `/transaction/verify`, and the amount and currency must match.

**How an M-Pesa payment is settled.** Daraja callbacks aren't signed, so a callback never marks anything paid by itself. It makes the API ask Safaricom (`stkQuery`, our credentials, over HTTPS), and only that answer settles the payment. Prompts that get no callback are asked about by the job after a minute. In the sandbox every prompt asks for `DARAJA_SANDBOX_AMOUNT_KES` (1), never the real total.

Unpaid M-Pesa/card orders expire after `PAYMENT_WINDOW_MINUTES` and give their stock back (`src/jobs/`, every minute). COD orders never expire.

## The account page (`account.html`)

| Method | Path | What it does |
|---|---|---|
| GET | `/api/account` | Signed-in only: name, email, member since, and the delivery details from the latest order (decided: no separate address book, so no extra copy of anyone's address). Checkout pre-fills from it |
| POST | `/api/account/password` | `{ currentPassword, newPassword }` → changed; this browser gets a new session, every other device is signed out, and an email says so |
| POST | `/api/account/delete` | `{ password }` → the account, cart, wishlist, sessions and newsletter subscription are deleted; orders are kept (the shop's records) with `user_id` set to null. Admin accounts are refused (they sign the audit log) |

Both POSTs allow 5 wrong passwords per 15 minutes **per account, from any IP** (`limit({ ipToo: false, failuresOnly: true })`), so a stolen session can't spread guesses over many addresses; right answers never count. The admin's 2FA code check uses the same rule.

## The admin (`/admin/`)

Every `/api/admin/*` route re-reads the account's role from the database on each request, so a demoted admin loses access at once. Signed out → 401, shopper → 403. An `ADMIN` must enter a six-digit authenticator code after the password (required in production). The session times out after 8 hours idle. Every change is written to `admin_actions` in the same transaction, with the value before and after. A `DEMO_ADMIN` sees masked names, phones and emails and gets 403 on every change.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/admin/me` | Who's signed in, role, whether a code is still needed |
| POST | `/api/admin/totp` | `{ code }` → unlocks the admin for this session (5 per 15 min) |
| GET | `/api/admin/summary` | The dashboard: to do, by status, refunds due, flagged payments, low stock, last 7 days' takings |
| GET | `/api/admin/orders` | `status` (a status, `TODO` or `REFUND_DUE`), `q` (number, name, phone, email), `page` |
| GET | `/api/admin/orders/:id` | Items, payments, history with who did what, and the next steps allowed |
| POST | `/api/admin/orders/:id/transition` | `{ to, note? }`. Only the moves the state machine allows. Cancelling returns stock and marks a refund due if it was paid |
| POST | `/api/admin/orders/:id/cod-collected` | Cash on delivery: payment PAID (receipt "Cash") and the order DELIVERED together |
| POST | `/api/admin/orders/:id/refunded` | A refund marked due has been sent |
| GET | `/api/admin/products` | Every product, hidden ones too, with stock per size |
| PATCH | `/api/admin/products/:id` | `{ priceKes?, compareAtKes? (null = not on sale), isActive? }`. The was-price must be above the price |
| PATCH | `/api/admin/variants/:id` | `{ stock }` (0–9999) |
| GET | `/api/admin/brands` | Brand names, for the add form's suggestions |
| POST | `/api/admin/uploads/sign` | A signed Cloudinary upload (NURA's folder, JPEG/PNG/WebP/AVIF). 30 an hour per account |
| POST | `/api/admin/products` | A new product: `{ name, brand, department, style?, description?, priceKes, compareAtKes?, sizes: [{ size, stock }], image: { publicId }, imageFocus? }`. On the shop and first in New In at once; the code (`nura-NNN`) and address are made for you; a new brand is created |
| PUT | `/api/admin/products/:id/image` | `{ publicId?, imageFocus? }`: a new photo and/or crop (`top`, `centre`, `bottom`) |
| GET | `/api/admin/customers` | `q` (name or email; the demo admin: name only), `page`. Accounts with orders placed, money in, newsletter status, and the newsletter totals |
| GET | `/api/admin/newsletter.csv` | Confirmed subscribers only. Audited; refused to the demo admin |
| GET | `/api/admin/activity` | The audit log, newest first |

### Product pages (`routes/pages.js`)

| Method | Path | What it does |
|---|---|---|
| GET | `/p/:slug` | The product's page, as HTML: title, description, Open Graph tags (the WhatsApp/Facebook preview card), schema.org Product data (price and stock for Google), and the product itself, inside the shared layout `frontend/product.html`. 404 with `noindex` for unknown or hidden products |
| GET | `/sitemap.xml` | The shop pages and every visible product, for search engines (`frontend/robots.txt` points to it) |

Netlify forwards `/p/*` and `/sitemap.xml` here (`netlify.toml`), and `server.py` does the same locally. The API renders these because link previews and crawlers don't run JavaScript. These pages carry the storefront's security headers (`lib/siteHeaders.js`), and a test fails if that policy and `frontend/_headers` ever differ: **change both together**. Product text goes into the page through `lib/html.js` (`esc` for HTML, `jsonForScript` for the data blocks), never raw.

### Logs and the security policy (Phase 8)

Logs hold no personal data or secrets (`lib/logSafe.js`, `logger.js`): request lines carry only method, path, status and an id, with query values kept only for harmless keys (`page`, `status`…); database errors keep their SQL and error code but lose their parameters and any value Postgres quotes back; fields named like secrets or contact details are redacted. The storefront's Content-Security-Policy (`frontend/_headers`) is **enforced**. Whatever it blocks is reported to `POST /api/csp-report` and logged as "CSP blocked something" with the rule, the blocked origin and path, and the page's path. After a deploy, a burst of those lines means the deploy broke something.

### Newsletter (double opt-in, `routes/newsletter.js`, `lib/newsletterLink.js`)

A sign-up is `pending` until its owner presses the button behind the link in the confirmation email; only `confirmed` addresses are exported. The dates (`confirmed_at`, `unsubscribed_at`) are the record of consent that Kenya's Data Protection Act expects. Links carry the subscriber's random id, signed with `SESSION_SECRET`, never the address. **Every newsletter you send must include that person's unsubscribe link** (`unsubscribeUrl(id)` in `lib/newsletterLink.js`).

### Product photos (Cloudinary, `services/cloudinary.js`)

The browser uploads straight to Cloudinary with a signature the API makes, so the photo never passes through Render and the secret never leaves it. Saving sends only the photo's `public_id`: the API asks Cloudinary whether it really is in `nura/products`, in an allowed format and at most 5 MB (refused uploads are deleted), and builds the image address itself (`f_auto,q_auto`, at most 1200 px wide).

Set up: a free Cloudinary account → Settings → API Keys. Put `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` in `.env` and on Render. Without them the shop works and the admin's photo controls answer "Photo uploads aren't set up yet". The site's security policy (`frontend/_headers`) allows `res.cloudinary.com` for images and `api.cloudinary.com` for uploads.

## Email (`services/mail.js`, `services/emails.js`)

| Email | Sent when | To |
|---|---|---|
| Order received | a cash-on-delivery order is placed | the order's email |
| Order confirmed | an M-Pesa or card payment is confirmed (never before: unpaid orders may expire) | the order's email |
| On its way | the admin marks the order Shipped | the order's email |
| Delivered | the admin marks it Delivered, or records cash collected (COD) | the order's email |
| Cancelled | the admin cancels it; says what was paid and where the refund goes, or that nothing was taken | the order's email |
| Not completed | an unpaid M-Pesa/card order expires (never claims "you weren't charged": a payment can still land) | the order's email |
| Refund due | a payment arrives after the order closed | the order's email |
| Refund sent | the admin marks a due refund as paid | the order's email |
| Welcome | an account is created | the account |
| Reset your password | `/api/auth/forgot` for an existing account | the account |

Rules every email follows: it is sent in the background, after the change that caused it has committed, so it never slows a request and a Resend outage never breaks a checkout. Order emails go out at most once per order and kind (the `order_emails` table's primary key lets one sender through, whatever races), and the admin order screen shows what each customer received.

Guest order emails link to `order-confirmed.html#<id>.<token>`: an HMAC-signed pass, valid 30 days, that `POST /api/orders/:id/open` swaps for access in that browser (`lib/orderLink.js`). Account orders link without a token: you sign in to see them.

| Method | Path | What it does |
|---|---|---|
| POST | `/api/orders/:id/open` | `{ token }` from an order email → this browser may see that guest order. 404 for anything else (20 per 15 min) |

**Without a domain of your own** Resend only delivers to your own address. Set `RESEND_API_KEY`, keep the default `MAIL_FROM`, and set `MAIL_ONLY_TO` to your Resend sign-up email: you get every email, and everyone else's is logged as "held". With a verified domain, set `MAIL_FROM` to it and remove `MAIL_ONLY_TO`.

Run the storefront locally with the API behind it, the way Netlify does it in production:
`npm run dev` here, then `python server.py` from the repository root, then open http://localhost:8000.
