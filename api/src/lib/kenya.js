// kenya.js: Kenya's 47 counties, the "city" field of every delivery address.
//
// A fixed list instead of free text, because the server makes decisions with it (is cash on
// delivery available here?). "nairobi", "Nairobi CBD" and "NBI" typed by hand would each need
// guessing; a choice from this list needs none.
export const COUNTIES = Object.freeze([
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay',
  'Isiolo', 'Kajiado', 'Kakamega', 'Kericho', 'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu',
  'Kitui', 'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera', 'Marsabit', 'Meru',
  'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi', 'Narok', 'Nyamira', 'Nyandarua',
  'Nyeri', 'Samburu', 'Siaya', 'Taita-Taveta', 'Tana River', 'Tharaka-Nithi', 'Trans Nzoia',
  'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot',
]);

/**
 * Normalises a Kenyan mobile number to 2547XXXXXXXX / 2541XXXXXXXX, the form M-Pesa expects.
 * Accepts 0712 345 678, +254 712-345-678, 254712345678 and 712345678. Returns null otherwise.
 */
export function normalisePhone(input) {
  const digits = String(input).replace(/[\s\-().]/g, '');
  const m = digits.match(/^(?:\+?254|0)?([17]\d{8})$/);
  return m ? `254${m[1]}` : null;
}
