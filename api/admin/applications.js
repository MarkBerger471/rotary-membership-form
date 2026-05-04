const { kv } = require('@vercel/kv');

const LOG_KEY = 'admin:applications';

async function getApplications() {
  try {
    const apps = await kv.get(LOG_KEY);
    if (apps) return apps;
  } catch (err) {
    console.error('Error reading applications log:', err);
  }
  return [];
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const applications = await getApplications();
    return res.json({ applications });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id parameter' });

    try {
      const apps = await getApplications();
      const filtered = apps.filter(a => a.id !== id);
      await kv.set(LOG_KEY, filtered);

      // Clean up related KV keys (PDF, CV, votes)
      try { await kv.del(`file:pdf:${id}`); } catch (e) {}
      try { await kv.del(`file:cv:${id}`); } catch (e) {}
      try { await kv.del(`votes:${id}`); } catch (e) {}

      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

module.exports.getApplications = getApplications;
