// routes/pages.js: product pages and the sitemap, rendered by the API (Phase 8).
//
//   GET /p/:slug        one product's page (nurafashion.netlify.app/p/linen-oversized-blazer)
//   GET /sitemap.xml    every public page and product, for search engines
//
// Why the server renders these instead of the browser: when a link is pasted into WhatsApp,
// or Google's crawler visits, they read the HTML that arrives and (WhatsApp at least) run no
// JavaScript. A page drawn by JavaScript looks empty to them: no title, no photo, no price in
// the preview. So the API fills in the product here: the <head> gets the title, description and
// Open Graph tags that make the preview card, plus schema.org data for Google; <main> gets the
// product itself, so the page reads complete before any script runs. js/product.js then only
// adds behaviour (sizes, add to cart).
//
// The page around the product (navigation, cart drawer, sign-in, footer) is
// frontend/product.html, the same shared layout as every other page. It has two marked regions
// this file fills: <!--nura:head-->…<!--/nura:head--> and <!--nura:main-->…<!--/nura:main-->.
// Netlify forwards /p/* and /sitemap.xml here (netlify.toml), so it's all one site to a visitor.
import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products } from '../db/schema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { esc, jsonForScript } from '../lib/html.js';
import { setSiteHeaders } from '../lib/siteHeaders.js';
import { cacheBriefly, toPublicProduct } from './products.js';

export const pagesRouter = Router();

/* ── The layout ─────────────────────────────────────────────────────────────────── */

const TEMPLATE_FILE = new URL('../../../frontend/product.html', import.meta.url);
let cached = { html: null, at: 0 };

/**
 * frontend/product.html. Read from the repository when it's there (local, tests, and Render if
 * it keeps the whole repository); otherwise fetched from the live site. Kept for 5 minutes in
 * production, re-read every time in development so edits show at once.
 */
export async function loadTemplate() {
  if (cached.html && config.isProd && Date.now() - cached.at < 5 * 60 * 1000) return cached.html;
  let html;
  try {
    html = await readFile(TEMPLATE_FILE, 'utf8');
  } catch {
    const res = await fetch(`${config.SITE_URL}/product.html`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`product.html: ${res.status}`);
    html = await res.text();
  }
  if (!html.includes('<!--nura:head-->') || !html.includes('<!--nura:main-->')) throw new Error('product.html has lost its markers');
  cached = { html, at: Date.now() };
  return html;
}

/** Replaces <!--nura:x-->…<!--/nura:x--> with `content`. (Not String.replace with a string:
 *  that treats "$&" or "$1" in a product name as special patterns.) */
function fill(html, name, content) {
  const start = html.indexOf(`<!--nura:${name}-->`);
  const endTag = `<!--/nura:${name}-->`;
  const end = html.indexOf(endTag, start);
  return html.slice(0, start) + content + html.slice(end + endTag.length);
}

/* ── Pieces ─────────────────────────────────────────────────────────────────────── */

