// config.js: the only place that reads process.env.
//
// Every setting is validated once, at startup. If something is missing or malformed the
// server refuses to start and says exactly what is wrong. That is much better than
// starting "fine" and failing mid-checkout because a key was never set.
import { z } from 'zod';
import { COUNTIES } from './lib/kenya.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // postgres://user:password@host/dbname?sslmode=require  (Neon gives you this string)
  // Production (Render) must use sslmode=verify-full and the app login, never an owner (below).
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // The storefront's public address. Used to build links in emails and payment redirects.
  SITE_URL: z.url().default('http://localhost:8000'),

  // A product counts as "New In" if it arrived within this many days.
  // Keep 30 for a real shop; a portfolio demo that sits untouched for months may want 365.
  NEW_IN_DAYS: z.coerce.number().int().positive().default(30),

  // Signs the session cookie (Phase 2). If someone learned it they could forge sign-ins, so it
  // is long, random, different per environment, and never committed. Changing it signs
  // everybody out, which is exactly what you want if it ever leaks.
  // Optional here because scripts like db:migrate and db:seed don't need it; the web server
  // refuses to start without it (see middleware/session.js).
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters (generate one, see api/.env.example)').optional(),

  // Shared secret between Netlify and this API (Phase 1). Netlify signs every request it
  // proxies with it (the x-nf-sign header). Only signed requests may tell us the shopper's
  // real IP; anyone can type an x-nf-client-connection-ip header, but nobody can forge the
  // signature without this secret. Leave unset locally.
  NETLIFY_PROXY_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),

  // Checkout (Phase 4). Orders at or above the threshold ship free: the marquee's promise.
  FREE_SHIPPING_THRESHOLD_KES: z.coerce.number().int().positive().default(5000),
  SHIPPING_FEE_KES: z.coerce.number().int().nonnegative().default(300),

  // Cash on delivery (Phase 4). Counties where riders collect cash, comma-separated, spelled
  // as in lib/kenya.js. Elsewhere, shoppers pay by M-Pesa or card (Phases 5-6).
  COD_COUNTIES: z.string().default('Nairobi')
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .refine((list) => list.every((c) => COUNTIES.includes(c)), 'each county must be spelled as in src/lib/kenya.js'),
  // Largest order allowed on COD, in KES. Leave unset for no limit (the current decision).
  // A refused parcel costs a delivery both ways, so a limit is the usual first defence.
  COD_MAX_KES: z.coerce.number().int().positive().optional(),
  // How long an unpaid M-Pesa/card order holds its stock before expiring (Phase 5).
  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  // M-Pesa through Safaricom's Daraja API (Phase 5). M-Pesa appears at checkout only when
  // all five DARAJA_* values and MPESA_CALLBACK_SECRET are set.
  DARAJA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  DARAJA_CONSUMER_KEY: z.string().min(1).optional(),
  DARAJA_CONSUMER_SECRET: z.string().min(1).optional(),
  DARAJA_SHORTCODE: z.string().regex(/^\d{5,7}$/, 'must be a paybill or till number').optional(),
  DARAJA_PASSKEY: z.string().min(1).optional(),
  // Where Safaricom sends payment results: the API's own public address (Render), NOT the
  // storefront. Safaricom calls it directly, server to server.
  PUBLIC_API_URL: z.url().optional(),
  // Part of the callback address, so only Safaricom (who we gave it to) knows where to post.
  // Letters, digits, - and _ only: it becomes part of a web address, where / + = would break it.
  MPESA_CALLBACK_SECRET: z.string().min(32, 'must be at least 32 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'may only contain letters, digits, - and _ (generate it with the command in api/.env.example)')
    .optional(),
  // Tests point this at a fake Daraja. Leave unset: the right Safaricom address is chosen
  // from DARAJA_ENV.
  DARAJA_BASE_URL: z.url().optional(),
  // SAFETY: in the sandbox, ask for this many shillings instead of the real order total, so a
  // test prompt can never take a real amount from a real line. Ignored in production.
  DARAJA_SANDBOX_AMOUNT_KES: z.coerce.number().int().positive().default(1),

  // Cards and Apple Pay through Paystack (Phase 6). Only the SECRET key is needed: shoppers
  // type card details on Paystack's own page, never on NURA. sk_test_… in test mode.
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/, 'must be a Paystack secret key (sk_test_… or sk_live_…)').optional(),
  // Tests point this at a fake Paystack. Leave unset.
  PAYSTACK_BASE_URL: z.url().optional(),

  // Email through Resend (Phase 7). Without a key, emails are printed (development) or only
  // logged (production), exactly as before.
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]{10,}$/, 'must be a Resend API key (re_…)').optional(),
  // Who emails come from. onboarding@resend.dev works without a domain of your own, but Resend
  // then only delivers to YOUR account's address: see MAIL_ONLY_TO. With a verified domain,
  // use e.g. "NURA <orders@yourdomain.co.ke>".
  MAIL_FROM: z.string().min(3).default('NURA <onboarding@resend.dev>'),
  // Comma-separated addresses. When set, email goes ONLY to these; anyone else's is logged as
  // held. Set it to your Resend account email while you have no domain (Resend would refuse
  // the others anyway), and remove it once your domain is verified.
  MAIL_ONLY_TO: z.string().optional()
    .transform((s) => (s ? s.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : null))
    // Strict on purpose: "<you@x.com>" or "\"you@x.com\"" would match no real recipient, so every
    // email would be silently held. Better to refuse to start and say why.
    .refine((list) => !list || list.every((a) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(a)),
      'must be plain email addresses like you@example.com: no < >, quotes, spaces or comments on the line; separate several with commas'),
  // Where alerts for YOU go (Phase 8): a payment that needs checking, money owed back to a
  // shopper. One plain address. Must be in MAIL_ONLY_TO while that is set, or the alert is held.
  ALERT_EMAIL: z.string().trim().toLowerCase()
    .regex(/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/, 'must be one plain email address like you@example.com')
    .optional(),
  // Tests point this at a fake Resend. Leave unset.
  RESEND_BASE_URL: z.url().default('https://api.resend.com'),

  // Product photos via Cloudinary (Phase 7). From cloudinary.com → Settings → API Keys. The
  // admin's "upload photo" appears when all three are set. The SECRET signs uploads and never
  // leaves the server.
  CLOUDINARY_CLOUD_NAME: z.string().regex(/^[a-z0-9_-]{1,64}$/i, 'must be your Cloudinary cloud name (letters, digits, - and _)').optional(),
  CLOUDINARY_API_KEY: z.string().regex(/^\d{6,20}$/, 'must be your Cloudinary API key (digits only)').optional(),
  CLOUDINARY_API_SECRET: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'must be your Cloudinary API secret').optional(),
  // Tests point this at a fake Cloudinary. Leave unset.
  CLOUDINARY_API_BASE: z.url().default('https://api.cloudinary.com'),

  // Error reports (Phase 8). Sentry → your project → Settings → Client Keys (DSN). Set it on
  // Render only; leave it unset locally so development errors don't fill the free quota.
  SENTRY_DSN: z.url().regex(/^https:\/\/[0-9a-f]+@[a-z0-9.-]+\.sentry\.io\/\d+$/, 'must be the DSN from Sentry (https://…@….ingest….sentry.io/…)').optional(),
});

