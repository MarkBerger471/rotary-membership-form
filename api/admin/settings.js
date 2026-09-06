const { kv } = require('@vercel/kv');
const settingsLib = require('../../lib/settings');
const migration = require('../../lib/migration');
const board = require('../../lib/board');
const outbox = require('../../lib/outbox');
const apps = require('../../lib/applications');
const mailer = require('../../lib/mailer');
const { toE164 } = require('../../lib/phone');

const { SETTINGS_KEY, DEFAULT_SETTINGS, CHANNELS, getSettings } = settingsLib;

// Everything written here is read by code that decides who gets messaged, so
// it is cleaned on the way in rather than trusted on the way out. A number is
// stored the one way WhatsApp can use it, and a channel nobody has heard of
// is dropped instead of sitting in the list doing nothing.
function cleanRecipient(r) {
  const raw = r && typeof r === 'object' ? r : {};

  // A migrated entry is a decision and nothing else: which member, which
  // channels, asked or not. Every address is read from their member record,
  // so an address arriving here would only be a second copy going stale.
  if (raw.memberNo != null && Number.isFinite(Number(raw.memberNo))) {
    const cleaned = { memberNo: Number(raw.memberNo), active: raw.active !== false };
    if (Array.isArray(raw.channels)) {
      cleaned.channels = raw.channels
        .map(c => String(c || '').toLowerCase())
        .filter((c, i, a) => CHANNELS.includes(c) && a.indexOf(c) === i);
    }
    return cleaned;
  }

  // An entry that has not been migrated keeps its own copy and goes on
  // working, so it is cleaned the way it always was.
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
    ? settings.recipients
        .filter(r => r && (r.memberNo != null || String(r.email || '').trim()))
        .map(cleanRecipient)
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

  // Moving the board's addresses onto their member records. GET says exactly
  // what would change and writes nothing; POST does it. Both live on this
  // function rather than a route of their own because the Hobby plan allows
  // twelve and all twelve are spoken for.
  const wantsMigration = req.query && (req.query.migrate === '1' || req.query.migrate === 'true');

  if (req.method === 'GET' && wantsMigration) {
    try {
      return res.json(await migration.report());
    } catch (err) {
      console.error('Migration report failed:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST' && wantsMigration) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      return res.json(await migration.apply({ force: !!body.force }));
    } catch (err) {
      console.error('Migration failed:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // The recipients tab needs the board as it actually resolves - every address
  // read from the member directory - alongside the raw entries it edits.
  if (req.method === 'GET' && req.query && (req.query.board === '1' || req.query.board === 'true')) {
    const settings = await getSettings();
    return res.json({ settings, recipients: await board.recipients() });
  }

  // A preview built by the code that builds the real thing. Anything less is a
  // picture of a message the board will never receive - which is what the old
  // preview was, showing the body without the Approve and Reject block that is
  // the entire point of the email.
  if (req.method === 'POST' && req.query && req.query.preview) {
    try {
      const edits = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const settings = { ...(await getSettings()), ...edits };
      const list = await board.recipients();
      const who = list.find(r => r.active && r.email) || {
        email: 'board.member@example.org', name: 'Board Member', waNumber: '', lineName: '',
      };
      const sample = {
        id: 'preview', name: 'Sample Applicant', hasPdf: true, hasCv: true,
        pollOpenedAt: new Date().toISOString(),
      };

      if (req.query.preview === 'message') {
        return res.json({
          to: who.name,
          text: outbox.textFor({
            kind: 'ask', app: sample, recipient: who, channel: 'whatsapp',
            closeDays: apps.CLOSE_DAYS, template: settings.messageTemplate,
          }),
        });
      }

      const bodyHtml = String(settings.emailBody || settingsLib.DEFAULT_SETTINGS.emailBody)
        .replace(/\{\{name\}\}/g, sample.name)
        .replace(/\{\{cv_note\}\}/g, ", along with the applicant's CV");
      const html = bodyHtml + mailer.voteSection(sample.id, who.email, who.name);
      return res.json({
        to: who.name,
        subject: String(settings.emailSubject || '').replace(/\{\{name\}\}/g, sample.name),
        html,
        text: mailer.htmlToText(html),
      });
    } catch (err) {
      console.error('Preview failed:', err);
      return res.status(500).json({ error: err.message });
    }
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
