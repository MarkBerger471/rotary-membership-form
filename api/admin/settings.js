const { kv } = require('@vercel/kv');
const settingsLib = require('../../lib/settings');
const { toE164 } = require('../../lib/phone');

const { SETTINGS_KEY, DEFAULT_SETTINGS, CHANNELS, getSettings } = settingsLib;

// Everything written here is read by code that decides who gets messaged, so
// it is cleaned on the way in rather than trusted on the way out. A number is
// stored the one way WhatsApp can use it, and a channel nobody has heard of
// is dropped instead of sitting in the list doing nothing.
function cleanRecipient(r) {
  const raw = r && typeof r === 'object' ? r : {};
  const email = String(raw.email || '').trim();
  const cleaned = {
    ...raw,
    email,
    name: String(raw.name || '').trim() || email,
    active: raw.active !== false,
    waNumber: toE164(raw.waNumber || raw.phone || ''),
    lineName: String(raw.lineName || '').trim(),
  };
  // An absent channels field still means "email", which is what it has always
  // meant; only an array that is really there is taken at its word.
  if (Array.isArray(raw.channels)) {
    cleaned.channels = raw.channels
      .map(c => String(c || '').toLowerCase())
      .filter((c, i, a) => CHANNELS.includes(c) && a.indexOf(c) === i);
  }
  delete cleaned.phone;
  return cleaned;
}

function cleanSettings(body) {
  const settings = body && typeof body === 'object' ? { ...body } : {};
  settings.recipients = Array.isArray(settings.recipients)
    ? settings.recipients.filter(r => r && String(r.email || '').trim()).map(cleanRecipient)
    : [];
  return settings;
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
      const settings = cleanSettings(body);
      await saveSettings(settings);
      return res.json({ success: true, settings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};

module.exports.getSettings = getSettings;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.cleanSettings = cleanSettings;
