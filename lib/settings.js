const { kv } = require('@vercel/kv');

const SETTINGS_KEY = 'admin:settings';

const DEFAULT_SETTINGS = {
  recipients: [
    { email: 'markberger471@gmail.com', name: 'Mark Berger', active: true }
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

function activeRecipients(settings) {
  return recipientList(settings)
    .filter(r => r && r.active && r.email)
    .map(r => r.email);
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
  getSettings,
  recipientList,
  activeRecipients,
  recipientName,
};
