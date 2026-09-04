const busboy = require('busboy');
const nodemailer = require('nodemailer');
const { kv } = require('@vercel/kv');

const SETTINGS_KEY = 'admin:settings';
const LOG_KEY = 'admin:applications';

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

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse multipart with busboy
  const fields = {};
  const files = {};

  await new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType,
        };
      });
    });
    bb.on('finish', resolve);
    bb.on('error', reject);
    req.pipe(bb);
  });

  if (!files.pdf) {
    return res.status(400).json({ success: false, error: 'No PDF file provided' });
  }

  const attachments = [{
    filename: files.pdf.filename,
    content: files.pdf.buffer,
    contentType: 'application/pdf',
  }];
  if (files.cv) {
    attachments.push({
      filename: files.cv.filename,
      content: files.cv.buffer,
      contentType: files.cv.mimeType,
    });
  }

  // Store the application before anything else can fail. Email delivery is
  // best effort; the submission itself must never be lost because of it.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = (fields.applicantName || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
  const appId = timestamp + '_' + safeName;

  // Write the small log entry first. The file blobs are orders of magnitude
  // larger and are the ones at risk of exceeding the KV request size limit; if
  // one of them fails, the application must still show up in the admin list.
  let stored = false;
  try {
    const apps = (await kv.get(LOG_KEY)) || [];
    apps.unshift({
      id: appId,
      name: fields.applicantName || 'Unknown',
      date: new Date().toISOString(),
      hasPdf: false,
      hasCv: false,
      pdfFilename: files.pdf.filename,
      cvFilename: files.cv ? files.cv.filename : null,
      emailedTo: [],
    });
    await kv.set(LOG_KEY, apps);
    stored = true;
  } catch (kvErr) {
    console.error(`KV storage error (non-fatal): could not log application ${appId}:`, kvErr);
    // Continue: the notification email is still worth sending.
  }

  // Patch the log entry in place - used for the stored-file flags below and
  // for the delivery result after the emails go out.
  async function updateLogEntry(patch) {
    if (!stored) return;
    try {
      const apps = (await kv.get(LOG_KEY)) || [];
      const entry = apps.find(a => a.id === appId);
      if (!entry) return;
      Object.assign(entry, patch);
      await kv.set(LOG_KEY, apps);
    } catch (err) {
      console.error(`Could not update log entry for ${appId}:`, err);
    }
  }

  function recordDelivery(emailedTo, emailError) {
    return updateLogEntry(emailError ? { emailedTo, emailError } : { emailedTo });
  }

  // Store each file under its own guard: an oversized CV must not cost us the
  // PDF, and neither must cost us the log entry above. hasPdf/hasCv then
  // describe what is actually retrievable, so admin only offers real downloads.
  let hasPdf = false;
  let hasCv = false;

  try {
    await kv.set(`file:pdf:${appId}`, {
      content: files.pdf.buffer.toString('base64'),
      filename: files.pdf.filename,
      mimeType: 'application/pdf',
    });
    hasPdf = true;
  } catch (kvErr) {
    console.error(`KV storage error (non-fatal): PDF for ${appId} not stored (${files.pdf.buffer.length} bytes):`, kvErr);
  }

  if (files.cv) {
    try {
      await kv.set(`file:cv:${appId}`, {
        content: files.cv.buffer.toString('base64'),
        filename: files.cv.filename,
        mimeType: files.cv.mimeType,
      });
      hasCv = true;
    } catch (kvErr) {
      console.error(`KV storage error (non-fatal): CV for ${appId} not stored (${files.cv.buffer.length} bytes):`, kvErr);
    }
  }

  await updateLogEntry({ hasPdf, hasCv });

  // Load admin settings for recipients and email template
  const settings = await getSettings();
  const recipientList = Array.isArray(settings.recipients)
    ? settings.recipients
    : DEFAULT_SETTINGS.recipients;
  const activeRecipients = recipientList
    .filter(r => r && r.active && r.email)
    .map(r => r.email);

  if (activeRecipients.length === 0) {
    const error = 'No active email recipients configured';
    console.error(`${error} - application ${appId} stored but not emailed`);
    await recordDelivery([], error);
    return res.json({ success: true, stored, emailSent: false, appId, error });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER || 'markberger471@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    // Build email content from template
    const cvNote = files.cv ? ", along with the applicant's CV" : '';
    const subject = (settings.emailSubject || 'New Membership Application: {{name}}')
      .replace(/\{\{name\}\}/g, fields.applicantName || 'Unknown');
    const bodyHtml = (settings.emailBody || DEFAULT_SETTINGS.emailBody)
      .replace(/\{\{name\}\}/g, fields.applicantName || 'Unknown')
      .replace(/\{\{cv_note\}\}/g, cvNote);

    const siteUrl = process.env.SITE_URL
      || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')
      || 'https://rotary-bkkdach.vercel.app';

    // Send individual emails so each recipient gets unique vote links
    const results = [];
    const failures = [];
    for (const recipientEmail of activeRecipients) {
      const recipient = recipientList.find(r => r.email === recipientEmail);
      const recipientName = recipient ? recipient.name : '';
      const approveUrl = `${siteUrl}/api/admin/vote?id=${encodeURIComponent(appId)}&email=${encodeURIComponent(recipientEmail)}&name=${encodeURIComponent(recipientName)}&action=approve`;
      const rejectUrl = `${siteUrl}/api/admin/vote?id=${encodeURIComponent(appId)}&email=${encodeURIComponent(recipientEmail)}&name=${encodeURIComponent(recipientName)}&action=reject`;

      const voteSection = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 24px auto 0;">
          <div style="background: #f0f4f8; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center;">
            <p style="margin: 0 0 6px; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Board Member Action Required</p>
            <p style="margin: 0 0 20px; font-size: 14px; color: #475569;">Please review the attached application and cast your vote.</p>
            <div style="display: inline-block;">
              <a href="${approveUrl}" style="display: inline-block; background: #16a34a; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; margin-right: 12px;">&#10003; Approve</a>
              <a href="${rejectUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px;">&#10007; Reject</a>
            </div>
            <p style="margin: 16px 0 0; font-size: 11px; color: #94a3b8;">This link is unique to you. Do not forward this email.</p>
          </div>
        </div>`;

      const fullHtml = bodyHtml + voteSection;

      // One bad address must not stop the rest of the board being notified.
      try {
        const info = await transporter.sendMail({
          from: `"Rotary Club Bangkok DACH" <${process.env.GMAIL_USER || 'markberger471@gmail.com'}>`,
          to: recipientEmail,
          subject,
          html: fullHtml,
          attachments,
        });
        results.push({ email: recipientEmail, messageId: info.messageId });
      } catch (sendErr) {
        console.error(`Email to ${recipientEmail} failed:`, sendErr);
        failures.push({ email: recipientEmail, error: sendErr.message });
      }
    }

    const delivered = results.map(r => r.email);
    const emailError = failures.length
      ? failures.map(f => `${f.email}: ${f.error}`).join('; ')
      : null;
    await recordDelivery(delivered, emailError);

    if (!delivered.length) {
      return res.json({ success: true, stored, emailSent: false, appId, error: emailError });
    }

    res.json({ success: true, mode: 'gmail', stored, emailSent: true, appId, results, failures });
  } catch (err) {
    console.error('Email error:', err);
    await recordDelivery([], err.message);
    res.json({ success: true, stored, emailSent: false, appId, error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
