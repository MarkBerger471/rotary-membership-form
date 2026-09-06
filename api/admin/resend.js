const apps = require('../../lib/applications');
const settingsLib = require('../../lib/settings');
const outbox = require('../../lib/outbox');
const mailer = require('../../lib/mailer');

// Asks the board about an application that did not reach everyone - a partial
// send, a bounce, or a recipient added after the fact. Anyone already recorded
// as asked is skipped, so nobody is asked twice, and each person is asked on
// the channels they have ticked: email from here, WhatsApp and LINE queued for
// the senders on Mark's Mac.
module.exports = async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || req.headers['x-admin-password'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const appId = body.appId;
    if (!appId) return res.status(400).json({ error: 'Missing appId' });

    const list = await apps.getApplications();
    const app = list.find(a => a.id === appId);
    if (!app) return res.status(404).json({ error: 'Application not found' });

    const settings = await settingsLib.getSettings();
    const norm = (e) => (e || '').trim().toLowerCase();

    // markDelivered records addresses that were already asked but never made
    // it onto the record - e.g. a run that was cut short after some sends.
    // They are recorded, never asked again, so reminders still reach them.
    const marked = Array.isArray(body.markDelivered) ? body.markDelivered : [];
    const asked = apps.askedList(app);
    const already = asked.concat(marked.filter(e => !asked.some(a => norm(a) === norm(e))));

    // An explicit list wins; otherwise everyone who would be asked on any
    // channel and has not had it yet.
    const requested = Array.isArray(body.emails) && body.emails.length
      ? body.emails
      : settingsLib.askedAddresses(settings).filter(e => !already.some(a => norm(a) === norm(e)));

    const targets = requested.filter(e => !already.some(a => norm(a) === norm(e)));
    if (!targets.length) {
      return res.json({ success: true, sent: [], skipped: requested, note: 'Everyone requested already had it' });
    }

    // Someone not on the recipients list at all is still emailed - that is the
    // "added after the fact" case this endpoint exists for. The only person
    // skipped is one who is on the list with email deliberately unticked.
    const emailTargets = targets.filter(e => {
      const r = settingsLib.recipientByEmail(settings, e);
      return !r || settingsLib.channelsOf(r).includes('email');
    });

    const attachments = await apps.getAttachments(app);
    const cvNote = app.hasCv ? ", along with the applicant's CV" : '';
    const subject = (settings.emailSubject || 'New Membership Application: {{name}}')
      .replace(/\{\{name\}\}/g, app.name || 'Unknown');
    const bodyHtml = (settings.emailBody || settingsLib.DEFAULT_SETTINGS.emailBody)
      .replace(/\{\{name\}\}/g, app.name || 'Unknown')
      .replace(/\{\{cv_note\}\}/g, cvNote);

    const transporter = mailer.createTransporter();
    const sent = [];
    const failures = [];

    await mailer.mapLimit(emailTargets, 4, async (email) => {
      try {
        await transporter.sendMail(mailer.message({
          to: email,
          subject,
          html: bodyHtml + mailer.voteSection(app.id, email, settingsLib.recipientName(settings, email)),
          attachments,
        }));
        sent.push(email);
      } catch (err) {
        console.error(`Resend to ${email} failed for ${appId}:`, err);
        failures.push({ email, error: err.message });
      }
    });

    // WhatsApp and LINE for the same people, queued for the senders.
    const queued = await outbox.askBoard(settings, app, {
      kind: 'ask',
      only: targets,
      closeDays: apps.CLOSE_DAYS,
    });

    const emailedTo = (Array.isArray(app.emailedTo) ? app.emailedTo : [])
      .concat(sent.filter(e => !(app.emailedTo || []).some(a => norm(a) === norm(e))));

    // Who has now been asked, and on what. Queued counts as asked: the asking
    // has been decided, only the delivery is waiting on the Mac.
    const askedVia = { ...(app.askedVia && typeof app.askedVia === 'object' ? app.askedVia : {}) };
    const add = (email, channel) => {
      const hit = Object.keys(askedVia).find(k => norm(k) === norm(email)) || email;
      askedVia[hit] = (askedVia[hit] || []).concat(channel).filter((c, i, a) => a.indexOf(c) === i);
    };
    sent.forEach(e => add(e, 'email'));
    Object.keys(queued.via).forEach(e => queued.via[e].forEach(c => add(e, c)));

    const askedTo = already.concat(
      Object.keys(askedVia).filter(e => !already.some(a => norm(a) === norm(e)))
    );

    await apps.updateApplication(appId, { emailedTo, askedTo, askedVia });
    return res.json({
      success: true, sent, failures, emailedTo, askedTo,
      queued: queued.entries.map(e => `${e.name} (${e.channel})`),
    });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: err.message });
  }
};
