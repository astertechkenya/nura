-- app-role.sql: the limited login the live API uses (Phase 8). Run by ops/move-production.ps1,
-- as the production database's owner, once, after the data is copied in.
--
-- nura_app may read and write rows: everything the shop does. It may NOT create, alter or drop
-- tables, or reach any other database. Migrations still run as the owner, from your laptop,
-- through the Read-Host window: the owner password is never stored on Render or in .env.
--
-- Created with SQL on purpose: a role made in Neon's console joins neon_superuser and could
-- read and write every database in the project. A role made here has only what's granted.
-- The password arrives as a psql variable (-v app_password=...), never written in this file.

CREATE ROLE nura_app WITH LOGIN PASSWORD :'app_password';

-- Connect to this database only. (Postgres lets PUBLIC connect to every database by default;
-- in a project that holds only nura_prod, that's this one anyway.)
GRANT CONNECT ON DATABASE nura_prod TO nura_app;
GRANT USAGE ON SCHEMA public TO nura_app;

-- Rows: read, add, change, remove. Sequences: the counters behind order numbers.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nura_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nura_app;

-- Tables and sequences that FUTURE migrations create (run by this same owner) get the same
-- rights automatically, so a new feature doesn't fail in production with "permission denied".
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nura_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO nura_app;

-- Read-only: which migrations have run. The server checks this at startup and refuses to run
-- new code against an older database (src/db/schemaCheck.js).
GRANT USAGE ON SCHEMA drizzle TO nura_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO nura_app;
