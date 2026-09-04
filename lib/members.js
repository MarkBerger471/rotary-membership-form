const { kv } = require('@vercel/kv');
const settingsLib = require('./settings');

const CONTACTS_KEY = 'admin:contacts';

// 'active'   - a confirmed member of the club
// 'pending'  - created from an application, awaiting a one-time confirmation
// 'archived' - no longer a member; kept for the record, out of every list
const STATUSES = ['active', 'pending', 'archived'];

// Records seeded before statuses existed are members in good standing.
function statusOf(member) {
  return member && STATUSES.includes(member.status) ? member.status : 'active';
}

function fullName(member) {
  return [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
}

async function getMembers() {
  try {
    const list = await kv.get(CONTACTS_KEY);
    if (Array.isArray(list)) return list;
  } catch (err) {
    console.error('Error reading member directory:', err);
  }
  return [];
}

async function saveMembers(members) {
  await kv.set(CONTACTS_KEY, members);
}

function nextMemberNo(members) {
  const highest = members.reduce((max, m) => {
    const n = Number(m && m.memberNo);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return highest + 1;
}

const EDITABLE = [
  'firstName', 'lastName', 'email', 'phone', 'whatsapp',
  'address', 'postalCode', 'city', 'company', 'jobTitle', 'joinDate', 'notes',
];

function applyEdits(member, patch) {
  const next = { ...member };
  for (const field of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      next[field] = typeof patch[field] === 'string' ? patch[field].trim() : patch[field];
    }
  }
  return next;
}

// A board member belongs on the email recipients list; nobody else does.
// This is the single place that keeps admin:settings in step with the
// directory, so the two can never drift.
function syncRecipients(settings, { email, previousEmail, name, shouldReceive }) {
  const list = settingsLib.recipientList(settings);
  const norm = (e) => (e || '').trim().toLowerCase();
  const target = norm(email);

  let next = list.slice();
  let changed = false;

  // An address change moves the entry rather than leaving a stale one behind.
  const stale = norm(previousEmail);
  if (stale && stale !== target) {
    const before = next.length;
    next = next.filter(r => norm(r && r.email) !== stale);
    if (next.length !== before) changed = true;
  }

  if (shouldReceive && target) {
    const existing = next.find(r => norm(r && r.email) === target);
    if (existing) {
      if (!existing.active || (name && existing.name !== name)) {
        existing.active = true;
        if (name) existing.name = name;
        changed = true;
      }
    } else {
      next.push({ email: email.trim(), name: name || email.trim(), active: true });
      changed = true;
    }
  } else if (target) {
    const before = next.length;
    next = next.filter(r => norm(r && r.email) !== target);
    if (next.length !== before) changed = true;
  }

  return { recipients: next, changed };
}

// Persist a member change and bring the recipients list in line with it.
async function saveWithRecipientSync(members, member, previousEmail) {
  await saveMembers(members);

  const shouldReceive = !!member.isBoardMember && statusOf(member) === 'active';
  const settings = await settingsLib.getSettings();
  const { recipients, changed } = syncRecipients(settings, {
    email: member.email,
    previousEmail,
    name: fullName(member) || member.email,
    shouldReceive,
  });

  if (changed) {
    await kv.set(settingsLib.SETTINGS_KEY, { ...settings, recipients });
  }
  return { recipientsChanged: changed, recipients };
}

// Called when an application arrives. Never overwrites an existing member.
function buildPendingMember(members, fields, applicationId) {
  const email = (fields.email || '').trim();
  const norm = (e) => (e || '').trim().toLowerCase();
  if (email && members.some(m => norm(m.email) === norm(email))) return null;

  return {
    memberNo: nextMemberNo(members),
    firstName: (fields.firstName || '').trim(),
    lastName: (fields.lastName || '').trim(),
    email,
    phone: (fields.phone || '').trim(),
    whatsapp: (fields.whatsapp || '').trim(),
    address: (fields.address || '').trim(),
    city: (fields.city || '').trim(),
    company: (fields.company || '').trim(),
    jobTitle: (fields.jobTitle || '').trim(),
    joinDate: null,
    isBoardMember: false,
    boardFunction: '',
    status: 'pending',
    source: 'application',
    applicationId: applicationId || null,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  CONTACTS_KEY,
  STATUSES,
  EDITABLE,
  statusOf,
  fullName,
  getMembers,
  saveMembers,
  nextMemberNo,
  applyEdits,
  syncRecipients,
  saveWithRecipientSync,
  buildPendingMember,
};
