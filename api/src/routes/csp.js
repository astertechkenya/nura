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
    // about:srcdoc, about:blank, data:… have no origin: keep the scheme and the (short) path.
    return (url.origin === 'null' ? url.protocol + url.pathname.slice(0, 20) : url.origin + url.pathname).slice(0, 200);
  } catch {
    return u.slice(0, 40);   // keywords such as "inline" or "eval"
  }
}

export function readReports(body) {
  const list = Array.isArray(body) ? body.map((r) => r?.body) : [body?.['csp-report']];
  return list.filter((r) => r && typeof r === 'object').slice(0, 10).map((r) => ({
    directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 60),
    blocked: trimUrl(r['blocked-uri'] ?? r.blockedURL),
    page: (() => {
      const p = trimUrl(r['document-uri'] ?? r.documentURL);
      return p && /^https?:/.test(p) ? new URL(p).pathname : p;   // a path for our pages, "about:srcdoc" for frames
    })(),
    disposition: r.disposition === 'report' ? 'report' : 'enforce',
  }));
}

// Netlify adds a "Powered by Netlify" badge to Free-plan projects created after 19 Aug 2026: an
// iframe built from inline HTML (srcdoc) that runs an inline script. Our policy blocks it, which
// Netlify documents as expected ("the badge won't render; nothing else is affected"), and we keep
// it that way: allowing 'unsafe-inline' would undo the protection against injected scripts. Every
// page view would report it, burying real reports, so this one known case isn't logged. NURA
// itself never creates srcdoc frames, so nothing of ours can hide behind this rule.
export const isNetlifyBadge = (r) => r.page === 'about:srcdoc' && r.blocked === 'inline' && r.directive.startsWith('script-src');

cspRouter.post(
  '/',
  // A shopper with a misbehaving browser extension can send dozens; one connection can't flood the logs.
  limit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many reports.' }),
  parse,
  (req, res) => {
    for (const r of readReports(req.body)) {
      if (isNetlifyBadge(r)) continue;
      logger.warn({ csp: r }, 'CSP blocked something');
    }
    res.status(204).end();
  },
);
