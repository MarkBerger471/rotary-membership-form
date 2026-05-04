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

async function saveSettings(settings) {
  await kv.set(SETTINGS_KEY, settings);
}

module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    const settings = await getSettings();
    return res.json(settings);
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await saveSettings(body);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

module.exports.getSettings = getSettings;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
