# move-production.ps1: moves the live NURA database into its own Neon project (Phase 8).
#
#   cd C:\dev\nura\api
#   powershell -ExecutionPolicy Bypass -File ops\move-production.ps1
#
# What it does, in order. It stops at the first thing that looks wrong, before changing anything:
#   1. Asks for two connection strings (typed into hidden prompts, never shown or saved):
#        OLD: today's production database (nura_prod in your current Neon project)
#        NEW: the empty nura_prod in the NEW Neon project, as its owner
#   2. Checks: different projects, the new one is empty, your pg_dump is new enough.
#   3. Copies everything (a dump to a temporary file, then a restore).
#   4. Compares the number of rows in every table, old against new.
#   5. Creates the limited app login nura_app (ops/app-role.sql) with a random password, and
#      proves it can read and write rows but can't create or drop tables.
#   6. Connects exactly as the API on Render will (Node, nura_app, sslmode=verify-full).
#   7. Puts that connection string on your clipboard for Render, waits while you paste it
#      there, then clears the clipboard.
#   8. Deletes the temporary dump file: it holds customers' personal data.
#
# If a run stopped AFTER the copy (the data is in NEW and nura_app exists), finish it with:
#   powershell -ExecutionPolicy Bypass -File ops\move-production.ps1 -FinishOnly
# That skips the copy, re-checks the row counts, gives nura_app a new password and carries on
# from step 5. (The first password was never shown, so it's simply replaced.)
#
# The OLD database is left exactly as it was, so you can go back by restoring Render's old
# DATABASE_URL. Delete it only after a week of the shop running on the new one (ops/README.md).
#
# Written for Windows PowerShell 5.1 (the one built into Windows); also runs on PowerShell 7.
param([switch]$FinishOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Fail($text) { Write-Host ''; Write-Host "STOPPED: $text" -ForegroundColor Red; Write-Host 'Nothing in the OLD database was changed.'; exit 1 }

# A hidden prompt. (The NURA_OPS_* variables exist only so the script can be rehearsed
# automatically against a local Postgres; never set them for the real move.)
function Read-Secret($prompt, $rehearsalVar) {
  $rehearsal = [Environment]::GetEnvironmentVariable($rehearsalVar)
  if ($rehearsal) { return $rehearsal }
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# psql, quietly, returning trimmed text; throws when psql fails.
function Q($url, $sql) {
  $out = & psql $url -X -A -t -v ON_ERROR_STOP=1 -c $sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
  return (($out | Out-String).Trim())
}

$isLocal = { param($h) $h -eq 'localhost' -or $h -eq '127.0.0.1' }

# ---------------------------------------------------------------------------------------------
Step 'Postgres tools'
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  # Not on PATH: use the newest local PostgreSQL install (the one your tests use).
  $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [int]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
  if (-not $found) { Fail 'pg_dump not found. It comes with PostgreSQL (C:\Program Files\PostgreSQL\<version>\bin).' }
  $env:Path = "$($found.DirectoryName);$env:Path"
}
$toolsMajor = [int](((& pg_dump --version) -replace '^\D+', '') -split '\.')[0]
Ok "pg_dump, pg_restore and psql from PostgreSQL $toolsMajor"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'node not found (needed to test the connection exactly as Render makes it).' }

# ---------------------------------------------------------------------------------------------
Step 'Connection strings (typed into hidden prompts; paste, then press Enter)'
$old = Read-Secret 'OLD production string (current nura_prod, as neondb_owner)' 'NURA_OPS_OLD_URL'
$new = Read-Secret 'NEW project string (its nura_prod, as its owner)' 'NURA_OPS_NEW_URL'
foreach ($u in @($old, $new)) {
  if ($u -notmatch '^postgres(ql)?://[^:/@]+:?[^@]*@([^/:?]+)(:\d+)?/([^?]+)') { Fail 'That doesn''t look like a postgresql:// connection string. Copy it again from Neon (Connect > connection string).' }
}
$null = $old -match '@([^/:?]+)(:\d+)?/([^?]+)'; $oldHost = $Matches[1]; $oldDb = $Matches[3]; $oldAt = "$($Matches[1])$($Matches[2])/$($Matches[3])"
$null = $new -match '@([^/:?]+)(:\d+)?/([^?]+)'; $newHost = $Matches[1]; $newDb = $Matches[3]; $newAt = "$($Matches[1])$($Matches[2])/$($Matches[3])"
if ($oldAt -eq $newAt) { Fail 'OLD and NEW are the same database.' }
if ($oldDb -ne 'nura_prod' -or $newDb -ne 'nura_prod') { Fail "Both databases should be called nura_prod (got OLD=$oldDb, NEW=$newDb)." }
Ok "OLD $oldHost / NEW $newHost"

