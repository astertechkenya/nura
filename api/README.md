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
| `npm run db:seed` | Load or refresh the catalogue (safe to run repeatedly) |
| `npm run db:studio` | Browse the database in your browser |
| `npm test` | Run all tests |

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
| POST | `/api/newsletter` | `{ email }` → `{ ok: true }` (same answer for new and existing addresses; 5 per hour per shopper) |
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

**How an M-Pesa payment is settled.** Daraja callbacks aren't signed, so a callback never marks anything paid by itself. It makes the API ask Safaricom (`stkQuery`, our credentials, over HTTPS), and only that answer settles the payment. Prompts that get no callback are asked about by the job after a minute. In the sandbox every prompt asks for `DARAJA_SANDBOX_AMOUNT_KES` (1), never the real total.

Unpaid M-Pesa/card orders expire after `PAYMENT_WINDOW_MINUTES` and give their stock back (`src/jobs/`, every minute). COD orders never expire.

Run the storefront locally with the API behind it, the way Netlify does it in production:
`npm run dev` here, then `python server.py` from the repository root, then open http://localhost:8000.
