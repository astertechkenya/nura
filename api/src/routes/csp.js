// routes/csp.js: POST /api/csp-report, where browsers report what the Content-Security-Policy
// blocked (Phase 8).
//
// Once the policy is enforced, anything it blocks simply doesn't work for that shopper: a
// script that never runs, an image that never shows. Without reports we'd only hear about it
// from a customer. With `report-uri /api/csp-report` in the policy (frontend/_headers), the
// browser tells us: which rule, what was blocked, on which page. A burst of reports after a
// deploy means the deploy broke something; a trickle of odd hosts is usually a browser
// extension injecting code, which the policy is right to block.
//
// Reports are logged, never stored, and trimmed first: only the page's path (no query or #part:
// those can hold order and newsletter tokens) and the blocked address's origin and path.
import express, { Router } from 'express';
import { limit } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';

export const cspRouter = Router();

// report-uri sends application/csp-report ({ "csp-report": {...} }); the newer Reporting API
// sends application/reports+json ([{ type: "csp-violation", body: {...} }]).
const parse = express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' });

/** https://x.com/a/b?c=d#e → https://x.com/a/b; "inline", "eval" and the like stay as they are. */
export function trimUrl(u) {
  if (typeof u !== 'string' || !u) return undefined;
  try {
    const url = new URL(u);
    return (url.origin === 'null' ? url.protocol : url.origin + url.pathname).slice(0, 200);
  } catch {
    return u.slice(0, 40);   // keywords such as "inline" or "eval"
  }
}

export function readReports(body) {
  const list = Array.isArray(body) ? body.map((r) => r?.body) : [body?.['csp-report']];
  return list.filter((r) => r && typeof r === 'object').slice(0, 10).map((r) => ({
    directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 60),
    blocked: trimUrl(r['blocked-uri'] ?? r.blockedURL),
    page: (() => { const p = trimUrl(r['document-uri'] ?? r.documentURL); try { return p && new URL(p).pathname; } catch { return p; } })(),
    disposition: r.disposition === 'report' ? 'report' : 'enforce',
  }));
}

cspRouter.post(
  '/',
  // A shopper with a misbehaving browser extension can send dozens; one connection can't flood the logs.
  limit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many reports.' }),
  parse,
  (req, res) => {
    for (const r of readReports(req.body)) logger.warn({ csp: r }, 'CSP blocked something');
    res.status(204).end();
  },
);
