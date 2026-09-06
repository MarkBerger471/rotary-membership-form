const { kv } = require('@vercel/kv');
const links = require('./links');
const settingsLib = require('./settings');

// The board's WhatsApp and LINE messages, waiting for the senders on Mark's
// Mac to pick them up. Email leaves from the server the moment it is written;
// nothing else can, because WhatsApp and LINE are delivered from Mark's own
// accounts on his own machine. So an ask on those channels is written down
// here and goes out when the sender next runs - which is why a queued message
// counts as "asked" straight away: the asking has been decided, only the
// delivery is waiting.
//
// It is one flat list rather than a queue per channel, so a message can never
// be dropped by being written to a key nobody reads.

const KEY = 'admin:outbox';

// Email is not in here. It is sent, not queued.
const CHANNELS = ['whatsapp', 'line'];

// Sent and failed messages are kept for a while so the admin page can say what
// happened, then dropped - this is a queue, not a record. The record of who was
// asked lives on the application.
const KEEP_DONE_DAYS = 21;
const MAX_ENTRIES = 400;

async function getOutbox() {
  try {
    const list = await kv.get(KEY);
    if (Array.isArray(list)) return list;
  } catch (err) {
    console.error('Error reading the board outbox:', err);
  }
  return [];
}

async function saveOutbox(list) {
  await kv.set(KEY, list);
}

const isDone = (e) => !!(e && (e.sentAt || e.failedAt));
const isPending = (e) => !!(e && e.text && CHANNELS.includes(e.channel) && !isDone(e));

// Drop finished entries once they are old enough to be of no interest, and
// never let the list grow without limit. Pending entries are never dropped:
// a message nobody has sent yet is the one thing here that still matters.
function prune(list, now = Date.now()) {
  const cutoff = now - KEEP_DONE_DAYS * 86400000;
  const kept = list.filter(e => {
    if (isPending(e)) return true;
    const at = new Date(e.sentAt || e.failedAt || e.queuedAt || 0).getTime();
    return isFinite(at) && at >= cutoff;
  });
  if (kept.length <= MAX_ENTRIES) return kept;
  const pending = kept.filter(isPending);
  const done = kept.filter(e => !isPending(e))
    .sort((a, b) => new Date(b.sentAt || b.failedAt || 0) - new Date(a.sentAt || a.failedAt || 0));
  return pending.concat(done.slice(0, Math.max(0, MAX_ENTRIES - pending.length)));
}

// One message per application, person, channel and stage. The key is what
// stops a resend, a retried cron run or a second click asking somebody the
// same thing twice - it is checked against everything still on the list,
// whether that entry has gone out yet or not.
const keyFor = (appId, email, channel, kind) =>
  `${appId}|${String(email || '').trim().toLowerCase()}|${channel}|${kind}`;

// ------------------------------------------------------------------ wording

