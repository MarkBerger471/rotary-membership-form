const { kv } = require('@vercel/kv');
const { normalizeAttachments } = require('../../lib/attachments');

const KEY = 'admin:meetings';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The planner colours cards by type, so an unknown or missing type has to fall
// back to something sensible rather than render as a blank card. Entries
// written before types existed are ordinary club meetings.
const TYPES = ['club', 'fellowship', 'service', 'other'];
const DEFAULT_TYPE = 'club';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function normalizeEntry(v) {
  if (typeof v === 'string') v = { active: true, topic: v };
  if (!v || typeof v !== 'object') return null;
  return {
    active: !!v.active,
    type: TYPES.includes(v.type) ? v.type : DEFAULT_TYPE,
    topic: str(v.topic),
    presenter: str(v.presenter),
    presenterTitle: str(v.presenterTitle),
    venue: str(v.venue),
    photoUrl: str(v.photoUrl),
    description: str(v.description),
    // Pictures, files and links belonging to this evening. Only their
    // description is here; the bytes live under their own key. Anything not
    // listed in this shape is dropped, so an attachment that was not written
    // through the attachment endpoint cannot appear on a card.
    attachments: normalizeAttachments(v.attachments),
  };
}

function normalize(value) {
  if (!value) return {};
  // The very first version stored a bare array of selected dates.
  if (Array.isArray(value)) {
    const out = {};
    for (const d of value) if (DATE_RE.test(d)) out[d] = normalizeEntry({ active: true });
    return out;
  }
  if (typeof value !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!DATE_RE.test(k)) continue;
    const entry = normalizeEntry(v);
    if (entry) out[k] = entry;
  }
  return out;
}

function parseBody(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      return res.json({ meetings: normalize(await kv.get(KEY)) });
    }

    // Whole-set write. The planner and the flyer both hold the full map in
    // memory and send it back, so this stays the primary write path.
    if (req.method === 'POST') {
      const meetings = normalize(parseBody(req).meetings);
      await kv.set(KEY, meetings);
      return res.json({ meetings });
    }

    // Single-date upsert. Adding one date should not require shipping every
    // other entry back — the flyer stores speaker photos as base64 data URIs,
    // so the full map gets large fast.
    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const date = str(body.date);
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });
      const meetings = normalize(await kv.get(KEY));
      const current = meetings[date] || normalizeEntry({ active: true });
      const patch = {};
      for (const f of ['active', 'type', 'topic', 'presenter', 'presenterTitle', 'venue', 'photoUrl', 'description', 'attachments']) {
        if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
      }
      meetings[date] = normalizeEntry({ ...current, ...patch });
      await kv.set(KEY, meetings);
      return res.json({ date, meeting: meetings[date] });
    }

    // Meetings really are deleted, unlike members/applications/guests which are
    // archived. A cancelled date is planning data, not a record about a person,
    // and leaving tombstones in the grid would only clutter the planner.
    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const date = str(body.date) || str(req.query && req.query.date);
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });
      const meetings = normalize(await kv.get(KEY));
      if (!meetings[date]) return res.status(404).json({ error: 'No meeting on that date' });
      delete meetings[date];
      await kv.set(KEY, meetings);
      return res.json({ deleted: date, meetings });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