# ---------------------------------------------------------------------------------------------
Step 'Checks before copying'
try {
  $oldMajor = [int][math]::Floor([int](Q $old 'show server_version_num') / 10000)
  $newMajor = [int][math]::Floor([int](Q $new 'show server_version_num') / 10000)
} catch { Fail "Couldn't connect: $($_.Exception.Message)" }
if ($toolsMajor -lt $oldMajor) { Fail "Your pg_dump is PostgreSQL $toolsMajor but the OLD server is $oldMajor. Install PostgreSQL $oldMajor tools (or newer)." }
if ($newMajor -lt $oldMajor) { Fail "The NEW project runs PostgreSQL $newMajor, older than the OLD one ($oldMajor). Create it with $oldMajor or newer." }
Ok "Postgres $oldMajor -> $newMajor"
$existing = [int](Q $new "select count(*) from pg_tables where schemaname in ('public','drizzle')")
$roleExists = [int](Q $new "select count(*) from pg_roles where rolname = 'nura_app'")
if ($FinishOnly) {
  if ($existing -eq 0 -or $roleExists -eq 0) { Fail 'Nothing to finish: NEW has no copied tables or no nura_app. Run without -FinishOnly.' }
  Ok 'finishing a run that already copied the data'
} else {
  if ($existing -ne 0) { Fail "The NEW database already has $existing tables. It must be empty (a fresh project). If an earlier run stopped after copying, run again with -FinishOnly." }
  if ($roleExists -ne 0) { Fail 'The NEW project already has a nura_app login. If an earlier run stopped after copying, run again with -FinishOnly.' }
  Ok 'NEW database is empty'
}