const dateOf = (iso) => {
  const d = new Date(iso);
  return isFinite(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
};

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// The links a board member needs, whichever channel they are reading this on.
// The application itself is one of them: a message has no attachment, so
// without this they would be voting on a name.
function linkBlock(app, email, name, channel, hasFiles) {
  const lines = [];
  if (hasFiles) lines.push(`The application: ${links.fileUrl(app.id, email, 'pdf')}`);
  lines.push(`Approve: ${links.voteUrl(app.id, email, name, 'approve', channel)}`);
  lines.push(`Reject: ${links.voteUrl(app.id, email, name, 'reject', channel)}`);
  return lines.join('\n');
}

function closesOn(app, closeDays) {
  if (!app.pollOpenedAt) return null;
  const opened = new Date(app.pollOpenedAt).getTime();
  if (!isFinite(opened)) return null;
  return dateOf(new Date(opened + closeDays * 86400000).toISOString());
}

// Plain and short. These are read on a phone, half of them while somebody is
// doing something else, and the whole point of the exercise is that answering
// takes one tap.
function textFor({ kind, app, recipient, channel, closeDays, daysLeft, result, tally }) {
  const hello = firstNameOf(recipient.name);
  const greeting = hello ? `${hello}, ` : '';
  const who = app.name || 'the applicant';
  const hasFiles = !!(app.hasPdf || app.hasCv);
  const linkLines = linkBlock(app, recipient.email, recipient.name, channel, hasFiles);

  if (kind === 'result') {
    const counts = tally
      ? `${tally.approved.length} approved, ${tally.rejected.length} rejected, ${tally.pending.length} did not vote.`
      : '';
    return [
      `Rotary Club Bangkok DACH`,
      ``,
      `${greeting}the vote on ${who} has closed: ${result ? result.label : 'no decision'}.`,
      [result && result.detail, counts].filter(Boolean).join(' '),
    ].join('\n');
  }

  if (kind.startsWith('reminder')) {
    const left = daysLeft == null ? null
      : daysLeft <= 1 ? 'tomorrow' : `in ${Math.round(daysLeft)} days`;
    return [
      `Rotary Club Bangkok DACH`,
      ``,
      `${greeting}the application from ${who} is still waiting on your vote${left ? `, and it closes ${left}` : ''}.`,
      ``,
      linkLines,
      ``,
      `If you have already voted, ignore this.`,
    ].join('\n');
  }

  const closing = closesOn(app, closeDays);
  return [
    `Rotary Club Bangkok DACH`,
    ``,
    `${greeting}${who} has applied to join. Please have a look and vote.`,
    ``,
    linkLines,
    ``,
    `One objection blocks the application${closing ? `. Voting closes on ${closing}` : ''}.`,
  ].join('\n');
}

// ------------------------------------------------------------------- asking

// Write the WhatsApp and LINE messages for one application. `only` narrows it
// to particular addresses - a resend, or a reminder to whoever has not voted.
// Returns the addresses that now have a message waiting, and on what.
//
// Nothing here throws at the caller: an application must never fail to be
// stored, and a vote must never fail to be recorded, because a message could
// not be queued.
async function askBoard(settings, app, options = {}) {
  const { kind = 'ask', only = null, closeDays, daysLeft, result, tally } = options;
  const norm = (e) => (e || '').trim().toLowerCase();
  const wanted = only ? only.map(norm) : null;

  const entries = [];
  const via = {};
  CHANNELS.forEach(channel => {
    settingsLib.recipientsOn(settings, channel).forEach(r => {
      if (wanted && !wanted.includes(norm(r.email))) return;
      entries.push({
        id: 'ob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
        key: keyFor(app.id, r.email, channel, kind),
        channel,
        kind,
        appId: app.id,
        appName: app.name || '',
        email: r.email,
        name: r.name || r.email,
        waNumber: String(r.waNumber || '').trim(),
        lineName: String(r.lineName || '').trim(),
        text: textFor({ kind, app, recipient: r, channel, closeDays, daysLeft, result, tally }),
        queuedAt: new Date().toISOString(),
      });
      (via[r.email] = via[r.email] || []).push(channel);
    });
  });

  if (!entries.length) return { queued: [], via: {}, entries: [] };

  try {
    const list = prune(await getOutbox());
    const seen = new Set(list.map(e => e.key));
    const fresh = entries.filter(e => !seen.has(e.key));
    if (fresh.length) await saveOutbox(list.concat(fresh));
    return { queued: Object.keys(via), via, entries: fresh };
  } catch (err) {
    console.error(`Could not queue board messages for ${app.id}:`, err);
    return { queued: [], via: {}, entries: [], error: err.message };
  }
}

// What a sender should pick up now. Board messages carry no images, so the
// shape matches a queued guest closely enough that the senders treat both the
// same way and only the line written back afterwards differs.
async function pendingFor(channel) {
  const list = await getOutbox();
  return list.filter(e => isPending(e) && e.channel === channel);
}

// A sender reporting back. An error means it decided this one cannot be sent -
// a number not on WhatsApp, a LINE name that matches nothing - so it comes off
// the queue with the reason attached rather than jamming every run after it.
async function complete(id, { error } = {}) {
  const list = await getOutbox();
  const entry = list.find(e => e && e.id === id);
  if (!entry) return null;
  if (error) {
    entry.failedAt = new Date().toISOString();
    entry.error = String(error).slice(0, 300);
  } else {
    entry.sentAt = new Date().toISOString();
    delete entry.error;
  }
  await saveOutbox(prune(list));
  return entry;
}

module.exports = {
  KEY,
  CHANNELS,
  getOutbox,
  saveOutbox,
  prune,
  isPending,
  keyFor,
  textFor,
  askBoard,
  pendingFor,
  complete,
};
