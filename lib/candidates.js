const { kv } = require('@vercel/kv');

// People the club might approach about joining, written down before anybody
// applies. This is not an application and never becomes one on its own: no
// PDF, no vote, no email leaves here. A name, and what is known about them.
const KEY = 'admin:candidates';

const MAX_CANDIDATES = 300;
const MAX_NAME = 120;
const MAX_COMMENT = 4000;

async function getCandidates() {
  try {
    const list = await kv.get(KEY);
    if (Array.isArray(list)) return list;
  } catch (err) {
    console.error('Error reading candidates:', err);
  }
  return [];
}

async function saveCandidates(list) {
  await kv.set(KEY, list);
}

const text = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max);
const asName = (v) => text(v, MAX_NAME);
const asComment = (v) => text(v, MAX_COMMENT);

function newCandidate(input) {
  const now = new Date().toISOString();
  return {
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: asName(input && input.name),
    comment: asComment(input && input.comment),
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  KEY,
  MAX_CANDIDATES,
  MAX_NAME,
  MAX_COMMENT,
  getCandidates,
  saveCandidates,
  newCandidate,
  asName,
  asComment,
};
