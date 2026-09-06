const { kv } = require('@vercel/kv');
const membersLib = require('./members');
const settingsLib = require('./settings');
const board = require('./board');
const { toE164 } = require('./phone');

// Moving the board's addresses off the recipients list and onto the member
// records they belong to.
//
// The recipients list used to carry its own copy of each board member's name,
// email, WhatsApp number and LINE name. This works out which member each copy
// is a copy of, says exactly what would change, and only then writes anything.
// The point of the dry run is the last two lines of the report: who is
// messaged where before, and who is messaged where after. If those differ,
// something is wrong with the matching, not with the idea.

const norm = (e) => String(e || '').trim().toLowerCase();
const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

// An entry that already holds nothing but a decision needs no migrating.
const isLinked = (entry) => !!entry && entry.memberNo != null;

function findMember(entry, members) {
  if (isLinked(entry)) {
    const m = members.find(x => x && x.memberNo === entry.memberNo);
    return { member: m || null, how: m ? 'linked' : 'missing' };
  }
  const byEmail = entry.email
    ? members.find(m => m && norm(m.email) === norm(entry.email))
    : null;
  if (byEmail) return { member: byEmail, how: 'email' };

  // A copy whose address was changed on one side only still has the name. Two
  // people of the same name is a guess, and a guess here messages the wrong
  // person, so it is left unmatched for Mark to settle.
  const named = entry.name
    ? members.filter(m => m && normName(membersLib.fullName(m)) === normName(entry.name))
    : [];
  if (named.length === 1) return { member: named[0], how: 'name' };
  if (named.length > 1) return { member: null, how: 'ambiguous' };
  return { member: null, how: 'none' };
}

// Everyone who would be messaged, per channel, as "Name <address>" - the one
// thing that must not change when the copies are thrown away.
function effective(members, settings) {
  const list = board.resolve(members, settings);
  const out = {};
  board.CHANNELS.forEach(channel => {
    out[channel] = board.on(list, channel)
      .map(r => `${r.name} <${board.addressOn(r, channel)}>`)
      .sort();
  });
  return out;
}

function sameSets(a, b) {
  return board.CHANNELS.every(c => JSON.stringify(a[c]) === JSON.stringify(b[c]));
}

// Works out the whole migration without writing anything. Returns the report
// and the two lists it would save.
function plan(members, settings) {
  const before = effective(members, settings);
  const nextMembers = members.map(m => ({ ...m }));
  const entries = [];
  const nextRecipients = [];

  settingsLib.recipientList(settings).forEach(entry => {
    const channels = board.channelsOf(entry);
    const active = entry.active !== false;
    const { member, how } = findMember(entry, nextMembers);
    const copyWa = toE164(entry.waNumber);
    const copyLine = String(entry.lineName || '').trim();

    if (!member) {
      // Nothing to link it to, so it keeps its own copy and goes on working.
      nextRecipients.push({ ...entry });
      entries.push({
        name: entry.name || entry.email || `Member ${entry.memberNo}`,
        email: entry.email || '',
        memberNo: entry.memberNo != null ? entry.memberNo : null,
        match: how,
        channels, active,
        changes: [],
        note: how === 'ambiguous'
          ? 'More than one member has that name - add the email address to their record and run this again.'
          : how === 'missing'
            ? 'Points at a member record that is no longer there.'
            : 'Not in Member Contacts. Add them there, then run this again.',
      });
      return;
    }

    const target = nextMembers.find(m => m.memberNo === member.memberNo);
    const changes = [];

    // A number the recipients list has and the directory does not is the only
    // copy of it, so it moves across rather than being thrown away.
    if (copyWa && !toE164(target.whatsapp || target.phone)) {
      target.whatsapp = '+' + copyWa;
      changes.push(`WhatsApp ${target.whatsapp} moved onto their member record`);
    } else if (copyWa && toE164(target.whatsapp || target.phone) !== copyWa) {
      changes.push(
        `WhatsApp differs: the list says +${copyWa}, Member Contacts says ` +
        `+${toE164(target.whatsapp || target.phone)} - the record wins`);
    }

    if (copyLine && !String(target.lineName || '').trim()) {
      target.lineName = copyLine;
      changes.push(`LINE name "${copyLine}" moved onto their member record`);
    } else if (copyLine && String(target.lineName || '').trim() !== copyLine) {
      changes.push(
        `LINE name differs: the list says "${copyLine}", Member Contacts says ` +
        `"${target.lineName}" - the record wins`);
    }

    if (entry.email && norm(entry.email) !== norm(target.email)) {
      changes.push(`Email differs: the list says ${entry.email}, Member Contacts says ${target.email} - the record wins`);
    }

    nextRecipients.push({ memberNo: target.memberNo, channels, active });
    entries.push({
      name: membersLib.fullName(target) || target.email,
      email: target.email || '',
      memberNo: target.memberNo,
      match: how,
      channels, active,
      changes,
      note: '',
    });
  });

  // A board member with no entry at all is not asked about anything. Worth
  // saying out loud while we are looking, even though it is not this job to fix.
  const listed = new Set(nextRecipients.map(r => (r.memberNo != null ? 'm' + r.memberNo : norm(r.email))));
  const boardNotListed = nextMembers
    .filter(m => m && m.isBoardMember && membersLib.statusOf(m) === 'active')
    .filter(m => !listed.has('m' + m.memberNo) && !listed.has(norm(m.email)))
    .map(m => ({ memberNo: m.memberNo, name: membersLib.fullName(m) || m.email, email: m.email || '' }));

  const nextSettings = { ...settings, recipients: nextRecipients };
  const after = effective(nextMembers, nextSettings);

  // "Needed" means there is something here that can actually be done. An entry
  // with nobody to match it to will never link, however often this is run, so
  // it is reported as something to fix rather than as work outstanding.
  return {
    needed: entries.some(e => e.match === 'email' || e.match === 'name'),
    stuck: entries.filter(e => !['email', 'name', 'linked'].includes(e.match)).length,
    entries,
    boardNotListed,
    before,
    after,
    identical: sameSets(before, after),
    nextMembers,
    nextSettings,
  };
}

async function report() {
  const [members, settings] = await Promise.all([
    membersLib.getMembers(),
    settingsLib.getSettings(),
  ]);
  const p = plan(members, settings);
  delete p.nextMembers;
  delete p.nextSettings;
  return p;
}

// Applies it, and refuses when the people who would be messaged are not the
// same people at the same addresses - unless Mark has read the difference and
// said to go ahead anyway.
async function apply({ force = false } = {}) {
  const [members, settings] = await Promise.all([
    membersLib.getMembers(),
    settingsLib.getSettings(),
  ]);
  const p = plan(members, settings);

  if (!p.identical && !force) {
    const out = { ...p, applied: false, refused: 'Who gets messaged would change. Read the difference, then confirm.' };
    delete out.nextMembers;
    delete out.nextSettings;
    return out;
  }

  await membersLib.saveMembers(p.nextMembers);
  await kv.set(settingsLib.SETTINGS_KEY, p.nextSettings);

  const out = { ...p, applied: true };
  delete out.nextMembers;
  delete out.nextSettings;
  return out;
}

module.exports = { plan, report, apply, effective, findMember };
