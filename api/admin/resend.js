const apps = require('../../lib/applications');
const settingsLib = require('../../lib/settings');
const mailer = require('../../lib/mailer');

// Sends the board-vote email for an application that was not delivered to
// everyone - a partial send, a bounce, or a recipient added after the fact.
// Recipients already recorded in emailedTo are skipped, so it never
// double-mails anyone.
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

    // markDelivered records addresses that were already mailed but never made
    // it into emailedTo - e.g. a run that was cut short after some sends. They
    // are recorded, never re-sent, so reminders still reach them.
    const marked = Array.isArray(body.markDelivered) ? body.markDelivered : [];
    const already = (Array.isArray(app.emailedTo) ? app.emailedTo : [])
      .concat(marked.filter(e => !(app.emailedTo || []).some(a => norm(a) === norm(e))));

    // An explicit list wins; otherwise everyone active who has not had it yet.
    const requested = Array.isArray(body.emails) && body.emails.length
      ? body.emails
      : settingsLib.activeRecipients(settings).filter(e => !already.some(a => norm(a) === norm(e)));

    const targets = requested.filter(e => !already.some(a => norm(a) === norm(e)));
    if (!targets.length) {
      return res.json({ success: true, sent: [], skipped: requested, note: 'Everyone requested already had it' });
    }

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

    await mailer.mapLimit(targets, 4, async (email) => {
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

    await apps.updateApplication(appId, { emailedTo: already.concat(sent) });
    return res.json({ success: true, sent, failures, emailedTo: already.concat(sent) });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: err.message });
  }
};
