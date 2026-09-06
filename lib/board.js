const membersLib = require('./members');
const settingsLib = require('./settings');
const { toE164 } = require('./phone');

// Who the board is, and how each of them is asked.
//
// The member directory owns every address the club holds. A board member's
// email address, WhatsApp number and LINE name are facts about that person,
// not about applications, and they are already kept on their contact record -
// so they are read from there and stored nowhere else. admin:settings keeps
// only the part that is genuinely about asking: which channels each of them is
// asked on, and whether they are asked at all.
//
// The two used to hold their own copy of the same addresses, which is two
// places to change a number and one of them always forgotten.

const CHANNELS = settingsLib.CHANNELS;

// The number to message them on. Their WhatsApp field if they have one,
// otherwise their phone number - which for most people is the same line.
function waNumberOf(member) {
  return toE164((member && member.whatsapp) || (member && member.phone));
}

const norm = (e) => String(e || '').trim().toLowerCase();

// An entry saved before there was anything but email has no channels field,
// and every one of them was an email recipient - so that is what an absent
// field means. An empty array is a deliberate choice and is left alone.
function channelsOf(entry) {
  if (!entry) return [];
  if (!Array.isArray(entry.channels)) return ['email'];
  return entry.channels.filter(c => CHANNELS.includes(c));
}

// One settings entry, resolved against the directory.
//
// A linked entry (memberNo) takes every address from the member record. An
// entry from before the two were separated carries its own copy, and keeps
// using it until it is migrated - so nobody stops being asked on the day this
// ships, and what changes changes when Mark says so.
function resolveEntry(entry, members) {
  const channels = channelsOf(entry);
  const active = entry.active !== false;

  if (entry.memberNo != null) {
    const member = members.find(m => m && m.memberNo === entry.memberNo);
    if (!member) {
      return {
        memberNo: entry.memberNo, linked: true, missing: true,
        email: '', name: `Member ${entry.memberNo}`, waNumber: '', lineName: '',
        boardFunction: '', channels, active,
      };
    }
    return {
      memberNo: member.memberNo,
      linked: true,
      missing: false,
      email: String(member.email || '').trim(),
      name: membersLib.fullName(member) || String(member.email || '').trim(),
      waNumber: waNumberOf(member),
      lineName: String(member.lineName || '').trim(),
      boardFunction: member.boardFunction || '',
      channels,
      active,
    };
  }

  const email = String(entry.email || '').trim();
  return {
    memberNo: null,
    linked: false,
    missing: false,
    email,
    name: String(entry.name || '').trim() || email,
    waNumber: toE164(entry.waNumber),
    lineName: String(entry.lineName || '').trim(),
    boardFunction: '',
    channels,
    active,
  };
}

// The whole board, resolved. Two entries for one address would ask that person
// twice, so the first wins - which is the linked one, because a migration
// leaves the copy behind rather than the record.
function resolve(members, settings) {
  // The index is where this came from in admin:settings, so the admin page can
  // tick a channel without having to work out which entry it belongs to.
  const list = settingsLib.recipientList(settings)
    .map((e, index) => ({ ...resolveEntry(e, members || []), index }));
  const seen = new Set();
  return list.filter(r => {
    if (!r.email) return r.linked;   // keep a broken link visible, drop a blank
    const key = norm(r.email);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recipients() {
  const [members, settings] = await Promise.all([
    membersLib.getMembers(),
    settingsLib.getSettings(),
  ]);
  return resolve(members, settings);
}

// Where a channel actually reaches them. Without it there is nowhere to send,
// so a ticked channel with no address does not count - that is a message that
// would sit in the queue for ever rather than a message that goes out.
function addressOn(recipient, channel) {
  if (!recipient) return '';
  if (channel === 'whatsapp') return recipient.waNumber || '';
  if (channel === 'line') return recipient.lineName || '';
  return recipient.email || '';
}

// Who will be reached on one channel: switched on, that channel ticked, and an
// address for it.
function on(list, channel) {
  return (list || []).filter(
    r => r && r.active && r.email && !r.missing
      && r.channels.includes(channel) && addressOn(r, channel)
  );
}

// The addresses to email. A board member can have email unticked and still be
// asked, on WhatsApp or on LINE.
function emailAddresses(list) {
  return on(list, 'email').map(r => r.email);
}

// Everyone who will be asked, on any channel, as one list of email addresses -
// which is what a poll is counted against. A board member is identified by
// their email address whatever carries the message to them, because that is
// what the vote link is keyed by.
function askedAddresses(list) {
  const seen = [];
  CHANNELS.forEach(channel => {
    on(list, channel).forEach(r => {
      if (!seen.some(e => norm(e) === norm(r.email))) seen.push(r.email);
    });
  });
  return seen;
}

function byEmail(list, email) {
  return (list || []).find(r => r && norm(r.email) === norm(email)) || null;
}

function nameFor(list, email) {
  const r = byEmail(list, email);
  return r ? r.name || '' : '';
}

// Which channels one address is reached on - what the application log records,
// so it can say how each board member was asked.
function channelsFor(list, email) {
  return CHANNELS.filter(channel => on(list, channel).some(r => norm(r.email) === norm(email)));
}

module.exports = {
  CHANNELS,
  waNumberOf,
  channelsOf,
  resolveEntry,
  resolve,
  recipients,
  addressOn,
  on,
  emailAddresses,
  askedAddresses,
  byEmail,
  nameFor,
  channelsFor,
};
