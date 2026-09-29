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
  services/         Business rules with no HTTP in them (order state machine, email)
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

Run the storefront locally with the API behind it, the way Netlify does it in production:
`npm run dev` here, then `python server.py` from the repository root, then open http://localhost:8000.
