const apps = require('../../lib/applications');

// An application is a record of someone asking to join, and of how the board
// voted on it. It is never deleted - archiving takes it out of the active list
// while keeping the PDF, the CV and the votes intact.
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const applications = await apps.getApplications();
      return res.json({ applications: applications.map(a => ({ ...a, archived: !!a.archived })) });
    }

    if (req.method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = body.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (typeof body.archived !== 'boolean') {
        return res.status(400).json({ error: 'archived must be true or false' });
      }

      const list = await apps.getApplications();
      const entry = list.find(a => a.id === id);
      if (!entry) return res.status(404).json({ error: 'Application not found' });

      entry.archived = body.archived;
      if (body.archived) entry.archivedAt = new Date().toISOString();
      else delete entry.archivedAt;

      await apps.saveApplications(list);
      return res.json({ success: true, application: entry });
    }

    if (req.method === 'DELETE') {
      return res.status(405).json({
        error: 'Applications cannot be deleted. Archive it instead - the PDF, CV and votes are kept.',
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Applications API error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.getApplications = apps.getApplications;
