// app.js: builds the Express app (middleware + routes) without starting a server.
//
// Keeping "build" separate from "listen" (server.js) lets the tests import the app and
// send it requests with Supertest, with no real port involved.
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { wakeJobs } from './jobs/index.js';
import { config } from './config.js';
import { logger, LOG_OPTIONS } from './logger.js';
import { db } from './db/client.js';
import { productsRouter } from './routes/products.js';
import { newsletterRouter } from './routes/newsletter.js';
import { verifyNetlifySignature } from './lib/clientIp.js';
import { reqSerializer } from './lib/logSafe.js';
import { cspRouter } from './routes/csp.js';
import { pagesRouter } from './routes/pages.js';
import { authRouter } from './routes/auth.js';
import { cartRouter } from './routes/cart.js';
import { wishlistRouter } from './routes/wishlist.js';
import { checkoutRouter } from './routes/checkout.js';
import { ordersRouter } from './routes/orders.js';
import { accountRouter } from './routes/account.js';
import { paymentsRouter } from './routes/payments.js';
import { adminRouter } from './routes/admin.js';
import { sessionMiddleware } from './middleware/session.js';
import { sameOrigin } from './middleware/sameOrigin.js';
import { notFound, errorHandler } from './middleware/errors.js';

export function createApp() {
  const app = express();

  // Netlify (the /api proxy) and Render sit in front of us. Trusting exactly one proxy hop
  // makes req.ip the shopper's real IP (needed for rate limits), without letting a client
  // fake its IP by sending its own X-Forwarded-For header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by'); // don't advertise the framework

  app.use(helmet()); // sensible security headers on every API response

  // One log line per request, each with an ID that is also returned in error responses.
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Render's health check and the uptime monitor call these every few seconds or minutes.
    // Logging each one buries real traffic, so they're served but not logged.
    autoLogging: config.isTest ? false : { ignore: (req) => req.url === '/api/health' || req.url === '/api/ping' },
    // Log only what's needed to trace a request. The default logs every header, including
    // shoppers' IP addresses and cookies: personal data we have no reason to keep
    // (Kenya's Data Protection Act asks for data minimisation).
    serializers: {
      // Only what's needed to trace a request: no headers, no bodies, no personal query values.
      req: reqSerializer(verifyNetlifySignature),
      res: (res) => ({ statusCode: res.statusCode }),
      // pino-http brings its own error serializer; ours removes query parameters (logger.js).
      err: LOG_OPTIONS.serializers.err,
    },
  }));

  app.use(express.json({
    limit: '100kb',                            // rejects oversized bodies before any route sees them
    // Keep the exact bytes for the Paystack webhook: its signature is computed over them.
    verify: (req, res, buf) => { if (req.url.startsWith('/api/payments/')) req.rawBody = buf; },
  }));

  // Liveness: is the API process up? No database query, so Render's health checks and the
  // uptime monitor (which keeps this free server awake) don't keep the database awake too.
  app.get('/api/ping', (req, res) => res.json({ ok: true }));

  // A request that may have opened or settled a payment wakes the payment jobs (jobs/index.js),
  // which otherwise stay quiet so the database can sleep.
  app.use(['/api/checkout', '/api/orders', '/api/payments'], (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', wakeJobs);
    next();
  });

  // Readiness, with the database: for checking by hand after a deploy. Not for monitors that
  // call every few minutes (see /api/ping). It asks the database a trivial question, so
  // "healthy" means the API can actually serve data, not just that the process is running.
  app.get('/api/health', async (req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  });

  // Browsers post Content-Security-Policy violation reports here (see routes/csp.js). Before
  // sameOrigin: a report is not a state-changing request, and some browsers send it without
  // the page's Origin.
  app.use('/api/csp-report', cspRouter);

  app.use(sameOrigin);          // refuse writes triggered by other websites (CSRF)

  // Product pages (/p/:slug) and /sitemap.xml: HTML for shoppers and crawlers (routes/pages.js).
  app.use(pagesRouter);

  app.use('/api/products', productsRouter);   // public and cacheable: no session needed
  app.use('/api/newsletter', newsletterRouter);
  app.use('/api/auth', sessionMiddleware, authRouter);
  app.use('/api/cart', sessionMiddleware, cartRouter);        // guests (cookie) and users (session)
  app.use('/api/wishlist', sessionMiddleware, wishlistRouter); // signed-in only
  app.use('/api/checkout', sessionMiddleware, checkoutRouter);
  app.use('/api/orders', sessionMiddleware, ordersRouter);
  app.use('/api/account', sessionMiddleware, accountRouter);   // signed-in only
  app.use('/api/payments', paymentsRouter);                     // provider callbacks: no session
  app.use('/api/admin', sessionMiddleware, adminRouter);        // gated: see middleware/adminGate.js

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
