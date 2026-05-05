const { kv } = require('@vercel/kv');

const KEY = 'admin:meetings';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalize(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    for (const d of value) if (DATE_RE.test(d)) out[d] = '';
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DATE_RE.test(k)) out[k] = typeof v === 'string' ? v : '';
    }
    return out;
  }
  return {};
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const meetings = normalize(await kv.get(KEY));
      return res.json({ meetings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const meetings = normalize(body.meetings);
      await kv.set(KEY, meetings);
      return res.json({ meetings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
