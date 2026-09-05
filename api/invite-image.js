const { kv } = require('@vercel/kv');

const MAX_BYTES = 900 * 1024;
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const key = (id) => `invite:image:${id}`;
const INDEX = 'invite:images';

// Deliberately OUTSIDE api/admin: WhatsApp's link preview crawler and every
// recipient must be able to fetch this without a password. Uploading still
// requires the admin password; only reading is public, and the id is random so
// an image is not discoverable by guessing.
module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).send('Missing id');
      const img = await kv.get(key(id));
      if (!img || !img.content) return res.status(404).send('Not found');

      const buffer = Buffer.from(img.content, 'base64');
      res.setHeader('Content-Type', img.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      // Long cache: the id changes whenever the image does, and preview
      // crawlers refetch aggressively otherwise.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(buffer);
    }

    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || req.headers['x-admin-password'] !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { content, mimeType, name } = body;
      if (!content) return res.status(400).json({ error: 'Missing image content' });
      if (!ALLOWED[mimeType]) {
        return res.status(400).json({ error: 'Image must be JPEG, PNG or WebP' });
      }
      const bytes = Buffer.from(content, 'base64').length;
      if (bytes > MAX_BYTES) {
        return res.status(413).json({ error: `Image is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB` });
      }

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await kv.set(key(id), { content, mimeType, name: name || '', uploadedAt: new Date().toISOString() });

      // Keep a short index so the tool can offer recently used images again.
      const index = (await kv.get(INDEX)) || [];
      index.unshift({ id, name: name || '', mimeType, bytes, uploadedAt: new Date().toISOString() });
      await kv.set(INDEX, index.slice(0, 20));

      return res.json({ success: true, id, bytes, url: `/api/invite-image?id=${id}` });
    }

    if (req.method === 'DELETE') {
      const id = req.query && req.query.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      await kv.del(key(id));
      const index = (await kv.get(INDEX)) || [];
      await kv.set(INDEX, index.filter(x => x.id !== id));
      return res.json({ success: true });
    }

    if (req.method === 'PUT') {   // list recent uploads
      return res.json({ images: (await kv.get(INDEX)) || [] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Invite image error:', err);
    return res.status(500).json({ error: err.message });
  }
};
