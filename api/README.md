# NURA API

Node.js + Express 5 + PostgreSQL (Drizzle ORM). Serves the NURA storefront in `../frontend`.

## Run it locally

```powershell
cd api
npm install
copy .env.example .env        # then fill in DATABASE_URL and TEST_DATABASE_URL
npm run db:migrate            # create the tables
npm run db:seed               # load the 21 products and 2 demo accounts
npm test                      # 169 tests against the TEST database
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
    seed.js         Catalogue from ../frontend/js/search.js + seed-overrides.json
  routes/           One file per area of the API
  services/         Business rules with no HTTP in them (order state machine)
  middleware/       Error handling
drizzle/            Generated SQL migrations (committed, never hand-edited)
test/               Vitest + Supertest
```

## Endpoints so far

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` when the database answers |
| GET | `/api/products` | All active products with brand, sizes and stock |
