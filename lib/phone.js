// WhatsApp addresses a chat by a full international number with no plus and no
// spaces. A number typed by hand is usually local ("081 234 5678"); one that
// came off a phone or out of WhatsApp is already international. Both have to
// land on the same string, or the same person is reached twice or not at all.
// DEFAULT_COUNTRY_CODE overrides the Thailand default.
function toE164(input) {
  const raw = String(input || '').trim();
  const cc = (process.env.DEFAULT_COUNTRY_CODE || '66').replace(/[^0-9]/g, '');
  const n = raw.replace(/[^0-9]/g, '');
  if (!n) return '';
  if (raw.startsWith('+')) return n;      // already international
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('0')) return cc + n.slice(1);
  return n;
}

module.exports = { toE164 };