function load(env) {
  // "KEY=" with nothing after it means "not set", as in .env.example. Without this, an empty
  // RESEND_API_KEY= or COD_MAX_KES= line would stop the server from starting.
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Throwing here stops the process before it listens on a port.
    throw new Error(`Invalid environment configuration:\n${problems}\nSee api/.env.example.`);
  }
  const c = parsed.data;
  // An alert address outside MAIL_ONLY_TO would be held every time, silently: refuse instead.
  if (c.ALERT_EMAIL && c.MAIL_ONLY_TO && !c.MAIL_ONLY_TO.includes(c.ALERT_EMAIL)) {
    throw new Error('Invalid environment configuration:\n  - ALERT_EMAIL: must also be in MAIL_ONLY_TO, or alerts are never sent\nSee api/.env.example.');
  }
  if (c.NODE_ENV === 'production') {
    const db = new URL(c.DATABASE_URL);
    const rules = [];
    // Check Neon's certificate, not only encrypt: without it, anything that can sit between
    // Render and Neon could pose as the database and read every query.
    if (db.searchParams.get('sslmode') !== 'verify-full') rules.push('DATABASE_URL: production must use ?sslmode=verify-full');
    // The live API reads and writes rows; it must never hold the owner login that can drop
    // tables. Neon names owner logins <database>_owner (neondb_owner…). See ops/README.md.
    if (/_owner$/.test(decodeURIComponent(db.username))) {
      rules.push(`DATABASE_URL: production must connect as the limited app login (nura_app), not ${decodeURIComponent(db.username)}`);
    }
    if (rules.length) throw new Error(`Invalid environment configuration:\n${rules.map((r) => `  - ${r}`).join('\n')}\nSee api/ops/README.md.`);
  }
  const mpesaEnabled = Boolean(c.DARAJA_CONSUMER_KEY && c.DARAJA_CONSUMER_SECRET && c.DARAJA_SHORTCODE
    && c.DARAJA_PASSKEY && c.PUBLIC_API_URL && c.MPESA_CALLBACK_SECRET);
  const cardEnabled = Boolean(c.PAYSTACK_SECRET_KEY);
  const mailEnabled = Boolean(c.RESEND_API_KEY);
  const uploadsEnabled = Boolean(c.CLOUDINARY_CLOUD_NAME && c.CLOUDINARY_API_KEY && c.CLOUDINARY_API_SECRET);
  return Object.freeze({ ...c, mpesaEnabled, cardEnabled, mailEnabled, uploadsEnabled, isProd: c.NODE_ENV === 'production', isTest: c.NODE_ENV === 'test' });
}

export const config = load(process.env);
export { load as loadConfig }; // exported for tests
