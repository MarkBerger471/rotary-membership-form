const { kv } = require('@vercel/kv');

const KEY = 'admin:meetings';

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const dates = (await kv.get(KEY)) || [];
      return res.json({ dates });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const incoming = Array.isArray(body.dates) ? body.dates : [];
      const cleaned = [...new Set(incoming.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
      await kv.set(KEY, cleaned);
      return res.json({ dates: cleaned });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
