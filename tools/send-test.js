/**
 * Quick test: generates a real branded PDF with jsPDF and sends it via the email server.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// We'll use the jsPDF UMD bundle from node_modules or CDN fallback
let jsPDF;
try {
  // Try to load jspdf if installed
  jsPDF = require('jspdf');
} catch (e) {
  // Not installed, we'll create a richer test PDF manually
}

function createTestPDF() {
  // Create a more complete PDF with proper structure
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // PDF content stream with Rotary-branded layout
  const content = [
    'BT',
    '/F1 22 Tf',
    '0.09 0.27 0.56 rg',  // Rotary blue
    '50 780 Td',
    '(ROTARY CLUB BANGKOK DACH) Tj',
    '/F1 16 Tf',
    '0.97 0.66 0.11 rg',  // Rotary gold
    '0 -30 Td',
    '(Membership Application Summary) Tj',
    '/F1 10 Tf',
    '0.4 0.4 0.4 rg',
    '0 -25 Td',
    '(Submitted: ' + date + ') Tj',
    '',
    '/F1 14 Tf',
    '0.09 0.27 0.56 rg',
    '0 -40 Td',
    '(PERSONAL INFORMATION) Tj',
    '/F1 11 Tf',
    '0.2 0.2 0.2 rg',
    '0 -22 Td',
    '(Full Name: Mr. Mark Berger) Tj',
    '0 -18 Td',
    '(Date of Birth: 1985-04-15) Tj',
    '0 -18 Td',
    '(Gender: Male) Tj',
    '0 -18 Td',
    '(Proposed By: Dr. Hans Mueller) Tj',
    '0 -18 Td',
    '(Rotarian Status: Not a Rotarian) Tj',
    '',
    '/F1 14 Tf',
    '0.09 0.27 0.56 rg',
    '0 -30 Td',
    '(PROFESSIONAL DETAILS) Tj',
    '/F1 11 Tf',
    '0.2 0.2 0.2 rg',
    '0 -22 Td',
    '(Job Title: Managing Director) Tj',
    '0 -18 Td',
    '(Organization: DACH Enterprises Co., Ltd.) Tj',
    '0 -18 Td',
    '(Since: 2018-01-15) Tj',
    '',
    '/F1 14 Tf',
    '0.09 0.27 0.56 rg',
    '0 -30 Td',
    '(CONTACT INFORMATION) Tj',
    '/F1 11 Tf',
    '0.2 0.2 0.2 rg',
    '0 -22 Td',
    '(Email: markberger471@gmail.com) Tj',
    '0 -18 Td',
    '(Phone: +66 81 234 5678) Tj',
    '0 -18 Td',
    '(LINE ID: markb_bkk) Tj',
    '0 -18 Td',
    '(WhatsApp: +66 81 234 5678) Tj',
    '0 -18 Td',
    '(Address: 123 Sukhumvit Rd, Bangkok 10110) Tj',
    '',
    '/F1 14 Tf',
    '0.09 0.27 0.56 rg',
    '0 -30 Td',
    '(MEMBERSHIP) Tj',
    '/F1 11 Tf',
    '0.2 0.2 0.2 rg',
    '0 -22 Td',
    '(Type: Individual) Tj',
    '0 -18 Td',
    '(Magazine: The Rotarian \\(digital\\)) Tj',
    '0 -18 Td',
    '(Rating: 5/5 stars) Tj',
    'ET'
  ].join('\n');

  const streamLen = Buffer.byteLength(content);

  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj

2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj

3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj

4 0 obj
<< /Length ${streamLen} >>
stream
${content}
endstream
endobj

5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj

xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000267 00000 n
${String(296 + streamLen).padStart(10, '0')} 00000 n

trailer
<< /Size 6 /Root 1 0 R >>
startxref
${361 + streamLen}
%%EOF`;

  return Buffer.from(pdf);
}

async function sendTest() {
  console.log('Creating test application PDF...');
  const pdfBuffer = createTestPDF();
  console.log('PDF size:', (pdfBuffer.length / 1024).toFixed(1), 'KB');

  // Save locally too
  const outPath = path.join(__dirname, '..', 'output', 'test-application-mark-berger.pdf');
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, pdfBuffer);
  console.log('PDF saved to:', outPath);

  // Send via multipart
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];

  function addField(name, value) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
  }

  addField('to', 'markberger471@gmail.com');
  addField('subject', 'New Membership Application: Mark Berger');
  addField('applicantName', 'Mark Berger');

  // PDF attachment
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="application-mark-berger.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
  );

  const before = Buffer.from(parts.join('\r\n') + '\r\n');
  // We need to handle binary PDF data carefully
  const after = Buffer.from(`\r\n--${boundary}--\r\n`);

  // Rebuild with proper binary handling
  const textParts = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="to"\r\n`,
      `markberger471@gmail.com`,
      `\r\n--${boundary}`,
      `Content-Disposition: form-data; name="subject"\r\n`,
      `New Membership Application: Mark Berger`,
      `\r\n--${boundary}`,
      `Content-Disposition: form-data; name="applicantName"\r\n`,
      `Mark Berger`,
      `\r\n--${boundary}`,
      `Content-Disposition: form-data; name="pdf"; filename="application-mark-berger.pdf"`,
      `Content-Type: application/pdf\r\n`,
      ``
    ].join('\r\n')
  );

  const fullBody = Buffer.concat([textParts, pdfBuffer, after]);

  console.log('\nSending to email server...');

  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/send-application',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        console.log('\nResult:', JSON.stringify(result, null, 2));
        if (result.previewUrl) {
          console.log('\n===========================================');
          console.log('VIEW THE EMAIL HERE:');
          console.log(result.previewUrl);
          console.log('===========================================\n');
        }
        resolve(result);
      });
    });

    req.on('error', (err) => {
      console.error('Connection failed. Is the server running? (node tools/send-email.js)');
      resolve(null);
    });

    req.write(fullBody);
    req.end();
  });
}

sendTest();
