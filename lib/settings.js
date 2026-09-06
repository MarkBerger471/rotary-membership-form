const { kv } = require('@vercel/kv');

const SETTINGS_KEY = 'admin:settings';

// How the board can be asked about an application. Email is sent by the server;
// WhatsApp and LINE are queued here and delivered by the senders on Mark's Mac,
// from his own accounts. Whichever one carries the message, it carries the same
// two links, and a vote lands in the same place.
const CHANNELS = ['email', 'whatsapp', 'line'];

// What the board is sent on WhatsApp and LINE when an application arrives.
// Read on a phone, usually while the reader is doing something else, so it is
// short and the two links do the work.
//
//   {{greeting}}   "Hans, " for the board member, or nothing if unknown
//   {{first_name}} "Hans"
//   {{name}}       the applicant
//   {{links}}      the application, Approve and Reject links
//   {{closes}}     "Voting closes on 20 Sept 2026." or nothing
//
// {{links}} is what makes the message worth sending. If it is edited out, it
// is put back on the end rather than sending a message nobody can answer.
const DEFAULT_MESSAGE_TEMPLATE = `Rotary Club Bangkok DACH

{{greeting}}{{name}} has applied to join. Please have a look and vote.

{{links}}

One objection blocks the application. {{closes}}`;

// A recipient entry is a decision, not a contact card: which channels this
// board member is asked on, and whether they are asked at all. Every address
// comes from their record in the member directory - see lib/board.js. Entries
// written before that separation carry their own copy of the addresses and go
// on working until they are migrated.
const DEFAULT_SETTINGS = {
  recipients: [
    { email: 'markberger471@gmail.com', name: 'Mark Berger', active: true, channels: ['email'] }
  ],
  emailSubject: 'New Membership Application: {{name}}',
  messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
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

module.exports = {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  CHANNELS,
  DEFAULT_MESSAGE_TEMPLATE,
  getSettings,
  recipientList,
};
