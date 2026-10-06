# NURA: from a static page to a shop that takes M-Pesa

**Role:** design, frontend, backend, operations (solo) · **Timeline:** late September to
6 October 2026 · **Live:** [nurafashion.netlify.app](https://nurafashion.netlify.app)

## The starting point

NURA began as a good-looking static fashion site: HTML pages with the products typed straight
into them, prices as text like `'KSh 14,200'`, and a cart that lived in the browser and vanished
with it. It looked like a shop and couldn't sell anything.

The goal was to make it a real one, for the way people in Kenya actually pay:

- **M-Pesa first.** A prompt on the shopper's phone, confirmed with their PIN.
- **Cards second**, through Paystack.
- **Cash on delivery** in Nairobi, because many shoppers still won't pay up front for clothes
  they haven't seen.

There were three constraints: one person, no budget (every service on a free plan), and no
cutting corners on money or personal data.

## How it was built

In nine phases, each ending with a test that proves it works ("done when…"):

| Phase | What it added |
|---|---|
| A | Cleaned up the static site: version control, escaping, broken links, one source for the catalogue |
| 0 | An API and a database, deployed; the catalogue moved out of the HTML into PostgreSQL |
| 1 | The pages load products from the API; change a price in the database and the site follows |
| 2 | Accounts: sign-up, sign-in, sessions, password reset |
| 3 | A server-side cart and wishlist that follow you between devices |
| 4 | Checkout and orders, with stock held while you pay, and cash on delivery |
| 5 | M-Pesa through Safaricom's Daraja API |
| 6 | Cards through Paystack |
| 7 | The admin, emails, the account page, product pages, photos, the newsletter |
| 8 | Hardening: an enforced security policy, a separate production database, monitoring, CI, a security review |

The storefront stayed plain HTML, CSS and JavaScript. It already existed and worked, and every
page still loads fast with no build step. The API is Node.js with Express and PostgreSQL.

## Six problems worth telling

### 1. Money must move exactly once, whatever arrives

A payment can be reported several times, at once, by different messengers: Safaricom's
callback, Paystack's webhook, the shopper coming back from the card page, and a background job
that asks about anything still open. Any of them can be late, repeated or **forged**: the
callback address is public.

So the system never believes a messenger. A callback only *triggers* a question to the
provider ("what happened to payment X?"), and only the provider's direct answer changes
anything. Every change is a conditional update ("…where status is still PENDING") taken under a
row lock, so however many answers race, exactly one of them settles the payment and sends the
confirmation email.

The tests fire three signals at the same moment and check for one payment, one status change
and one email. They also post forged "paid" messages and check that nothing changes.

### 2. A payment for the wrong amount

What if M-Pesa reports a payment of KSh 240 for a KSh 2,400 order? The first version handled
the money correctly (the order stayed unpaid, marked FLAGGED), but adding an alert email
exposed two real problems:

- The owner had **no way to act on it**. The order expired on schedule, its stock went back on
  sale, and the shopper was told the order "wasn't completed", even though money had arrived.
- The database **never recorded what actually arrived**. It kept only the amount requested, so
  a refund email would have promised KSh 2,400 back for a KSh 240 payment.

The fix: a column for the amount actually received, and two decisions in the admin, each
needing a second tap:

- **Accept**, possible only while the stock is still held.
- **Reject**, which makes the real amount due as a refund and tells the shopper they can still
  pay the right amount.

The owner is emailed the moment it happens. If that email fails, the error reporting catches it
instead.

### 3. Free plans have rules, and they shape the design

**Render's free plan sleeps** after 15 idle minutes and takes 30–60 seconds to wake.
Netlify's proxy gives up after 26 seconds. So the first visitor after a quiet spell would
simply get errors. The storefront now retries reads with growing pauses, for up to about two
minutes, and shows placeholders meanwhile. **Writes are never retried automatically**:
repeating a slow checkout could charge someone twice.

**Neon's free plan allows about 100 compute-hours a month**, which runs out if anything keeps
the database awake around the clock. So:

- The background payment jobs go quiet whenever no payment is open, and wake when a checkout
  starts.
- The uptime monitor calls an endpoint that never touches the database.
- Expired sessions are cleaned up every six hours instead of every few minutes.

**Netlify charges credits per production deploy.** A push that only changes the API therefore
skips the storefront build entirely.

### 4. Trusting the shopper's IP address

Rate limits (5 sign-ups an hour, 5 password guesses per 15 minutes) need the shopper's real IP
address. Behind Netlify's proxy, the API sees Netlify's address, and a header claiming to carry
the real one can be faked by anyone calling the API directly.

The proxy is **signed**: Netlify adds a token signed with a secret that only Netlify and the API
hold, and the API believes the client-IP header only when that token checks out. A test sends a
fake IP header without the signature and shows the limit still applies.

### 5. A cache that served 18-minute-old prices

During a live check, a price changed in the admin didn't appear on the site, even after a hard
refresh. The catalogue was sent as `public, stale-while-revalidate`, which allowed Netlify's CDN
to store it and keep serving the old copy after quiet spells.

It is now `private` (only the shopper's own browser may cache it, for 30 seconds), plus a header
read only by Netlify's CDN telling it never to store it. Checkout re-prices everything on the
server regardless, so a stale page could never change what anyone pays. But a shop that shows
yesterday's prices still looks broken.

### 6. Moving production to a database that can't be dropped

At first, production lived beside development, behind the same all-powerful login that the
laptop also held. Phase 8 moved it into its own database project, copied with a script that
compares every table's row count. The live API connects as a login that **can read and write
rows but cannot create, change or drop anything**, over a connection that checks the
database's certificate. The API refuses to start in production without both.

The first deploy afterwards failed, and the failure was instructive. Render's build had always
run the migrations, and the new limited login rightly wasn't allowed to. Migrations now run from
the laptop as the owner, entered through a hidden prompt, *before* pushing. The server checks at
startup that every migration has run, and refuses to start otherwise. Render then keeps the
previous version running, so a forgotten migration can never take the shop down.

## Security

Every protection was checked by trying the attack. That covers prices sent by the browser,
guessing someone else's order, forged payment messages, script injection, cross-site requests,
SQL injection, floods, and secrets in the code's history. 441 automated tests do this on every
push. A probe tries the safe-to-try attacks against the live site, and its latest run passed
15 of 15. [SECURITY.md](../SECURITY.md) lists all 14 areas, the test behind each, and what is
deliberately accepted.

Other measures:

- The admin needs a password **and** an authenticator code; wrong codes are limited per account,
  not per IP, so spreading guesses over many addresses doesn't help.
- An enforced Content-Security-Policy means even injected markup couldn't load a script.
- Logs, error reports and alert emails are scrubbed of personal data.
- A read-only demo admin sees everything with names, phones and addresses masked.

## In numbers

| | |
|---|---|
| Automated tests | 441 API tests across 25 files, run against a real PostgreSQL on every push |
| Live security probe | 15 of 15 attacks refused (6 Oct 2026) |
| Code | about 5,200 lines of API, 4,100 of tests, 3,000 of storefront JavaScript |
| Database | 16 tables, 7 migrations |
| Photo weight | women's page down from about 2.0 MB to 0.74 MB on a phone, 0.50 MB on a desktop |
| Running cost | KSh 0 a month (free plans) |

## Not done, on purpose

- **Real money.** Paystack live mode and Safaricom production access each need a registered
  business, and email to customers needs a domain of its own. These are business steps, not
  code changes.
- **Paid hosting.** A real shop shouldn't make its first visitor wait a minute, or depend on a
  six-hour restore window. That needs paid plans and nightly backups.
- **Scale features.** The whole catalogue loads at once, which is fine for a boutique of 21
  products. Past about 150, it should load in pages and filter on the server.

## What I'd take to the next project

- **Decide the money rules before writing code.** The order and payment state machine was
  written down in phase 0, and every later feature had to fit it. That's why an admin can't
  "mark an order paid": only a payment provider can.
- **Write the test that fails first.** Several bugs here, like the stale cache, a race between
  scripts, and the sort order, were fixed by first writing a test that showed them, then
  making it pass.
- **Free plans are a design constraint, not a footnote.** Sleeping servers, compute-hour
  budgets and deploy credits all changed the architecture, and the design is better for having
  planned for them.
