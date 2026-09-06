const apps = require('../../lib/applications');
const candidates = require('../../lib/candidates');

// The list of people the board might approach lives on this function rather
// than its own, for the same reason the votes do: the Hobby plan allows twelve
// functions and all twelve are spoken for. ?candidates=1 selects it.
const wantsCandidates = (req) => !!(req.query && (req.query.candidates === '1' || req.query.candidates === 'true'));

// An application is a record of someone asking to join, and of how the board
// voted on it. It is never deleted - archiving takes it out of the active list
// while keeping the PDF, the CV and the votes intact.
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = () => (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}));

  try {
    // ---- Possible candidates: a name and a comment, nothing else.
    if (wantsCandidates(req)) {
      if (req.method === 'GET') {
        return res.json({ candidates: await candidates.getCandidates() });
      }

      if (req.method === 'POST') {
        const name = candidates.asName(body().name);
        if (!name) return res.status(400).json({ error: 'A candidate needs a name' });
        const list = await candidates.getCandidates();
        if (list.length >= candidates.MAX_CANDIDATES) {
          return res.status(409).json({ error: `The list holds ${candidates.MAX_CANDIDATES} people; remove somebody first` });
        }
        const entry = candidates.newCandidate({ name, comment: body().comment });
        list.push(entry);
        await candidates.saveCandidates(list);
        return res.json({ success: true, candidate: entry });
      }

      if (req.method === 'PATCH') {
        const b = body();
        if (!b.id) return res.status(400).json({ error: 'Missing id' });
        const list = await candidates.getCandidates();
        const entry = list.find(c => c.id === b.id);
        if (!entry) return res.status(404).json({ error: 'No such candidate' });
        // A name is not allowed to be emptied by accident - the row would
        // become an anonymous comment nobody can place.
        if (b.name !== undefined) {
          const name = candidates.asName(b.name);
          if (!name) return res.status(400).json({ error: 'A candidate needs a name' });
          entry.name = name;
        }
        if (b.comment !== undefined) entry.comment = candidates.asComment(b.comment);
        entry.updatedAt = new Date().toISOString();
        await candidates.saveCandidates(list);
        return res.json({ success: true, candidate: entry });
      }

      // Nobody applied and nothing was decided, so a name written here can be
      // taken off again - unlike an application, which is only ever archived.
      if (req.method === 'DELETE') {
        const id = req.query && req.query.id;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const list = await candidates.getCandidates();
        const kept = list.filter(c => c.id !== id);
        if (kept.length === list.length) return res.status(404).json({ error: 'No such candidate' });
        await candidates.saveCandidates(kept);
        return res.json({ success: true, remaining: kept.length });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.method === 'GET') {
      // ?votes=1 returns the board's votes instead of the applications. Merged
      // in from its own endpoint because the Hobby plan allows 12 functions and
      // this reads the same records anyway.
      if (req.query && (req.query.votes === '1' || req.query.votes === 'true')) {
        const id = req.query.id;
        if (id) return res.json({ votes: await apps.getVotes(id) });
        const all = {};
        for (const a of await apps.getApplications()) all[a.id] = await apps.getVotes(a.id);
        return res.json({ votes: all });
      }

      const applications = await apps.getApplications();
      return res.json({ applications: applications.map(a => ({ ...a, archived: !!a.archived })) });
    }

    if (req.method === 'PATCH') {
      const b = body();
      const id = b.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (typeof b.archived !== 'boolean') {
        return res.status(400).json({ error: 'archived must be true or false' });
      }

      const list = await apps.getApplications();
      const entry = list.find(a => a.id === id);
      if (!entry) return res.status(404).json({ error: 'Application not found' });

      entry.archived = b.archived;
      if (b.archived) entry.archivedAt = new Date().toISOString();
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
