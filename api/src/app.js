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
    autoLogging: !config.isTest,
  }));

  app.use(express.json({ limit: '100kb' })); // rejects oversized bodies before any route sees them

  // Health check for Render and uptime monitors. It asks the database a trivial question, so
  // "healthy" means the API can actually serve data, not just that the process is running.
  app.get('/api/health', async (req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  });

  app.use('/api/products', productsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
