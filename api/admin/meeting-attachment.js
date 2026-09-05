const { kv } = require('@vercel/kv');
const {
  MAX_ATTACHMENTS, MAX_BYTES, UPLOAD_TYPES,
  attachmentKey, newAttachmentId, safeUrl, normalizeAttachments,
} = require('../../lib/attachments');

const KEY = 'admin:meetings';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v) => (typeof v === 'string' ? v : '');

/*
 * Pictures, files and links belonging to one meeting.
 *
 * Upload and attach happen in one call on purpose. The planner keeps the whole
 * year's meetings in memory and writes the lot back on any edit, so a two-step
 * "upload, then save the meeting" would race its own debounced save and lose
 * the attachment. Here the server owns both halves and hands back the updated
 * meeting for the page to adopt.
 */
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const query = req.query || {};
  const body = () => (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}));

  async function meetingsMap() {
    const raw = await kv.get(KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  try {
    // The bytes themselves. Kept behind the password like every other admin
    // file: a meeting's flyer is club business, not something to leave on a
    // guessable public URL.
    if (req.method === 'GET') {
      const id = str(query.id);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const stored = await kv.get(attachmentKey(id));
      if (!stored || !stored.content) return res.status(404).json({ error: 'Not found' });

      const buffer = Buffer.from(stored.content, 'base64');
      res.setHeader('Content-Type', stored.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition',
        `inline; filename="${String(stored.name || 'attachment').replace(/[^\w.\- ]+/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(buffer);
    }

    if (req.method === 'POST') {
      const date = str(query.date) || str(body().date);
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });

      const meetings = await meetingsMap();
      const meeting = meetings[date];
      if (!meeting || typeof meeting !== 'object') {
        return res.status(404).json({ error: 'No meeting on that date' });
      }
      const existing = normalizeAttachments(meeting.attachments);
      if (existing.length >= MAX_ATTACHMENTS) {
        return res.status(409).json({ error: `A meeting can hold ${MAX_ATTACHMENTS} attachments; remove one first` });
      }

      const b = body();
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

      // Re-normalised on the way in, so what comes back is exactly what a
      // later read will produce.
      meetings[date] = { ...meeting, attachments: normalizeAttachments([...existing, attachment]) };
      await kv.set(KEY, meetings);
      const saved = meetings[date].attachments.find(a => a.id === id) || null;
      if (!saved) {
        // Only reachable if the attachment failed its own validation, which
        // would leave bytes stored under a key nothing points at.
        await kv.del(attachmentKey(id)).catch(() => {});
        return res.status(400).json({ error: 'That attachment could not be saved' });
      }
      return res.json({ success: true, attachment: saved, meeting: meetings[date] });
    }

    if (req.method === 'DELETE') {
      const date = str(query.date);
      const id = str(query.id);
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'A date (YYYY-MM-DD) is required' });
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const meetings = await meetingsMap();
      const meeting = meetings[date];
      if (!meeting || typeof meeting !== 'object') {
        return res.status(404).json({ error: 'No meeting on that date' });
      }
      const before = normalizeAttachments(meeting.attachments);
      const kept = before.filter(a => a.id !== id);
      if (kept.length === before.length) return res.status(404).json({ error: 'No such attachment' });

      meetings[date] = { ...meeting, attachments: kept };
      await kv.set(KEY, meetings);
      // The record goes first; the bytes are only reachable through it, so a
      // failure here leaves something orphaned rather than something broken.
      await kv.del(attachmentKey(id)).catch(() => {});
      return res.json({ success: true, meeting: meetings[date] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Meeting attachment error:', err);
    return res.status(500).json({ error: err.message });
  }
};
