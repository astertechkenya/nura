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
});

function load(env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Throwing here stops the process before it listens on a port.
    throw new Error(`Invalid environment configuration:\n${problems}\nSee api/.env.example.`);
  }
  const c = parsed.data;
  const mpesaEnabled = Boolean(c.DARAJA_CONSUMER_KEY && c.DARAJA_CONSUMER_SECRET && c.DARAJA_SHORTCODE
    && c.DARAJA_PASSKEY && c.PUBLIC_API_URL && c.MPESA_CALLBACK_SECRET);
  return Object.freeze({ ...c, mpesaEnabled, isProd: c.NODE_ENV === 'production', isTest: c.NODE_ENV === 'test' });
}

export const config = load(process.env);
export { load as loadConfig }; // exported for tests
