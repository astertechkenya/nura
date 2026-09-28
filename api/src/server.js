// server.js: starts the HTTP server and shuts it down cleanly.
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';

const server = createApp().listen(config.PORT, () => {
  logger.info(`NURA API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
});

// Render sends SIGTERM before replacing the server on every deploy. Finishing in-flight
// requests and closing database connections avoids cutting a checkout off halfway.
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // don't hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
