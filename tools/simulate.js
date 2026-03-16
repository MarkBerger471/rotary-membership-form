/**
 * Simulation script: Generates a test application PDF and sends it via the email server.
 *
 * This script creates a mock PDF and sends it to markberger471@gmail.com
 * through the local email server, demonstrating the full flow.
 *
 * Usage:
 *   1. Start the email server: node tools/send-email.js
 *   2. In another terminal: node tools/simulate.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Create a simple test PDF using raw PDF format (no jsPDF needed server-side)
function createTestPDF() {
  // Minimal valid PDF with test content
  const content = `%PDF-1.4
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
<< /Length 200 >>
stream
BT
/F1 24 Tf
50 780 Td
(Rotary Club Bangkok DACH) Tj
0 -40 Td
/F1 16 Tf
(Membership Application) Tj
0 -30 Td
/F1 12 Tf
(Applicant: John Test Doe) Tj
0 -20 Td
(Date: ${new Date().toLocaleDateString()}) Tj
0 -20 Td
(This is a SIMULATION PDF) Tj
ET
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
0000000266 00000 n
0000000518 00000 n

trailer
<< /Size 6 /Root 1 0 R >>
startxref
593
%%EOF`;
  return Buffer.from(content);
}

async function simulate() {
  console.log('========================================');
  console.log('Rotary Application Simulation');
  console.log('========================================\n');

  const pdfBuffer = createTestPDF();
  console.log('Generated test PDF:', (pdfBuffer.length / 1024).toFixed(1), 'KB');

  // Build multipart form data manually
  const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);

  let body = '';
  // Add text fields
  const fields = {
    to: 'markberger471@gmail.com',
    subject: 'New Membership Application: John Doe (SIMULATION)',
    applicantName: 'John Test Doe'
  };

  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  // Add PDF file
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="pdf"; filename="application-john-doe.pdf"\r\n`;
  body += `Content-Type: application/pdf\r\n\r\n`;

  const bodyStart = Buffer.from(body);
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fullBody = Buffer.concat([bodyStart, pdfBuffer, bodyEnd]);

  return new Promise((resolve, reject) => {
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
        try {
          const result = JSON.parse(data);
          console.log('\nServer response:', JSON.stringify(result, null, 2));
          if (result.success) {
            console.log('\n[SUCCESS] Simulation completed!');
            if (result.mode === 'simulation') {
              console.log('PDF was saved to output/ directory.');
              console.log('To send real emails, start the server with:');
              console.log('  GMAIL_APP_PASSWORD=xxxx node tools/send-email.js');
            }
          } else {
            console.log('\n[FAILED]', result.error);
          }
        } catch (e) {
          console.log('Raw response:', data);
        }
        console.log('\n========================================');
        resolve();
      });
    });

    req.on('error', (err) => {
      console.error('\n[ERROR] Could not connect to server at localhost:3001');
      console.error('Make sure the email server is running: node tools/send-email.js');
      reject(err);
    });

    req.write(fullBody);
    req.end();
  });
}

simulate().catch(() => process.exit(1));
