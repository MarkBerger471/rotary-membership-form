const { kv } = require('@vercel/kv');

const KEY = 'admin:meetings';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalize(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    for (const d of value) if (DATE_RE.test(d)) out[d] = { active: true, topic: '', presenter: '' };
    return out;
  }
  if (typeof value !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!DATE_RE.test(k)) continue;
    if (typeof v === 'string') {
      out[k] = { active: true, topic: v, presenter: '' };
    } else if (v && typeof v === 'object') {
      out[k] = {
        active: !!v.active,
        topic: typeof v.topic === 'string' ? v.topic : '',
        presenter: typeof v.presenter === 'string' ? v.presenter : '',
      };
    }
  }
  return out;
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      return res.json({ meetings: normalize(await kv.get(KEY)) });
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
