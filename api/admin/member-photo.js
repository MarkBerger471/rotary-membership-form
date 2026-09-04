const { kv } = require('@vercel/kv');
const members = require('../../lib/members');

const key = (memberNo) => `file:photo:${memberNo}`;
const MAX_BYTES = 600 * 1024;   // generous for a face crop, small enough for KV
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

// Profile pictures live outside the directory blob so the member list stays
// small and quick to read; the card fetches each one separately.
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const memberNo = Number((req.query && req.query.memberNo) ?? NaN);
  if (!Number.isFinite(memberNo)) return res.status(400).json({ error: 'Missing memberNo' });

  async function setHasPhoto(value) {
    const list = await members.getMembers();
    const entry = list.find(m => m.memberNo === memberNo);
    if (!entry) return false;
    entry.hasPhoto = value;
    await members.saveMembers(list);
    return true;
  }

  try {
    if (req.method === 'GET') {
      const photo = await kv.get(key(memberNo));
      if (!photo || !photo.content) return res.status(404).json({ error: 'No photo' });
      const buffer = Buffer.from(photo.content, 'base64');
      res.setHeader('Content-Type', photo.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(buffer);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const content = body.content || '';
      const mimeType = body.mimeType || 'image/jpeg';
      if (!content) return res.status(400).json({ error: 'Missing image content' });
      if (!ALLOWED.includes(mimeType)) {
        return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP' });
      }
      const bytes = Buffer.from(content, 'base64').length;
      if (bytes > MAX_BYTES) {
        return res.status(413).json({ error: `Photo is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB` });
      }

      await kv.set(key(memberNo), { content, mimeType });
      const found = await setHasPhoto(true);
      if (!found) return res.status(404).json({ error: 'Member not found' });
      return res.json({ success: true, bytes });
    }

    if (req.method === 'DELETE') {
      await kv.del(key(memberNo));
      await setHasPhoto(false);
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Member photo error:', err);
    return res.status(500).json({ error: err.message });
  }
};
