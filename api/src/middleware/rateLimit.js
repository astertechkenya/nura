// rateLimit.js: "at most N requests per window, per shopper".
//
// Keyed by the real client IP (see lib/clientIp.js). IPv6 users get whole address blocks
// counted together (ipKeyGenerator), because one IPv6 customer can own millions of addresses.
//
// The counts live in memory. That's fine while NURA runs as one Render instance; a restart
// resets them. Phase 8 can move them into Postgres if the API ever runs on several machines.
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from '../lib/clientIp.js';

export function limit({ windowMs, max, message = 'Too many requests. Please try again later.' }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',   // tells well-behaved clients how long to wait (RateLimit headers)
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    handler: (req, res) => res.status(429).json({ error: message }),
    // We deliberately key on our own verified IP, not Express's req.ip.
    validate: { trustProxy: false, xForwardedForHeader: false },
  });
}
