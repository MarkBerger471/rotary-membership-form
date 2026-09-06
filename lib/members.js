const { kv } = require('@vercel/kv');
const settingsLib = require('./settings');
const { toE164 } = require('./phone');

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

// lineName is their LINE display name, exactly as it reads in Mark's chat
// list. It lives here with the rest of their contact details rather than on
// the recipients list, because it is a fact about the person.
const EDITABLE = [
  'firstName', 'lastName', 'email', 'phone', 'whatsapp', 'lineName',
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

// A board member belongs on the recipients list; nobody else does. This is the
// single place that keeps admin:settings in step with the directory.
//
// What goes on that list is only the decision - which channels they are asked
// on, and whether they are asked. Their name, email, number and LINE name are
// read from this record whenever they are needed, so there is one copy of each
// and nothing to keep in step.
function syncRecipients(settings, { memberNo, email, previousEmail, shouldReceive }) {
  const list = settingsLib.recipientList(settings);
  const norm = (e) => (e || '').trim().toLowerCase();

  let next = list.slice();
  let changed = false;

  const isThisMember = (r) => r && r.memberNo != null && r.memberNo === memberNo;
  // An entry from before the split carries its own copy of the address. One
  // for this member is the same person twice, so it is replaced rather than
  // left behind to be asked alongside the linked entry.
  const isOldCopyOf = (r, address) =>
    r && r.memberNo == null && address && norm(r.email) === norm(address);

  const drop = (test) => {
    const before = next.length;
    next = next.filter(r => !test(r));
    if (next.length !== before) changed = true;
  };

  if (shouldReceive && email) {
    const existing = next.find(isThisMember);
    const stale = next.find(r => isOldCopyOf(r, email) || isOldCopyOf(r, previousEmail));

    if (existing) {
      if (existing.active === false) { existing.active = true; changed = true; }
    } else {
      // Carry the old copy's channel choices onto the linked entry, so
      // migrating somebody never quietly stops them being asked on WhatsApp.
      next.push({
        memberNo,
        channels: stale && Array.isArray(stale.channels) ? stale.channels.slice() : ['email'],
        active: true,
      });
      changed = true;
    }
    drop(r => isOldCopyOf(r, email) || isOldCopyOf(r, previousEmail));
  } else {
    drop(r => isThisMember(r) || isOldCopyOf(r, email) || isOldCopyOf(r, previousEmail));
  }

  return { recipients: next, changed };
}

// Persist a member change and bring the recipients list in line with it.
async function saveWithRecipientSync(members, member, previousEmail) {
  await saveMembers(members);

  const shouldReceive = !!member.isBoardMember && statusOf(member) === 'active';
  const settings = await settingsLib.getSettings();
  const { recipients, changed } = syncRecipients(settings, {
    memberNo: member.memberNo,
    email: member.email,
    previousEmail,
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
    lineName: '',
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
