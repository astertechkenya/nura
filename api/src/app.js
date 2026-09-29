// app.js: builds the Express app (middleware + routes) without starting a server.
//
// Keeping "build" separate from "listen" (server.js) lets the tests import the app and
// send it requests with Supertest, with no real port involved.
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { config } from './config.js';
import { logger } from './logger.js';
import { db } from './db/client.js';
import { productsRouter } from './routes/products.js';
import { newsletterRouter } from './routes/newsletter.js';
import { verifyNetlifySignature } from './lib/clientIp.js';
import { authRouter } from './routes/auth.js';
import { cartRouter } from './routes/cart.js';
import { wishlistRouter } from './routes/wishlist.js';
import { checkoutRouter } from './routes/checkout.js';
import { ordersRouter } from './routes/orders.js';
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
    // Render calls /api/health every few seconds. Logging each one buries real traffic,
    // so health checks are served but not logged.
    autoLogging: config.isTest ? false : { ignore: (req) => req.url === '/api/health' },
    // Log only what's needed to trace a request. The default logs every header, including
    // shoppers' IP addresses and cookies: personal data we have no reason to keep
    // (Kenya's Data Protection Act asks for data minimisation).
    serializers: {
      // viaNetlify: true when the request came through our signed Netlify proxy. If storefront
      // requests ever log false in production, the NETLIFY_PROXY_SECRET values don't match.
      req: (req) => ({ id: req.id, method: req.method, url: req.url,
                       viaNetlify: Boolean(verifyNetlifySignature(req.headers['x-nf-sign'])) }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }));

  app.use(express.json({ limit: '100kb' })); // rejects oversized bodies before any route sees them

  // Health check for Render and uptime monitors. It asks the database a trivial question, so
  // "healthy" means the API can actually serve data, not just that the process is running.
  app.get('/api/health', async (req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  });

  app.use(sameOrigin);          // refuse writes triggered by other websites (CSRF)

  app.use('/api/products', productsRouter);   // public and cacheable: no session needed
  app.use('/api/newsletter', newsletterRouter);
  app.use('/api/auth', sessionMiddleware, authRouter);
  app.use('/api/cart', sessionMiddleware, cartRouter);        // guests (cookie) and users (session)
  app.use('/api/wishlist', sessionMiddleware, wishlistRouter); // signed-in only
  app.use('/api/checkout', sessionMiddleware, checkoutRouter);
  app.use('/api/orders', sessionMiddleware, ordersRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
