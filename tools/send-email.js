/**
 * Email Server for Rotary Club Bangkok DACH Application
 *
 * Uses Ethereal Email (free, instant test accounts) by default.
 * Emails are captured and viewable via a URL in the browser.
 * Set GMAIL_APP_PASSWORD to switch to real Gmail delivery.
 *
 * Usage:
 *   node tools/send-email.js
 */

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());

const GMAIL_USER = process.env.GMAIL_USER || 'markberger471@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (GMAIL_APP_PASSWORD) {
    // Real Gmail SMTP
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    console.log('Using Gmail SMTP for real email delivery.');
  } else {
    // Ethereal test account (instant, free, no signup)
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
    console.log('Using Ethereal Email (test mode).');
    console.log('Ethereal account:', testAccount.user);
  }
  return transporter;
}

function buildEmailHTML(applicantName, hasCv) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #17458f; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #fff; margin: 0; font-size: 20px;">New Membership Application</h1>
        <p style="color: #f7a81b; margin: 5px 0 0;">Rotary Club Bangkok DACH</p>
      </div>
      <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e9ecef;">
        <p>Dear Membership Committee,</p>
        <p>A new membership application has been submitted by <strong>${applicantName}</strong>.</p>
        <p>Please find the application summary PDF attached${hasCv ? ', along with the applicant\'s CV' : ''}.</p>
        <p style="margin-top: 20px; color: #666; font-size: 12px;">
          This email was sent automatically from the online membership application form.
        </p>
      </div>
      <div style="background: #f7a81b; padding: 8px; text-align: center; border-radius: 0 0 8px 8px;">
        <span style="color: #17458f; font-size: 11px; font-weight: bold;">Rotary Club Bangkok DACH</span>
      </div>
    </div>`;
}

app.post('/send-application', upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'cv', maxCount: 1 }
]), async (req, res) => {
  try {
    const { to, subject, applicantName } = req.body;
    const pdfFile = req.files['pdf'] ? req.files['pdf'][0] : null;
    const cvFile = req.files['cv'] ? req.files['cv'][0] : null;

    if (!pdfFile) {
      return res.status(400).json({ success: false, error: 'No PDF file provided' });
    }

    console.log('\n========================================');
    console.log('New Application Received!');
    console.log('========================================');
    console.log('Applicant:', applicantName);
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('PDF size:', (pdfFile.size / 1024).toFixed(1), 'KB');
    if (cvFile) console.log('CV size:', (cvFile.size / 1024).toFixed(1), 'KB');

    // Save PDF locally
    const outDir = path.join(__dirname, '..', 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, pdfFile.originalname), pdfFile.buffer);
    if (cvFile) fs.writeFileSync(path.join(outDir, cvFile.originalname), cvFile.buffer);

    // Send email
    const smtp = await getTransporter();
    const attachments = [{
      filename: pdfFile.originalname,
      content: pdfFile.buffer,
      contentType: 'application/pdf',
    }];
    if (cvFile) {
      attachments.push({
        filename: cvFile.originalname,
        content: cvFile.buffer,
        contentType: cvFile.mimetype,
      });
    }

    const info = await smtp.sendMail({
      from: '"Rotary Club Bangkok DACH" <application@rotary-bkkdach.org>',
      to: to,
      subject: subject,
      html: buildEmailHTML(applicantName, !!cvFile),
      attachments,
    });

    console.log('Email sent! Message ID:', info.messageId);

    // Ethereal provides a preview URL
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log('\n>>> VIEW EMAIL HERE: ' + previewUrl + ' <<<\n');
    }

    console.log('PDF saved to:', path.join(outDir, pdfFile.originalname));
    console.log('========================================\n');

    res.json({
      success: true,
      mode: previewUrl ? 'ethereal' : 'gmail',
      messageId: info.messageId,
      previewUrl: previewUrl || null,
    });
  } catch (err) {
    console.error('Error sending email:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve the main site
app.use(express.static(path.join(__dirname, '..')));

const PORT = 3001;

(async () => {
  await getTransporter();
  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`Rotary Application Email Server`);
    console.log(`========================================`);
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Mode: ${GMAIL_APP_PASSWORD ? 'Gmail (live)' : 'Ethereal (test — emails viewable via URL)'}`);
    console.log(`========================================\n`);
  });
})();
