const members = require('../../lib/members');

// The directory is the source of truth for who is on the board, and the board
// is what decides the email recipients list. Every write here therefore runs
// through saveWithRecipientSync so admin:settings cannot drift out of step.
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = () => {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    return b || {};
  };

  try {
    if (req.method === 'GET') {
      const list = await members.getMembers();
      // Statuses are normalised on read so older records list as active.
      return res.json({ contacts: list.map(c => ({ ...c, status: members.statusOf(c) })) });
    }

    if (req.method === 'POST') {
      const b = body();
      const email = (b.email || '').trim();
      if (!b.firstName && !b.lastName && !email) {
        return res.status(400).json({ error: 'A name or email address is required' });
      }
      const list = await members.getMembers();
      const norm = (e) => (e || '').trim().toLowerCase();
      if (email && list.some(m => norm(m.email) === norm(email))) {
        return res.status(409).json({ error: 'A member with that email already exists' });
      }

      const member = members.applyEdits({
        memberNo: members.nextMemberNo(list),
        isBoardMember: false,
        boardFunction: '',
        status: members.STATUSES.includes(b.status) ? b.status : 'active',
        source: 'manual',
        createdAt: new Date().toISOString(),
      }, b);

      list.push(member);
      const sync = await members.saveWithRecipientSync(list, member, null);
      return res.json({ contact: member, ...sync });
    }

    if (req.method === 'PATCH') {
      const b = body();
      if (b.memberNo == null) return res.status(400).json({ error: 'Missing memberNo' });

      const list = await members.getMembers();
      const idx = list.findIndex(c => c.memberNo === b.memberNo);
      if (idx === -1) return res.status(404).json({ error: 'Member not found' });

      const previous = list[idx];
      const previousEmail = previous.email;
      let next = members.applyEdits(previous, b);

      if (Object.prototype.hasOwnProperty.call(b, 'email')) {
        const email = (b.email || '').trim();
        const norm = (e) => (e || '').trim().toLowerCase();
        if (email && list.some((m, i) => i !== idx && norm(m.email) === norm(email))) {
          return res.status(409).json({ error: 'Another member already uses that email' });
        }
      }

      if (Object.prototype.hasOwnProperty.call(b, 'status')) {
        if (!members.STATUSES.includes(b.status)) {
          return res.status(400).json({ error: 'Unknown status' });
        }
        next.status = b.status;
        if (b.status === 'archived') {
          // No longer a member: off the board, and off the email list.
          next.isBoardMember = false;
          next.archivedAt = new Date().toISOString();
        } else {
          delete next.archivedAt;
          // Confirming a pending member is what makes them a real member.
          if (members.statusOf(previous) === 'pending' && b.status === 'active') {
            next.confirmedAt = new Date().toISOString();
            if (!next.joinDate) next.joinDate = new Date().toISOString();
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(b, 'isBoardMember')) {
        const wanted = !!b.isBoardMember;
        if (wanted && members.statusOf(next) !== 'active') {
          return res.status(400).json({ error: 'Confirm the member before adding them to the board' });
        }
        if (wanted && !(next.email || '').trim()) {
          return res.status(400).json({ error: 'A board member needs an email address to receive applications' });
        }
        next.isBoardMember = wanted;
        next.boardFunction = wanted
          ? (Object.prototype.hasOwnProperty.call(b, 'boardFunction') ? (b.boardFunction || '') : (next.boardFunction || ''))
          : '';
      } else if (Object.prototype.hasOwnProperty.call(b, 'boardFunction')) {
        next.boardFunction = next.isBoardMember ? (b.boardFunction || '') : '';
      }

      list[idx] = next;
      const sync = await members.saveWithRecipientSync(list, next, previousEmail);
      return res.json({ contact: next, ...sync });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Contacts API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
