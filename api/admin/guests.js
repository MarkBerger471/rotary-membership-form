const { kv } = require('@vercel/kv');

const KEY = 'admin:guests';

// Guests are people invited to meetings who are not club members - prospects,
// friends, colleagues. Kept apart from admin:contacts so the member directory
// stays exactly what the club's own list says it is.
async function getGuests() {
  try {
    const list = await kv.get(KEY);
    if (Array.isArray(list)) return list;
  } catch (err) {
    console.error('Error reading guests:', err);
  }
  return [];
}

const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const EDITABLE = ['name', 'firstName', 'lastName', 'phone', 'waNumber', 'notes', 'company'];

// WhatsApp hands us full international numbers, but a number typed by hand is
// usually local ("081 234 5678"). Both must resolve to the same key or the same
// person gets added twice. DEFAULT_COUNTRY_CODE overrides the Thailand default.
function toE164(input) {
  const raw = String(input || '').trim();
  const cc = (process.env.DEFAULT_COUNTRY_CODE || '66').replace(/[^0-9]/g, '');
  let n = digits(raw);
  if (!n) return '';
  if (raw.startsWith('+')) return n;      // already international
  if (n.startsWith('00')) return n.slice(2);
  if (n.startsWith('0')) return cc + n.slice(1);
  return n;
}

function normalise(input, source) {
  const name = String(input.name || '').trim()
    || [input.firstName, input.lastName].filter(Boolean).join(' ').trim();
  const wa = toE164(input.phone || input.waNumber);
  return {
    id: 'g_' + wa + '_' + Math.random().toString(36).slice(2, 7),
    name,
    firstName: String(input.firstName || name.split(' ')[0] || '').trim(),
    lastName: String(input.lastName || '').trim(),
    phone: String(input.phone || (wa ? '+' + wa : '')).trim(),
    waNumber: wa,
    notes: String(input.notes || '').trim(),
    company: String(input.company || '').trim(),
    status: 'active',
    source: source || 'manual',
    createdAt: new Date().toISOString(),
    invites: [],
  };
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = () => (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}));

  try {
    if (req.method === 'GET') {
      return res.json({ guests: await getGuests() });
    }

    // Accepts one guest or a batch from the import picker. Existing WhatsApp
    // numbers are skipped rather than duplicated, so re-importing is safe.
    if (req.method === 'POST') {
      const b = body();
      const incoming = Array.isArray(b.guests) ? b.guests : [b];
      const list = await getGuests();
      const seen = new Set(list.map(g => toE164(g.phone || g.waNumber)).filter(Boolean));

      const added = [], skipped = [];
      for (const raw of incoming) {
        const g = normalise(raw, b.source || raw.source);
        if (!g.name || !g.waNumber) { skipped.push({ name: g.name || '(no name)', reason: 'needs a name and a number' }); continue; }
        if (seen.has(g.waNumber)) { skipped.push({ name: g.name, reason: 'already on the list' }); continue; }
        seen.add(g.waNumber);
        list.push(g);
        added.push(g);
      }
      await kv.set(KEY, list);
      return res.json({ success: true, added: added.length, skipped, guests: added });
    }

    if (req.method === 'PATCH') {
      const b = body();
      if (!b.id) return res.status(400).json({ error: 'Missing id' });
      const list = await getGuests();
      const g = list.find(x => x.id === b.id);
      if (!g) return res.status(404).json({ error: 'Guest not found' });

      for (const f of EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(b, f)) g[f] = String(b[f] || '').trim();
      }
      if (b.status === 'active' || b.status === 'archived') g.status = b.status;
      if (b.phone !== undefined || b.waNumber !== undefined) g.waNumber = toE164(b.phone || b.waNumber);
      // Record that an invite went out, so repeat non-attenders are visible.
      if (b.invited) {
        g.invites = Array.isArray(g.invites) ? g.invites : [];
        g.invites.push({ date: new Date().toISOString(), channel: b.invited });
      }
      await kv.set(KEY, list);
      return res.json({ success: true, guest: g });
    }

    if (req.method === 'DELETE') {
      return res.status(405).json({ error: 'Guests are archived, not deleted. Send status: "archived" instead.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Guests API error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.getGuests = getGuests;
