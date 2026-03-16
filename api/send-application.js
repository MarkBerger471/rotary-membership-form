const busboy = require('busboy');
const nodemailer = require('nodemailer');

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

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER || 'markberger471@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const info = await transporter.sendMail({
      from: `"Rotary Club Bangkok DACH" <${process.env.GMAIL_USER || 'markberger471@gmail.com'}>`,
      to: fields.to,
      subject: fields.subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #17458f; padding: 20px; border-radius: 8px 8px 0 0;">
            <h1 style="color: #fff; margin: 0; font-size: 20px;">New Membership Application</h1>
            <p style="color: #f7a81b; margin: 5px 0 0;">Rotary Club Bangkok DACH</p>
          </div>
          <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e9ecef;">
            <p>Dear Membership Committee,</p>
            <p>A new membership application has been submitted by <strong>${fields.applicantName}</strong>.</p>
            <p>Please find the application summary PDF attached${files.cv ? ', along with the applicant\'s CV' : ''}.</p>
            <p style="margin-top: 20px; color: #666; font-size: 12px;">
              This email was sent automatically from the online membership application form.
            </p>
          </div>
          <div style="background: #f7a81b; padding: 8px; text-align: center; border-radius: 0 0 8px 8px;">
            <span style="color: #17458f; font-size: 11px; font-weight: bold;">Rotary Club Bangkok DACH</span>
          </div>
        </div>`,
      attachments,
    });

    res.json({ success: true, mode: 'gmail', messageId: info.messageId });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
