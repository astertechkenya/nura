// config.js: the only place that reads process.env.
//
// Every setting is validated once, at startup. If something is missing or malformed the
// server refuses to start and says exactly what is wrong. That is much better than
// starting "fine" and failing mid-checkout because a key was never set.
import { z } from 'zod';

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
  return Object.freeze({ ...c, isProd: c.NODE_ENV === 'production', isTest: c.NODE_ENV === 'test' });
}

export const config = load(process.env);
export { load as loadConfig }; // exported for tests
