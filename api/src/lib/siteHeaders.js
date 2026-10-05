// siteHeaders.js: the security headers for pages the API serves as part of the storefront
// (product pages, Phase 8): the same ones Netlify adds to its own pages from frontend/_headers.
//
// Netlify doesn't add _headers to responses it fetches from Render, and helmet's defaults
// (meant for an API) would block Cloudinary photos. So these pages set the storefront's own
// policy. test/pages.test.js fails if this copy and frontend/_headers ever differ.
export const SITE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; "
  + "img-src 'self' data: https://res.cloudinary.com; connect-src 'self' https://api.cloudinary.com; frame-ancestors 'none'; "
  + "form-action 'self'; base-uri 'self'; object-src 'none'; report-uri /api/csp-report";

export function setSiteHeaders(res) {
  res.set({
    'Content-Security-Policy': SITE_CSP,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
}
