const { kv } = require('@vercel/kv');
const {
  MAX_ATTACHMENTS, MAX_BYTES, UPLOAD_TYPES,
  attachmentKey, newAttachmentId, safeUrl, normalizeAttachments,
} = require('../../lib/attachments');

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

/*
 * Pictures, files and links belonging to one meeting - served by this same
 * function rather than one of its own. The project's plan allows twelve
 * serverless functions per deployment and already has exactly twelve, so a
 * thirteenth file fails the whole deploy. They belong to a meeting anyway.
 *
 * The `att` parameter, which no other caller sends, chooses this path:
 *
 *   GET    ?att=<id>                  the bytes themselves
 *   POST   ?att=new&date=YYYY-MM-DD   attach a picture, a file or a link
 *   DELETE ?att=<id>&date=YYYY-MM-DD  remove one, bytes and all
 *
 * Upload and attach are one call on purpose. The planner keeps the whole year
 * in memory and writes all of it back on any edit, so a two-step "upload, then
 * save the meeting" would race its own debounced save and lose what was just
 * added. Here the server owns both halves and hands back the updated meeting
 * for the page to adopt.
 */
async function handleAttachment(req, res, att) {
  const query = req.query || {};

  // The bytes stay behind the admin password like every other file here: a
  // meeting's flyer is club business, not something to leave on a public URL.
  if (req.method === 'GET') {
    const stored = await kv.get(attachmentKey(att));
    if (!stored || !stored.content) return res.status(404).json({ error: 'Not found' });
    const buffer = Buffer.from(stored.content, 'base64');
    res.setHeader('Content-Type', stored.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition',
      `inline; filename="${String(stored.name || 'attachment').replace(/[^\w.\- ]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  }

  const b = parseBody(req);
  const date = str(query.date) || str(b.date);
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });

  const meetings = normalize(await kv.get(KEY));
  const meeting = meetings[date];
  if (!meeting) return res.status(404).json({ error: 'No meeting on that date' });
  const existing = normalizeAttachments(meeting.attachments);

  if (req.method === 'POST') {
    if (existing.length >= MAX_ATTACHMENTS) {
      return res.status(409).json({ error: `A meeting can hold ${MAX_ATTACHMENTS} attachments; remove one first` });
    }
    const id = newAttachmentId();
    let attachment;

    if (b.kind === 'link') {
      const url = safeUrl(b.url);
      if (!url) return res.status(400).json({ error: 'That does not look like a web address' });
      attachment = { id, kind: 'link', name: str(b.name).trim(), url, addedAt: new Date().toISOString() };
    } else {
      const content = str(b.content);
      const mimeType = str(b.mimeType);
      if (!content) return res.status(400).json({ error: 'Missing file content' });
      const kind = UPLOAD_TYPES[mimeType];
      if (!kind) {
        return res.status(400).json({ error: 'Pictures (JPEG, PNG, WebP), PDFs and office documents only - link to anything else' });
      }
      const bytes = Buffer.from(content, 'base64').length;
      if (bytes > MAX_BYTES) {
        return res.status(413).json({
          error: `That file is ${Math.round(bytes / 1024)} KB and the limit is ${Math.round(MAX_BYTES / 1024)} KB - add it as a link instead`,
        });
      }
      await kv.set(attachmentKey(id), {
        content, mimeType, name: str(b.name), bytes, uploadedAt: new Date().toISOString(),
      });
      attachment = { id, kind, name: str(b.name).trim(), mimeType, bytes, addedAt: new Date().toISOString() };
    }

    meetings[date] = normalizeEntry({ ...meeting, attachments: [...existing, attachment] });
    await kv.set(KEY, meetings);
    const saved = meetings[date].attachments.find(a => a.id === id) || null;
    if (!saved) {
      // Only reachable if the attachment failed its own validation, which would
      // leave bytes stored under a key nothing points at.
      await kv.del(attachmentKey(id)).catch(() => {});
      return res.status(400).json({ error: 'That attachment could not be saved' });
    }
    return res.json({ success: true, attachment: saved, meeting: meetings[date] });
  }

  if (req.method === 'DELETE') {
    const kept = existing.filter(a => a.id !== att);
    if (kept.length === existing.length) return res.status(404).json({ error: 'No such attachment' });
    meetings[date] = normalizeEntry({ ...meeting, attachments: kept });
    await kv.set(KEY, meetings);
    // The record goes first; the bytes are only reachable through it, so a
    // failure here leaves something orphaned rather than something broken.
    await kv.del(attachmentKey(att)).catch(() => {});
    return res.json({ success: true, meeting: meetings[date] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const att = str((req.query || {}).att);
    if (att) return await handleAttachment(req, res, att);

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
