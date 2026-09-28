// Test helpers: build a token exactly as Netlify's signed proxy does (HS256 JWS).
import { createHmac } from 'node:crypto';

export const TEST_SECRET = 'test-only-secret-that-is-long-enough-123';

export function netlifyToken({ secret = TEST_SECRET, exp = Math.floor(Date.now() / 1000) + 60, iss = 'netlify', alg = 'HS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, typ: 'JWT' });
  const body = enc({ deploy_context: 'production', exp, iss, site_url: 'https://nuramob.netlify.app' });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