const ksh = (n) => `KSh ${Number(n).toLocaleString('en-KE')}`;
// Shop photos are relative ("images/x.webp"); Cloudinary photos are absolute.
const photo = (u) => (/^https:\/\//.test(u) ? u : `/${u}`);
const absolutePhoto = (u) => (/^https:\/\//.test(u) ? u : `${config.SITE_URL}/${u}`);
// Database values only reach a style="" attribute after matching these exact shapes.
const safeColour = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#efefed');
const safeFocus = (f) => (/^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(f) ? f : '50% 50%');

const DEPARTMENT = {
  WOMEN: { label: 'Women', href: '/women.html' },
  MEN: { label: 'Men', href: '/men.html' },
  UNISEX: null,   // on both pages: the breadcrumb goes Home › product
};

function summary(p) {
  const text = (p.description ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 155 ? `${text.slice(0, 152).replace(/\s\S*$/, '')}…` : text;
  return `${p.brand.name} ${p.name}, ${ksh(p.priceKes)}${p.onSale ? ` (was ${ksh(p.compareAtKes)})` : ''}. `
    + 'Shop at NURA: delivery across Kenya, pay with M-Pesa or card.';
}

function headTags(p) {
  const url = `${config.SITE_URL}/p/${p.slug}`;
  const title = `${p.name} by ${p.brand.name} — NURA`;
  const description = summary(p);
  // schema.org Product: lets Google show price and stock in results. A <script> of type
  // application/ld+json is data, never run, so the security policy allows it; jsonForScript
  // still escapes it so a product name can't end the block.
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku,
    image: [absolutePhoto(p.imageUrl)], description, brand: { '@type': 'Brand', name: p.brand.name },
    offers: {
      '@type': 'Offer', url, priceCurrency: 'KES', price: String(p.priceKes),
      availability: p.totalStock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
    },
  };
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    // Open Graph: the preview card in WhatsApp, Facebook, Instagram DMs, X, Slack…
    '<meta property="og:type" content="product" />',
    '<meta property="og:site_name" content="NURA" />',
    `<meta property="og:title" content="${esc(`${p.name} — ${ksh(p.priceKes)}`)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(absolutePhoto(p.imageUrl))}" />`,
    `<meta property="og:image:alt" content="${esc(p.name)}" />`,
    `<meta property="product:price:amount" content="${Number(p.priceKes)}" />`,
    '<meta property="product:price:currency" content="KES" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<script type="application/ld+json">${jsonForScript(ld)}</script>`,
  ].join('\n  ');
}

const HEART = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

function sizesHtml(p) {
  const one = p.variants.length === 1;
  return `<fieldset class="pd__sizes"${one ? ' hidden' : ''}>
        <legend class="pd__label">Size</legend>
        <div class="pd__chips">${p.variants.map((v) => {
          const out = v.stock === 0;
          // Native radio buttons: arrow keys, screen readers and "one choice only" for free.
          return `<label class="pd-chip${out ? ' is-out' : ''}"><input type="radio" name="variant" value="${esc(v.id)}" data-stock="${Number(v.stock)}" data-size="${esc(v.size)}"${out ? ' disabled' : ''}${one && !out ? ' checked' : ''}><span>${esc(v.size)}</span>${out ? '<span class="visually-hidden">, sold out</span>' : ''}</label>`;
        }).join('')}</div>
      </fieldset>`;
}

function detailsHtml(p) {
  const paras = (p.description ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
    .map((s) => `<p>${esc(s)}</p>`).join('');
  const rows = [
    ['Department', { WOMEN: 'Women', MEN: 'Men', UNISEX: 'Unisex' }[p.department]],
    ...(p.style ? [['Style', p.style]] : []),
    ['Product code', p.sku.toUpperCase()],
  ];
  return `<section class="pd__section" aria-labelledby="pdDetails"><h2 id="pdDetails">Details</h2>${paras}
        <dl class="pd__facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>`;
}

function deliveryHtml() {
  const cod = config.COD_COUNTIES.join(', ');
  return `<section class="pd__section" aria-labelledby="pdDelivery"><h2 id="pdDelivery">Delivery &amp; payment</h2><ul class="pd__list">
        <li>Free delivery on orders of ${ksh(config.FREE_SHIPPING_THRESHOLD_KES)} or more; ${ksh(config.SHIPPING_FEE_KES)} below that.</li>
        <li>Pay with M-Pesa or card${cod ? `, or cash on delivery in ${esc(cod)}` : ''}.</li>
        <li>Your order is confirmed by email, with a link to follow it.</li></ul></section>`;
}

function mainHtml(p) {
  const dept = DEPARTMENT[p.department];
  const soldOut = p.totalStock === 0;
  const save = p.onSale ? Math.round((1 - p.priceKes / p.compareAtKes) * 100) : 0;
  const badge = p.onSale ? '<span class="pd__badge pd__badge--sale">Sale</span>' : p.isNew ? '<span class="pd__badge">New</span>' : '';
  return `
    <nav class="pd-crumbs" aria-label="Breadcrumb"><ol>
      <li><a href="/index.html">Home</a></li>${dept ? `<li><a href="${dept.href}">${dept.label}</a></li>` : ''}
      <li aria-current="page">${esc(p.name)}</li></ol></nav>
    <article class="pd" data-sku="${esc(p.sku)}" data-slug="${esc(p.slug)}">
      <div class="pd__media" style="background-color:${safeColour(p.cardBg)}">${badge}
        <img src="${esc(photo(p.imageUrl))}" alt="${esc(p.name)}" width="900" height="1200" style="object-position:${safeFocus(p.imageFocus)}" fetchpriority="high">
      </div>
      <div class="pd__info">
        <p class="pd__brand">${esc(p.brand.name)}</p>
        <h1 class="pd__name" id="pdTitle" tabindex="-1">${esc(p.name)}</h1>
        <p class="pd__price"><span class="pd__now">${ksh(p.priceKes)}</span>${p.onSale
          ? ` <s class="pd__was"><span class="visually-hidden">was </span>${ksh(p.compareAtKes)}</s> <span class="pd__save">Save ${save}%</span>` : ''}</p>
        <form class="pd__buy" id="pdBuy" novalidate>
          ${sizesHtml(p)}
          <p class="pd__stock" id="pdStock" aria-live="polite">${soldOut ? 'Sold out in every size.' : ''}</p>
          <p class="pd__msg" id="pdMsg" role="alert"></p>
          <div class="pd__actions">
            <button type="submit" class="pd__add" id="pdAdd"${soldOut ? ' disabled' : ''}>${soldOut ? 'Sold out' : 'Add to cart'}</button>
            <button type="button" class="pd__wish product__wish" data-wishlist-id="${esc(p.sku)}" data-action="wishlist" aria-pressed="false" aria-label="Add to wishlist">${HEART}</button>
          </div>
        </form>
        ${detailsHtml(p)}
        ${deliveryHtml()}
      </div>
    </article>
    <script type="application/json" id="pdData">${jsonForScript(p)}</script>`;
}

const NOT_FOUND_HEAD = '<title>Not found — NURA</title>\n  <meta name="robots" content="noindex" />';
const NOT_FOUND_MAIN = `
    <section class="pd-missing"><h1 class="pd__name" id="pdTitle" tabindex="-1">We couldn’t find that product</h1>
      <p>It may have sold out for good or been taken down. Here’s what’s new instead.</p>
      <a class="pd__add pd__add--link" href="/new-in.html">See New In</a></section>`;

/* ── Routes ─────────────────────────────────────────────────────────────────────── */

async function render(res, status, head, main) {
  let html;
  try {
    html = await loadTemplate();
  } catch (err) {
    logger.error({ err }, 'product page layout unavailable');
    return res.status(503).type('text').send('NURA is updating. Please try again in a moment.');
  }
  setSiteHeaders(res);
  if (status === 200) cacheBriefly(res); else res.set('Cache-Control', 'no-store');
  res.status(status).type('html').send(fill(fill(html, 'head', head), 'main', main));
}

pagesRouter.get('/p/:slug', async (req, res) => {
  const slug = String(req.params.slug);
  const row = /^[a-z0-9-]{1,100}$/.test(slug) && await db.query.products.findFirst({
    where: and(eq(products.slug, slug), eq(products.isActive, true)),   // hidden products: not found
    with: { brand: true, variants: true },
  });
  if (!row) return render(res, 404, NOT_FOUND_HEAD, NOT_FOUND_MAIN);
  const p = toPublicProduct(row);
  return render(res, 200, headTags(p), mainHtml(p));
});

const STATIC_PAGES = ['index.html', 'women.html', 'men.html', 'new-in.html', 'sale.html'];

pagesRouter.get('/sitemap.xml', async (req, res) => {
  const rows = await db.select({ slug: products.slug, updatedAt: products.updatedAt })
    .from(products).where(eq(products.isActive, true)).orderBy(products.slug);
  const url = (loc, lastmod) => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
  const body = [
    ...STATIC_PAGES.map((p) => url(`${config.SITE_URL}/${p === 'index.html' ? '' : p}`)),
    ...rows.map((r) => url(`${config.SITE_URL}/p/${r.slug}`, r.updatedAt)),
  ].join('\n');
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
});