$dump = Join-Path ([IO.Path]::GetTempPath()) ("nura-prod-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
  # -------------------------------------------------------------------------------------------
  if (-not $FinishOnly) {
    Step 'Copying (the shop keeps running on OLD meanwhile; place no orders until this finishes)'
    # --no-owner/--no-privileges: objects belong to whoever restores them (the NEW owner), and
    # the OLD project's grants don't come along: nura_app gets exactly what app-role.sql grants.
    & pg_dump $old -Fc --no-owner --no-privileges -f $dump
    if ($LASTEXITCODE -ne 0) { Fail 'pg_dump failed (message above).' }
    Ok ("dumped {0:N0} KB" -f ((Get-Item $dump).Length / 1KB))
    & pg_restore --no-owner --no-privileges --exit-on-error -d $new $dump
    if ($LASTEXITCODE -ne 0) { Fail 'pg_restore failed (message above). Delete the NEW project''s nura_prod, recreate it empty, and run again.' }
    Ok 'restored'
  }

  # -------------------------------------------------------------------------------------------
  Step 'Comparing every table, row by row count'
  $tables = (Q $old "select schemaname||'.'||quote_ident(tablename) from pg_tables where schemaname in ('public','drizzle') order by 1") -split "`r?`n" | Where-Object { $_ }
  $bad = @()
  foreach ($t in $tables) {
    $a = Q $old "select count(*) from $t"
    try { $b = Q $new "select count(*) from $t" } catch { $b = 'missing' }
    if ($a -ne $b) { $bad += "$t ($a vs $b)" }
  }
  if ($bad.Count) { Fail ("Row counts differ: " + ($bad -join ', ') + '. Was something written to OLD during the copy? Recreate NEW''s nura_prod empty, delete nura_app in NEW, and run again without -FinishOnly.') }
  Ok "$($tables.Count) tables, identical row counts"

  # -------------------------------------------------------------------------------------------
  Step $(if ($FinishOnly) { 'Giving nura_app a new password, and its rights again' } else { 'Creating the limited app login nura_app' })
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $appPassword = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  $sqlFile = Join-Path $PSScriptRoot 'app-role.sql'
  if ($FinishOnly) {
    # The same file, with "create" turned into "change the password". Grants are safe to repeat.
    $tmpSql = Join-Path ([IO.Path]::GetTempPath()) 'nura-app-role-finish.sql'
    (Get-Content $sqlFile) -replace '^CREATE ROLE nura_app WITH LOGIN PASSWORD', 'ALTER ROLE nura_app WITH LOGIN PASSWORD' | Set-Content $tmpSql -Encoding ASCII
    $sqlFile = $tmpSql
  }
  $out = & psql $new -X -q -v ON_ERROR_STOP=1 -v "app_password=$appPassword" -f $sqlFile 2>&1
  if ($FinishOnly) { Remove-Item $sqlFile -Force }
  if ($LASTEXITCODE -ne 0) { Fail "app-role.sql failed: $out" }
  Ok 'done'

  # The API's string: same host and database, the app login, and Neon's certificate checked.
  $app = $new -replace '^postgres(ql)?://[^@]+@', "postgresql://nura_app:$appPassword@"
  $app = $app -replace '([?&])sslmode=[^&]*&?', '$1' -replace '[?&]$', ''
  $app = $app + $(if ($app.Contains('?')) { '&' } else { '?' }) + 'sslmode=verify-full'
  # For psql on this computer: encrypted, but without the certificate check. psql on Windows
  # can't find the trusted certificates ("certificate verify failed"); the certificate is
  # checked properly in the next step, by Node, the way Render will connect.
  $psqlApp = $app -replace 'sslmode=verify-full', $(if (& $isLocal $newHost) { 'sslmode=disable' } else { 'sslmode=require' })

  Step 'Proving what nura_app can and cannot do'
  try { $n = Q $psqlApp 'select count(*) from products' } catch { Fail "nura_app can't read products: $($_.Exception.Message)" }
  Ok "reads rows ($n products)"
  $canWrite = Q $psqlApp "select has_table_privilege('orders','INSERT') and has_table_privilege('orders','UPDATE') and has_table_privilege('orders','DELETE')"
  if ($canWrite -ne 't') { Fail 'nura_app cannot write orders.' }
  Ok 'writes rows'
  $canCreate = Q $psqlApp "select has_schema_privilege('public','CREATE')"
  $ownsAny = [int](Q $psqlApp "select count(*) from pg_tables where tableowner = current_user")
  # neon_superuser exists only on Neon: looked up by oid, so the query also works elsewhere.
  $isSuper = Q $psqlApp "select rolsuper or rolcreaterole or rolcreatedb or coalesce((select pg_has_role(current_user, oid, 'member') from pg_roles where rolname = 'neon_superuser'), false) from pg_roles where rolname = current_user"
  if ($canCreate -eq 't' -or $ownsAny -ne 0 -or $isSuper -eq 't') { Fail 'nura_app has more power than it should (can create tables, owns tables or is a superuser). Was it created in the Neon console? Delete it and run again.' }
  Ok 'cannot create, alter or drop tables'

  # -------------------------------------------------------------------------------------------
  Step 'Connecting exactly as Render will (Node, nura_app, certificate checked)'
  # Node trusts the same certificate authorities on your laptop as on Render, so this is the
  # real test of the string Render gets. The string goes in an environment variable for this
  # one command only (not the command line, which other programs can list).
  $env:NURA_CHECK_URL = $(if (& $isLocal $newHost) { $app -replace 'sslmode=verify-full', 'sslmode=disable' } else { $app })
  Push-Location (Join-Path $PSScriptRoot '..')
  try { $check = & node ops/check-db.mjs 2>&1; $checkCode = $LASTEXITCODE } finally { Pop-Location; Remove-Item Env:NURA_CHECK_URL }
  if ($checkCode -ne 0) { Fail "Node couldn't connect with sslmode=verify-full: $check" }
  Ok "$check"
} finally {
  if (Test-Path $dump) { Remove-Item $dump -Force; Write-Host '   (temporary dump file deleted: it held customer data)' }
}

# ---------------------------------------------------------------------------------------------
Step 'Your turn: Render'
if ([Environment]::GetEnvironmentVariable('NURA_OPS_OLD_URL')) {
  Write-Output "REHEARSAL_APP_URL=$app"         # automated rehearsal only
} else {
  Set-Clipboard -Value $app
  Write-Host '   The API''s new DATABASE_URL is on your clipboard (not shown here).'
  Write-Host '   1. Render > nura-api > Environment > DATABASE_URL > Edit'
  Write-Host '   2. Select the old value, paste (Ctrl+V), Save Changes. Render restarts the API (1-2 minutes).'
  Read-Host  '   Press Enter once it''s saved, and the clipboard will be cleared'
  Set-Clipboard -Value ' '
  Write-Host '   Clipboard cleared.'
}
$old = $null; $new = $null; $app = $null; $psqlApp = $null; $appPassword = $null

Write-Host ''
Write-Host 'Done. Next (see ops/README.md): check the shop, Render''s logs, then close this window.' -ForegroundColor Green
