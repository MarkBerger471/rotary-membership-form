const { kv } = require('@vercel/kv');

const KEY = 'admin:contacts';

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const contacts = (await kv.get(KEY)) || [];
      return res.json({ contacts });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { memberNo, isBoardMember, boardFunction } = body;
      if (memberNo == null) return res.status(400).json({ error: 'Missing memberNo' });
      const contacts = (await kv.get(KEY)) || [];
      const idx = contacts.findIndex(c => c.memberNo === memberNo);
      if (idx === -1) return res.status(404).json({ error: 'Member not found' });
      const next = {
        ...contacts[idx],
        isBoardMember: !!isBoardMember,
        boardFunction: isBoardMember ? (boardFunction || '') : '',
      };
      contacts[idx] = next;
      await kv.set(KEY, contacts);
      return res.json({ contact: next });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
