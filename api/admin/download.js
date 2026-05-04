const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, type } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing id parameter' });
  }

  const key = type === 'cv' ? `file:cv:${id}` : `file:pdf:${id}`;

  try {
    const data = await kv.get(key);
    if (!data) {
      return res.status(404).json({ error: 'File not found' });
    }

    const buffer = Buffer.from(data.content, 'base64');
    res.setHeader('Content-Type', data.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${data.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: err.message });
  }
};
