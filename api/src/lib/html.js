// html.js: putting data into HTML safely.
//
// esc() for text and attribute values. jsonForScript() for JSON inside a <script> block: JSON
// is not HTML-safe on its own, because a product name containing "</script><script>…" would
// end the block early and start a script of the attacker's. Escaping <, > and & as \u003c etc.
// keeps the JSON identical to a parser but makes it impossible to close the tag.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const jsonForScript = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
