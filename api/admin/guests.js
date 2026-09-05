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

// A queued message used to carry a single imageUrl; it now carries an ordered
// imageUrls array. Accept either shape and always store an array, so a lone
// imageUrl becomes a one-element array, nothing becomes [], and anything queued
// in the old shape still sends. Capped so a message never floods with photos.
const MAX_QUEUE_IMAGES = 10;
function normaliseImageUrls(q) {
  const out = [];
  const push = (u) => { const s = String(u == null ? '' : u).trim(); if (s) out.push(s); };
  if (q && Array.isArray(q.imageUrls)) q.imageUrls.forEach(push);
  else if (q && q.imageUrl) push(q.imageUrl);
  return out.slice(0, MAX_QUEUE_IMAGES);
}

// Which language to write to them in, and how to address them. Thai guests are
// normally addressed as "Khun Somchai" - by the first name, with the honorific
// in front - so this is a prefix to the greeting, not a replacement for it.
const LANGUAGES = ['en', 'de'];
const HONORIFICS = ['', 'Khun', 'Mr.', 'Ms.', 'Dr.'];
const asLanguage = (v, fallback) => (LANGUAGES.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fallback);
const asHonorific = (v, fallback) => {
  const t = String(v == null ? '' : v).trim();
  if (t === '') return '';
  const hit = HONORIFICS.find(h => h.toLowerCase() === t.toLowerCase());
  return hit !== undefined ? hit : fallback;
};

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

// Messages are addressed by first name, so the split has to be right. An
// explicit first/last from the import wins; only a hand-typed single string is
// split, and then as "First Last", which is how people type a name. Never
// guess the other way round - greeting Antonio Bissoni as "Hello Bissoni" is
// worse than having no surname at all.
function splitName(input) {
  const first = String(input.firstName || '').trim();
  const last = String(input.lastName || '').trim();
  if (first || last) return { first, last };
  const parts = String(input.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// A "name" that is only digits came from a contact saved without one.
const looksLikeNumber = (s) => /^[\d\s+()\-]+$/.test(String(s || '').trim());

function normalise(input, source) {
  const { first, last } = splitName(input);
  const name = [first, last].filter(Boolean).join(' ').trim()
    || String(input.name || '').trim();
  const wa = toE164(input.phone || input.waNumber);
  return {
    id: 'g_' + wa + '_' + Math.random().toString(36).slice(2, 7),
    name,
    firstName: looksLikeNumber(first) ? '' : first,
    lastName: last,
    phone: String(input.phone || (wa ? '+' + wa : '')).trim(),
    waNumber: wa,
    notes: String(input.notes || '').trim(),
    company: String(input.company || '').trim(),
    language: asLanguage(input.language, 'en'),
    honorific: asHonorific(input.honorific, ''),
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
      const list = await getGuests();
      return res.json({ guests: list.map(g => ({
        ...g,
        language: asLanguage(g.language, 'en'),
        honorific: asHonorific(g.honorific, ''),
      })) });
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
      // Keep the parts and the display name in step whichever was edited.
      if (b.firstName !== undefined || b.lastName !== undefined) {
        g.firstName = looksLikeNumber(g.firstName) ? '' : g.firstName;
        g.name = [g.firstName, g.lastName].filter(Boolean).join(' ').trim() || g.name;
      } else if (b.name !== undefined) {
        const { first, last } = splitName({ name: g.name });
        g.firstName = looksLikeNumber(first) ? '' : first;
        g.lastName = last;
      }
      if (b.status === 'active' || b.status === 'archived') g.status = b.status;
      // The invite page queues a guest by writing the exact text and image to
      // send; the local WhatsApp sender drains the queue and clears it. Kept as
      // a whole object rather than an editable string field so it is not
      // coerced by the loop above.
      if (b.queued !== undefined) {
        g.queued = (b.queued && typeof b.queued === 'object' && b.queued.text)
          ? { text: String(b.queued.text), imageUrls: normaliseImageUrls(b.queued), queuedAt: new Date().toISOString() }
          : null;
        if (g.queued) delete g.queueError;
      }
      if (b.queueError !== undefined) g.queueError = String(b.queueError || '') || undefined;
      if (b.language !== undefined) g.language = asLanguage(b.language, g.language || 'en');
      if (b.honorific !== undefined) g.honorific = asHonorific(b.honorific, g.honorific || '');
      if (b.phone !== undefined || b.waNumber !== undefined) g.waNumber = toE164(b.phone || b.waNumber);
      // Record that an invite went out, so repeat non-attenders are visible.
      if (b.invited) {
        g.invites = Array.isArray(g.invites) ? g.invites : [];
        g.invites.push({ date: new Date().toISOString(), channel: b.invited });
      }
      await kv.set(KEY, list);
      return res.json({ success: true, guest: g });
    }

    // Guests are contacts pulled in from a phone, not a record of anything the
    // club decided, so removing them for real is right - particularly undoing a
    // bulk import. Archiving stays for "not inviting them just now".
    if (req.method === 'DELETE') {
      const id = req.query && req.query.id;
      const source = req.query && req.query.source;
      if (!id && !source) return res.status(400).json({ error: 'Pass id or source' });

      const list = await getGuests();
      const before = list.length;
      const kept = id
        ? list.filter(g => g.id !== id)
        : list.filter(g => (g.source || 'manual') !== source);
      if (id && kept.length === before) return res.status(404).json({ error: 'Guest not found' });

      await kv.set(KEY, kept);
      return res.json({ success: true, removed: before - kept.length, remaining: kept.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Guests API error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.getGuests = getGuests;
