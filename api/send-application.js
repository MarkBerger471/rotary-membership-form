const busboy = require('busboy');
const { kv } = require('@vercel/kv');
const settingsLib = require('../lib/settings');
const { LOG_KEY } = require('../lib/applications');
const membersLib = require('../lib/members');
const photosLib = require('../lib/photos');
const mailer = require('../lib/mailer');
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
      // Opens the 5/12/14-day board poll that api/cron/poll.js drives.
      pollOpenedAt: new Date().toISOString(),
      pollStatus: 'open',
      remindersSent: [],
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

  // Seed a pending directory entry so the applicant can be confirmed as a
  // member with one tick instead of being retyped. Never overwrites anyone,
  // and never blocks the application if it fails.
  try {
    const directory = await membersLib.getMembers();
    const pending = membersLib.buildPendingMember(directory, {
      firstName: fields.firstName,
      lastName: fields.familyName,
      email: fields.businessEmail,
      phone: fields.phone,
      whatsapp: fields.whatsapp,
      address: fields.billingAddress,
      company: fields.businessName,
      jobTitle: fields.jobTitle,
    }, appId);
    if (pending) {
      // Keep the applicant's own photo as their directory picture - the file
      // they uploaded, or failing that the one embedded in the application PDF.
      const photo = photosLib.choosePhoto(files);
      if (photo) {
        try {
          await kv.set(`file:photo:${pending.memberNo}`, {
            content: photo.content.toString('base64'),
            mimeType: photo.mimeType,
          });
          pending.hasPhoto = true;
          console.log(`Stored photo for member ${pending.memberNo} from ${photo.source} (${photo.content.length} bytes)`);
        } catch (photoErr) {
          console.error(`Could not store photo for member ${pending.memberNo}:`, photoErr);
        }
      }
      directory.push(pending);
      await membersLib.saveMembers(directory);
      await updateLogEntry({ memberNo: pending.memberNo });
    }
  } catch (err) {
    console.error(`Could not create pending member for ${appId}:`, err);
  }

  // Load admin settings for recipients and email template
  const settings = await settingsLib.getSettings();
  const recipientList = settingsLib.recipientList(settings);
  const activeRecipients = settingsLib.activeRecipients(settings);

  if (activeRecipients.length === 0) {
    const error = 'No active email recipients configured';
    console.error(`${error} - application ${appId} stored but not emailed`);
    await recordDelivery([], error);
    return res.json({ success: true, stored, emailSent: false, appId, error });
  }

  try {
    const transporter = mailer.createTransporter();

    // Build email content from template
    const cvNote = files.cv ? ", along with the applicant's CV" : '';
    const subject = (settings.emailSubject || 'New Membership Application: {{name}}')
      .replace(/\{\{name\}\}/g, fields.applicantName || 'Unknown');
    const bodyHtml = (settings.emailBody || settingsLib.DEFAULT_SETTINGS.emailBody)
      .replace(/\{\{name\}\}/g, fields.applicantName || 'Unknown')
      .replace(/\{\{cv_note\}\}/g, cvNote);

    // Send individual emails so each recipient gets unique vote links.
    // Capped concurrency: sequential sends timed out the function at four
    // recipients, one attachment upload at a time.
    const results = [];
    const failures = [];
    await mailer.mapLimit(activeRecipients, 4, async (recipientEmail) => {
      const recipient = recipientList.find(r => r.email === recipientEmail);
      const recipientName = recipient ? recipient.name : '';
      const fullHtml =
        bodyHtml + mailer.voteSection(appId, recipientEmail, recipientName);

      // One bad address must not stop the rest of the board being notified.
      try {
        const info = await transporter.sendMail(mailer.message({
          to: recipientEmail,
          subject,
          html: fullHtml,
          attachments,
        }));
        results.push({ email: recipientEmail, messageId: info.messageId });
      } catch (sendErr) {
        console.error(`Email to ${recipientEmail} failed:`, sendErr);
        failures.push({ email: recipientEmail, error: sendErr.message });
      }
    });

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
