const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.query;

  if (id) {
    // Get votes for a specific application
    const votes = (await kv.get(`votes:${id}`)) || {};
    return res.json({ votes });
  }

  // Get votes for all applications
  const apps = (await kv.get('admin:applications')) || [];
  const allVotes = {};
  for (const app of apps) {
    allVotes[app.id] = (await kv.get(`votes:${app.id}`)) || {};
  }
  return res.json({ votes: allVotes });
};
