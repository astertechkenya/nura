// cloudinary.js: product photos (Phase 7).
//
// How an upload works, and why each step is there:
//   1. The admin asks the API to SIGN an upload (POST /api/admin/uploads/sign). The signature is
//      a SHA-1 of the upload's parameters plus our API secret, so Cloudinary only accepts an
//      upload with exactly these parameters: into NURA's folder, JPEG/PNG/WebP/AVIF only, within
//      the next hour. The secret never leaves the server.
//   2. The browser sends the photo straight to Cloudinary. It never passes through Render.
//   3. Saving the product sends only the photo's public_id. The API asks Cloudinary's Admin API
//      (server to server, with our key) whether that photo really exists in our account, in our
//      folder, in an allowed format and size, and then builds the image address ITSELF.
//      So the admin can't be tricked into saving an image address from somewhere else.
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { httpError } from '../middleware/errors.js';
import { logger } from '../logger.js';

export const FOLDER = 'nura/products';
export const FORMATS = ['jpg', 'png', 'webp', 'avif'];
export const MAX_BYTES = 5 * 1024 * 1024;
// Uploads go from the browser to this address. Fixed (not configurable): the site's Content
// Security Policy allows exactly this host for uploads.
const UPLOAD_HOST = 'https://api.cloudinary.com';

const requireUploads = () => {
  if (!config.uploadsEnabled) throw httpError(503, 'Photo uploads aren’t set up yet: add the three CLOUDINARY_* settings.');
};

/** Cloudinary's signature: the parameters sorted by name, "k=v" joined with "&", then the
 *  secret appended, SHA-1, hex. (file, api_key, cloud_name and resource_type are never signed.) */
export function signParams(params, secret = config.CLOUDINARY_API_SECRET) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return createHash('sha1').update(toSign + secret).digest('hex');
}

export function signUpload(now = Date.now()) {
  requireUploads();
  const params = { allowed_formats: FORMATS.join(','), folder: FOLDER, timestamp: Math.floor(now / 1000) };
  return {
    uploadUrl: `${UPLOAD_HOST}/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/upload`,
    fields: { ...params, api_key: config.CLOUDINARY_API_KEY, signature: signParams(params) },
    maxBytes: MAX_BYTES,
    accept: 'image/jpeg,image/png,image/webp,image/avif',
  };
}

const PUBLIC_ID = new RegExp(`^${FOLDER}/[A-Za-z0-9_-]{1,100}$`);
const adminApi = (path, opts = {}) => fetch(`${config.CLOUDINARY_API_BASE}/v1_1/${config.CLOUDINARY_CLOUD_NAME}${path}`, {
  ...opts,
  headers: { Authorization: `Basic ${Buffer.from(`${config.CLOUDINARY_API_KEY}:${config.CLOUDINARY_API_SECRET}`).toString('base64')}` },
  signal: AbortSignal.timeout(10_000),
});

/** Removes a photo we refused, so rejected uploads don't pile up in the account. Best effort. */
async function remove(publicId) {
  try {
    await adminApi(`/resources/image/upload?public_ids[]=${encodeURIComponent(publicId)}`, { method: 'DELETE' });
  } catch (err) { logger.warn({ err, publicId }, 'could not delete a refused upload'); }
}

/**
 * Checks an uploaded photo with Cloudinary and returns the address to store. Throws 400 with a
 * message the admin can act on when the photo isn't acceptable.
 */
export async function verifiedImageUrl(publicId) {
  requireUploads();
  if (!PUBLIC_ID.test(String(publicId))) throw httpError(400, 'That photo isn’t one uploaded through the admin.');
  let res;
  try {
    res = await adminApi(`/resources/image/upload/${publicId}`);
  } catch (err) {
    logger.error({ err }, 'Cloudinary unreachable');
    throw httpError(502, 'Couldn’t reach the photo service. Please try again.');
  }
  if (res.status === 404) throw httpError(400, 'That photo wasn’t found. Please upload it again.');
  if (!res.ok) {
    logger.error({ status: res.status }, 'Cloudinary Admin API refused');
    throw httpError(502, 'The photo service didn’t answer properly. Please try again.');
  }
  const r = await res.json();
  if (!FORMATS.includes(r.format)) {
    await remove(publicId);
    throw httpError(400, 'Photos must be JPEG, PNG, WebP or AVIF.');
  }
  if (r.bytes > MAX_BYTES) {
    await remove(publicId);
    throw httpError(400, 'Photos must be 5 MB or smaller.');
  }
  // f_auto,q_auto: Cloudinary picks the best format and quality for each browser.
  // c_limit,w_1200: never wider than 1200 px (cards are at most ~420 px wide, so this covers
  // sharp screens without sending a phone a 4000 px original).
  return `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto,c_limit,w_1200/v${Number(r.version)}/${publicId}`;
}
