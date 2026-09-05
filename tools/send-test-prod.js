/**
 * Send a test application to the production API
 */
const https = require('https');

const pdfContent = `%PDF-1.4
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
<< /Length 250 >>
stream
BT
/F1 24 Tf
50 780 Td
(Rotary Club Bangkok DACH) Tj
0 -40 Td
/F1 16 Tf
(TEST Membership Application) Tj
0 -30 Td
/F1 12 Tf
(Applicant: Max Mustermann) Tj
0 -20 Td
(Date: 28 Mar 2026) Tj
0 -20 Td
(This is a TEST application for Admin Panel testing) Tj
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
0000000568 00000 n
trailer
<< /Size 6 /Root 1 0 R >>
startxref
643
%%EOF`;

const pdfBuffer = Buffer.from(pdfContent);
const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);

let body = '';
const fields = {
  applicantName: 'Max Mustermann'
};

for (const [key, value] of Object.entries(fields)) {
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="' + key + '"\r\n\r\n';
  body += value + '\r\n';
}

body += '--' + boundary + '\r\n';
body += 'Content-Disposition: form-data; name="pdf"; filename="application-max-mustermann.pdf"\r\n';
body += 'Content-Type: application/pdf\r\n\r\n';

const bodyStart = Buffer.from(body);
const bodyEnd = Buffer.from('\r\n--' + boundary + '--\r\n');
const fullBody = Buffer.concat([bodyStart, pdfBuffer, bodyEnd]);

console.log('Sending test application to production...');
console.log('PDF size:', (pdfBuffer.length / 1024).toFixed(1), 'KB');

const req = https.request({
  hostname: 'rotary-bkkdach.vercel.app',
  path: '/api/send-application',
  method: 'POST',
  headers: {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': fullBody.length
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('\nStatus:', res.statusCode);
    try {
      const result = JSON.parse(data);
      console.log('Response:', JSON.stringify(result, null, 2));
      if (result.success) {
        console.log('\nTest email sent successfully!');
      } else {
        console.log('\nFailed:', result.error);
      }
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (err) => console.error('Error:', err.message));
req.write(fullBody);
req.end();
