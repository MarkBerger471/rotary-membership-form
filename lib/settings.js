const { kv } = require('@vercel/kv');

const SETTINGS_KEY = 'admin:settings';

// How the board can be asked about an application. Email is sent by the server;
// WhatsApp and LINE are queued here and delivered by the senders on Mark's Mac,
// from his own accounts. Whichever one carries the message, it carries the same
// two links, and a vote lands in the same place.
const CHANNELS = ['email', 'whatsapp', 'line'];

const DEFAULT_SETTINGS = {
  recipients: [
    { email: 'markberger471@gmail.com', name: 'Mark Berger', active: true, channels: ['email'] }
  ],
  emailSubject: 'New Membership Application: {{name}}',
  emailBody: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: #17458f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">New Membership Application</h1>
    <p style="color: #f7a81b; margin: 5px 0 0;">Rotary Club Bangkok DACH</p>
  </div>
  <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e9ecef;">
    <p>Dear Membership Committee,</p>
    <p>A new membership application has been submitted by <strong>{{name}}</strong>.</p>
    <p>Please find the application summary PDF attached{{cv_note}}.</p>
    <p style="margin-top: 20px; color: #666; font-size: 12px;">
      This email was sent automatically from the online membership application form.
    </p>
  </div>
  <div style="background: #f7a81b; padding: 8px; text-align: center; border-radius: 0 0 8px 8px;">
    <span style="color: #17458f; font-size: 11px; font-weight: bold;">Rotary Club Bangkok DACH</span>
  </div>
</div>`
};

async function getSettings() {
  try {
    const settings = await kv.get(SETTINGS_KEY);
    if (settings) return settings;
  } catch (err) {
    console.error('Error reading settings:', err);
  }
  return DEFAULT_SETTINGS;
}

// An admin:settings written by hand or by an older version of the admin page
// may be missing recipients entirely; never let that throw.
function recipientList(settings) {
  return Array.isArray(settings && settings.recipients)
    ? settings.recipients
    : DEFAULT_SETTINGS.recipients;
}

// A recipient saved before the board could be asked on anything but email has
// no channels field. Every one of them was an email recipient, so that is what
// an absent field means - never "no channels", which would quietly stop the
// board being asked at all. An empty array is a deliberate choice and is left
// alone; the admin page says out loud that nobody will be asked.
function channelsOf(recipient) {
  if (!recipient) return [];
  if (!Array.isArray(recipient.channels)) return ['email'];
  return recipient.channels.filter(c => CHANNELS.includes(c));
}

// Where a channel actually reaches them. Without it there is nowhere to send,
// so a ticked channel with no address does not count - that is a message that
// would sit in the queue for ever rather than a message that goes out.
function addressOn(recipient, channel) {
  if (!recipient) return '';
  if (channel === 'whatsapp') return String(recipient.waNumber || '').trim();
  if (channel === 'line') return String(recipient.lineName || '').trim();
  return String(recipient.email || '').trim();
}

// The recipients who will be reached on one channel: switched on, that channel
// ticked, and an address for it.
function recipientsOn(settings, channel) {
  return recipientList(settings).filter(
    r => r && r.active && r.email && channelsOf(r).includes(channel) && addressOn(r, channel)
  );
}

// The addresses to email. Kept under its old name because every caller of it
// is a mail send; what changed is that a recipient can now have email unticked
// and still be asked, on WhatsApp or on LINE.
function activeRecipients(settings) {
  return recipientsOn(settings, 'email').map(r => r.email);
}

// Everyone who will be asked, on any channel, as one list of email addresses -
// which is what a poll is counted against. A board member is identified by
// their email address whatever carries the message to them, because that is
// what the vote link is keyed by.
function askedAddresses(settings) {
  const seen = [];
  CHANNELS.forEach(channel => {
    recipientsOn(settings, channel).forEach(r => {
      if (!seen.some(e => e.toLowerCase() === r.email.toLowerCase())) seen.push(r.email);
    });
  });
  return seen;
}

// Which channels one address will be reached on - what the application log
// records, so it can say how each board member was asked.
function channelsFor(settings, email) {
  const norm = (e) => (e || '').trim().toLowerCase();
  return CHANNELS.filter(channel =>
    recipientsOn(settings, channel).some(r => norm(r.email) === norm(email))
  );
}

function recipientByEmail(settings, email) {
  const norm = (e) => (e || '').trim().toLowerCase();
  return recipientList(settings).find(r => r && norm(r.email) === norm(email)) || null;
}

function recipientName(settings, email) {
  const r = recipientList(settings).find(
    x => x && (x.email || '').toLowerCase() === (email || '').toLowerCase()
  );
  return r ? r.name || '' : '';
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  CHANNELS,
  getSettings,
  recipientList,
  channelsOf,
  addressOn,
  recipientsOn,
  activeRecipients,
  askedAddresses,
  channelsFor,
  recipientByEmail,
  recipientName,
};
