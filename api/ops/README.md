# Production database: how it's set up and how to look after it

## The setup (Phase 8)

| | Where | Login | Who has the password |
|---|---|---|---|
| **Production** | its own Neon project, `nura-prod`, database `nura_prod` | `nura_app`: read and write rows, nothing else | Render only (`DATABASE_URL`) |
| | | `neondb_owner` of that project: everything, including migrations | nobody stores it. Copy it from Neon's console into the Read-Host window when you need it |
| Development | the original Neon project, `nura_dev` | `neondb_owner` of that project | your laptop's `.env` |
| Tests | your laptop's local PostgreSQL, `nura_test` | | |

Why: a leaked laptop `.env` can't reach customers' data, and the live API can't drop or alter
tables even if someone found a hole in it. The API refuses to start in production unless it
connects as an app login (not `*_owner`) with `sslmode=verify-full` (`src/config.js`).

`sslmode=verify-full` checks Neon's certificate and the server's name, not only that the line
is encrypted, the way a browser checks a bank's website. Without it, something sitting between
Render and Neon could pose as the database.

## Moving production into its own project (one time)

1. **Neon → New project.** Name it `nura-prod`. Choose the **same region** as the current
   project (the API's queries stay fast) and the **same Postgres version or newer**. Your
   laptop's `pg_dump` must be at least that version; the script checks.
2. In the new project, **Databases → New database**, name `nura_prod`, owner `neondb_owner`.
3. **Connect**, choose database `nura_prod`, and keep the connection string window open. Also
   have the *current* production string ready (Render → Environment → `DATABASE_URL`).
4. **Don't place orders** until step 6 is done: anything written to the old database after the
   copy would stay behind.
5. In PowerShell:
   ```powershell
   cd C:\dev\nura\api
   powershell -ExecutionPolicy Bypass -File ops\move-production.ps1
   ```
   Paste each string at its hidden prompt. The script copies everything, compares every table's
   row count, creates `nura_app` (`ops/app-role.sql`), proves it can't create or drop tables,
   connects exactly as Render will (Node, `sslmode=verify-full`), and puts the API's new
   `DATABASE_URL` on your clipboard. Nothing is shown on screen, and it stops before changing
   anything if a check fails. If it stops *after* "restored", run it again with `-FinishOnly`:
   it skips the copy, re-checks every table and gives `nura_app` a new password.
6. **Render → Environment → `DATABASE_URL`**: paste, Save. Press Enter in the script: the
   clipboard is cleared. Render restarts the API (1 to 2 minutes).
7. **Check:** the shop loads, you can sign in, place a cash-on-delivery order, see it in the
   admin. Render's logs show no `permission denied`. **Close the PowerShell window.**
8. **To go back** (if anything is wrong): put the old `DATABASE_URL` back on Render, and
   redeploy the commit before this change (the old code accepts the old string). The old
   database was never touched.
9. **After a week** on the new one: in the **old** project, delete the `nura_prod` database.
   Until then it's a full copy of customer data with the laptop's login.

## Render's build command

Render must build with **`npm ci`** only. (It used to be `npm ci && npm run db:migrate`, but
`nura_app` can't change tables, so a migration there fails the build.) Migrations run from your
laptop, as below, **before** you push code that needs them. If you forget, the new code
doesn't start: the server checks at startup that every migration in `drizzle/` has run
(`src/db/schemaCheck.js`) and refuses to start in production otherwise. Render then keeps the
previous version running, so the shop stays up while you run the migration.

## Running a migration or create-admin on production from now on

Run migrations **before** pushing the code that needs them. They only add things, so the code
running now carries on unaffected.

1. **Neon → `nura-prod` → Connect.** Database `nura_prod`, Role **`neondb_owner`**, and
   **Connection pooling off** (the host must NOT contain `-pooler`: the pooler is for the app's
   many short queries, not for changing tables). Copy the string.
2. Change `sslmode=require` to `sslmode=verify-full`; keep `&channel_binding=require`. Check it
   starts `postgresql://neondb_owner:`. (Edit in Notepad, copy, close Notepad without saving.)
3. In a **new** PowerShell window:
   ```powershell
   cd C:\dev\nura\api
   $s = Read-Host "nura-prod owner connection string" -AsSecureString
   $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   npm run db:migrate
   ```
   The paste shows as `****`: the owner password never appears on screen or in scrollback.
   `.env` doesn't interfere: Node never overrides a variable that is already set.
4. The first line must say **Migrating nura_prod on ep-lingering-rice… as neondb_owner**, then
   **Migrations applied.** If it names `nura_app`, `nura_dev` or `ep-dawn-silence…`, nothing
   was migrated in production: stop and check the string.
5. **Close the window.** That wipes the password from memory.

`create-admin` works the same way: in step 3, replace the last line with
`npm run create-admin -- --email you@example.com --name "Your Name"`.

Migrations create tables as the owner, and `app-role.sql` set default privileges, so
`nura_app` can use new tables straight away.

**Never** run `npm run db:seed` against production: it resets the 21 seeded products' prices,
stock and photos.

## Testing a restore (do it once, so you know it works before you need it)

Neon keeps a history of every change: on the Free plan, the last **6 hours** (up to 1 GB of
changes). You can restore a database to any moment in that window.

1. Note the time, then change something harmless in the admin (one product's stock).
2. Neon → `nura-prod` → **Backup & restore** (or **Restore**) → choose a time **before** your
   change → restore **to a new branch** (not over production).
3. Connect to that branch's `nura_prod` in Neon's SQL editor and check the stock is the old value.
4. Delete the branch. Put the stock back in the admin.

What to know: 6 hours is short. A mistake noticed tomorrow morning can't be undone this way.
For a live shop, a nightly `pg_dump` kept somewhere safe (or a paid plan's longer history)
covers that. That's a decision for launch.
