// photo.js: right-sized product photos for the pages the API renders (routes/pages.js).
//
// Every photo exists at 400, 800 and 1200 pixels wide, always the WHOLE picture: the frame
// crops it in CSS (object-fit: cover, with the admin's crop setting), so a smaller file shows
// exactly the same thing, with fewer pixels. srcset lists the three; `sizes` says how wide the
// frame will be; the browser downloads the smallest one that is sharp on this screen.
//
//   Cloudinary  …/upload/f_auto,q_auto,c_limit,w_1200/…  → the same with w_400 / w_800
//               (Cloudinary makes any width on request; c_limit never crops or enlarges)
//   our own     images/cottonwrap.webp → images/sized/cottonwrap-400.webp, -800, -1200
//               (made once by tools/photo-sizes.py)
//   anything else is used as it is, with no srcset.
//
// The storefront's js/api.js (NURA.photo, NURA.photoSrcset) follows the same rules for the
// pages it draws itself. Change one, change both: test/photo.test.js checks they agree.
export const PHOTO_WIDTHS = [400, 800, 1200];
const CLOUDINARY_SIZE = /(\/image\/upload\/f_auto,q_auto,c_limit,)w_1200\//;
const LOCAL_PHOTO = /^images\/([A-Za-z0-9_-]+)\.(?:webp|avif|jpe?g|png)$/;

/** The photo at width `w`, or null when the address has no sizes. */
export function photoAt(url, w) {
  url = String(url ?? '');
  if (CLOUDINARY_SIZE.test(url)) return url.replace(CLOUDINARY_SIZE, `$1w_${w}/`);
  const m = LOCAL_PHOTO.exec(url);
  return m ? `images/sized/${m[1]}-${w}.webp` : null;
}

/** srcset's value, or '' when the address has no sizes. */
export const photoSrcset = (url) => (photoAt(url, 400)
  ? PHOTO_WIDTHS.map((w) => `${photoAt(url, w)} ${w}w`).join(', ')
  : '');
