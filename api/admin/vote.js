const { kv } = require('@vercel/kv');
const apps = require('../../lib/applications');
const settingsLib = require('../../lib/settings');
const mailer = require('../../lib/mailer');
const outbox = require('../../lib/outbox');
const notify = require('../../lib/notify');

// Which channel a vote arrived on, for the log. Anything else is nobody.
const VIA = ['email', 'whatsapp', 'line'];
const asVia = (v) => (VIA.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id, email, action, name: voterNameParam } = req.query;
  const via = asVia(req.query.via);

  if (!id || !email) {
    return res.status(400).send(renderPage('Missing Parameters', 'That vote link is incomplete. Please use the link you were sent.', 'error'));
  }

  // The application itself, for a board member who was asked on WhatsApp or
  // LINE and so has no attachment to open. It is the same capability as the
  // vote link beside it - whoever holds that link can cast this person's vote,
  // so letting them read what they are voting on gives away nothing new.
  if (req.method === 'GET' && req.query.file) {
    const type = req.query.file === 'cv' ? 'cv' : 'pdf';
    const list = await apps.getApplications();
    const app = list.find(a => a.id === id);
    if (!app) {
      return res.status(404).send(renderPage('Not Found', 'That application is not on the log.', 'error'));
    }

    const norm = (e) => (e || '').trim().toLowerCase();
    const settings = await settingsLib.getSettings();
    const allowed =
      apps.askedList(app).some(e => norm(e) === norm(email)) ||
      !!settingsLib.recipientByEmail(settings, email);
    if (!allowed) {
      return res.status(403).send(renderPage(
        'Not Yours to Open',
        '<p>This application was not sent to that address.</p>',
        'error'
      ));
    }

    const file = await apps.getFile(id, type);
    if (!file || !file.content) {
      return res.status(404).send(renderPage(
        'Nothing Attached',
        `<p>No ${type === 'cv' ? 'CV' : 'application PDF'} was stored with this application.</p>`,
        'error'
      ));
    }
    const filename = String(file.filename || (type === 'cv' ? 'cv' : 'application.pdf'))
      .replace(/[^\w. \-()]/g, '_');
    res.setHeader('Content-Type', file.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.end(Buffer.from(file.content, 'base64'));
  }

  // GET: Show vote page
  if (req.method === 'GET') {
    // Check if already voted
    const votes = (await kv.get(`votes:${id}`)) || {};
    if (votes[email]) {
      const prev = votes[email];
      const label = prev.vote === 'approved' ? 'Approved' : 'Rejected';
      return res.send(renderPage(
        'Already Voted',
        `<p>You have already <strong>${label.toLowerCase()}</strong> this application on ${new Date(prev.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}.</p>
        ${prev.comment ? `<p style="margin-top:12px;color:#666;"><em>Your comment: "${prev.comment}"</em></p>` : ''}
        <p style="margin-top:16px;color:#888;font-size:13px;">If you need to change your vote, please contact the admin.</p>`,
        prev.vote === 'approved' ? 'success' : 'rejected'
      ));
    }

    // Look up applicant name
    const apps = (await kv.get('admin:applications')) || [];
    const app = apps.find(a => a.id === id);
    const applicantName = app ? app.name : 'Unknown Applicant';

    if (app && (app.pollStatus === 'closed' || app.archived)) {
      const closedOn = app.pollClosedAt
        ? new Date(app.pollClosedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : null;
      return res.send(renderPage(
        'Voting Closed',
        `<p>The voting period for <strong>${escapeHtml(applicantName)}</strong> has closed${closedOn ? ' on ' + closedOn : ''}.</p>
        ${app.pollResult ? `<p style="margin-top:12px;">Recorded result: <strong>${escapeHtml(app.pollResult)}</strong>.</p>` : ''}
        <p style="margin-top:16px;color:#888;font-size:13px;">If you still need to register an opinion, please contact the admin.</p>`,
        'error'
      ));
    }

    const mode = action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'choose';
    return res.send(renderVotePage(id, email, applicantName, mode, voterNameParam, {
      via,
      hasPdf: !!(app && app.hasPdf),
      hasCv: !!(app && app.hasCv),
    }));
  }

  // POST: Record vote
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const vote = body.vote; // 'approved' or 'rejected'
    const comment = body.comment || '';
    const voterName = body.voterName || email;

    if (!vote || !['approved', 'rejected'].includes(vote)) {
      return res.status(400).send(renderPage('Error', 'Invalid vote.', 'error'));
    }

    if (vote === 'rejected' && !comment.trim()) {
      return res.status(400).json({ error: 'A comment is required when rejecting an application.' });
    }

    const applications = (await kv.get('admin:applications')) || [];
    const application = applications.find(a => a.id === id);
    if (application && (application.pollStatus === 'closed' || application.archived)) {
      return res.status(403).json({ error: 'Voting for this application has closed.' });
    }

    try {
      const votes = (await kv.get(`votes:${id}`)) || {};
      votes[email] = {
        vote,
        comment: comment.trim(),
        voterName,
        date: new Date().toISOString(),
        // How they answered - which is now worth recording, because the same
        // question goes out by email, on WhatsApp and on LINE.
        ...(via ? { via } : {}),
      };
      await kv.set(`votes:${id}`, votes);

      // Act on the vote immediately rather than leaving the outcome to sit
      // until the 14-day sweep. Never let this break recording the vote.
      let closedEarly = false;
      try {
        closedEarly = await reactToVote(application, votes, { vote, voterName, comment });
      } catch (err) {
        console.error(`Post-vote handling failed for ${id}:`, err);
      }

      return res.json({ success: true, vote, closedEarly });
    } catch (err) {
      console.error('Vote error:', err);
      return res.status(500).json({ error: 'Failed to record vote.' });
    }
  }

  res.status(405).send('Method not allowed');
};

// A rejection is decisive under the board's rule, and a final approval ends
// the poll there and then - both are worth knowing about the moment they
// happen, not a fortnight later.
async function reactToVote(application, votes, cast) {
  if (!application) return false;
  const name = application.name || 'the applicant';
  const siteUrl = mailer.siteUrl();
  const adminUrl = `${siteUrl}/admin/membership`;

  if (cast.vote === 'rejected') {
    await notify.push({
      title: `${cast.voterName} declined ${name}`,
      message: `${cast.voterName} voted to reject the application from ${name}.`
        + (cast.comment ? `\n\nReason: ${cast.comment}` : '')
        + '\n\nOne objection blocks the application.',
      url: adminUrl,
      priority: 'high',
      tags: ['x'],
    });
    return false;
  }

  // Approval: has everyone who was asked now approved?
  const asked = apps.askedList(application);
  if (!asked.length) return false;
  const allApproved = asked.every(e => votes[e] && votes[e].vote === 'approved');
  if (!allApproved) {
    await notify.push({
      title: `${cast.voterName} approved ${name}`,
      message: `${asked.filter(e => votes[e]).length} of ${asked.length} board members have now voted.`,
      url: adminUrl,
      tags: ['white_check_mark'],
    });
    return false;
  }

  // Unanimous - close the poll now and send the result, exactly as the
  // day-14 sweep would have done.
  const tally = apps.tally(application, votes);
  const result = apps.outcome(tally);
  const settings = await settingsLib.getSettings();
  const ticked = settingsLib.activeRecipients(settings);

  await apps.updateApplication(application.id, {
    pollStatus: 'closed',
    pollClosedAt: new Date().toISOString(),
    pollResult: result.label,
    pollClosedEarly: true,
    pollTally: {
      approved: tally.approved.length,
      rejected: tally.rejected.length,
      noResponse: tally.pending.length,
    },
  });

  const html = mailer.wrap(`Application Result: ${name}`,
    mailer.resultBody(name, result, tally, apps.CLOSE_DAYS));
  const subject = `Result: Membership Application - ${name} - ${result.label}`;
  const transporter = mailer.createTransporter();
  await mailer.mapLimit(ticked, 4, async (to) => {
    try {
      await transporter.sendMail(mailer.message({ to, subject, html }));
    } catch (err) {
      console.error(`Early result email to ${to} failed:`, err);
    }
  });

  // The board members who are on WhatsApp or LINE were asked there, so that is
  // where they hear how it ended.
  const told = await outbox.askBoard(settings, application, { kind: 'result', result, tally });

  await notify.push({
    title: `${name} approved unanimously`,
    message: `All ${asked.length} board members approved. The poll is closed and the result has gone out`
      + (told.entries.length ? ` by email, and is queued for ${told.entries.length} on WhatsApp or LINE.` : ' by email.'),
    url: adminUrl,
    priority: 'high',
    tags: ['tada'],
  });
  return true;
}

function renderVotePage(id, email, applicantName, mode, voterName, opts = {}) {
  const approveActive = mode === 'approve' ? 'true' : 'false';
  const rejectActive = mode === 'reject' ? 'true' : 'false';

  // Whoever arrived here from WhatsApp or LINE has no attachment to open, so
  // the application is offered on the page itself. It is shown to everyone:
  // reading it again before voting is never the wrong thing to do.
  const fileLink = (type, label) =>
    `<a href="?id=${encodeURIComponent(id)}&email=${encodeURIComponent(email)}&file=${type}"
        target="_blank" rel="noopener"
        style="display:inline-flex;align-items:center;gap:6px;color:#f7a81b;text-decoration:none;font-size:13px;font-weight:600;">
      <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
      ${label}</a>`;
  const files = [
    opts.hasPdf ? fileLink('pdf', 'Read the application') : '',
    opts.hasCv ? fileLink('cv', 'CV') : '',
  ].filter(Boolean);
  const filesHtml = files.length
    ? `<div style="display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin:-14px 0 24px;">${files.join('')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vote on Application | Rotary Club Bangkok DACH</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: linear-gradient(135deg, #0a1628 0%, #0d2137 20%, #112d4e 40%, #17458f 60%, #0067c8 80%, #00a2e0 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 24px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      color: #fff;
    }
    .header { text-align: center; margin-bottom: 32px; }
    .logo-bar {
      background: #17458f;
      padding: 12px 20px;
      border-radius: 12px;
      margin-bottom: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .logo-bar span { color: #f7a81b; font-weight: 600; font-size: 14px; }
    .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    .header p { color: rgba(255,255,255,0.6); font-size: 14px; }
    .applicant-name {
      background: rgba(247,168,27,0.15);
      border: 1px solid rgba(247,168,27,0.3);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      margin-bottom: 28px;
    }
    .applicant-name .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.5); margin-bottom: 4px; }
    .applicant-name .name { font-size: 20px; font-weight: 700; color: #f7a81b; }
    .vote-buttons { display: flex; gap: 12px; margin-bottom: 8px; }
    .vote-btn {
      flex: 1;
      padding: 14px 20px;
      border-radius: 14px;
      border: 2px solid transparent;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-family: inherit;
    }
    .btn-approve {
      background: rgba(34,197,94,0.2);
      border-color: rgba(34,197,94,0.4);
      color: #4ade80;
    }
    .btn-approve:hover, .btn-approve.active {
      background: rgba(34,197,94,0.4);
      border-color: #4ade80;
      box-shadow: 0 0 20px rgba(34,197,94,0.2);
    }
    .btn-reject {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.4);
      color: #f87171;
    }
    .btn-reject:hover, .btn-reject.active {
      background: rgba(239,68,68,0.4);
      border-color: #f87171;
      box-shadow: 0 0 20px rgba(239,68,68,0.2);
    }
    .reject-form { display: none; margin-top: 20px; }
    .reject-form.show { display: block; animation: slideDown 0.3s ease; }
    .reject-form label { display: block; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 8px; }
    .reject-form textarea {
      width: 100%;
      min-height: 100px;
      background: rgba(255,255,255,0.08);
      border: 1.5px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      padding: 14px;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      outline: none;
      transition: border-color 0.3s;
    }
    .reject-form textarea:focus {
      border-color: rgba(247,168,27,0.6);
      box-shadow: 0 0 0 3px rgba(247,168,27,0.15);
    }
    .reject-form textarea::placeholder { color: rgba(255,255,255,0.3); }
    .submit-btn {
      margin-top: 16px;
      width: 100%;
      padding: 14px;
      border-radius: 14px;
      border: none;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.3s;
    }
    .submit-approve {
      background: linear-gradient(135deg, #22c55e, #4ade80);
      color: #052e16;
    }
    .submit-reject {
      background: linear-gradient(135deg, #ef4444, #f87171);
      color: #fff;
    }
    .submit-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
    .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .result { display: none; text-align: center; margin-top: 24px; animation: slideDown 0.3s ease; }
    .result.show { display: block; }
    .result-icon { font-size: 48px; margin-bottom: 12px; }
    .result h3 { font-size: 18px; margin-bottom: 8px; }
    .result p { color: rgba(255,255,255,0.6); font-size: 14px; }
    .voter-name { margin-bottom: 20px; }
    .voter-name label { display: block; font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 8px; }
    .voter-name input {
      width: 100%;
      background: rgba(255,255,255,0.08);
      border: 1.5px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      padding: 12px 14px;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.3s;
    }
    .voter-name input:focus {
      border-color: rgba(247,168,27,0.6);
      box-shadow: 0 0 0 3px rgba(247,168,27,0.15);
    }
    .voter-name input::placeholder { color: rgba(255,255,255,0.3); }
    .error-msg { color: #f87171; font-size: 13px; margin-top: 8px; display: none; }
    .error-msg.show { display: block; }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo-bar">
        <span>Rotary Club Bangkok DACH</span>
      </div>
      <h1>Membership Application Review</h1>
      <p>Please review and cast your vote</p>
    </div>

    <div class="applicant-name">
      <div class="label">Applicant</div>
      <div class="name">${escapeHtml(applicantName)}</div>
    </div>

    ${filesHtml}

    <div id="voteSection">
      <div class="voter-name">
        <label>Your Name</label>
        <input type="text" id="voterName" placeholder="Enter your name" value="${escapeHtml(voterName || '')}" />
      </div>

      <div class="vote-buttons">
        <button class="vote-btn btn-approve" id="btnApprove" onclick="selectVote('approve')">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Approve
        </button>
        <button class="vote-btn btn-reject" id="btnReject" onclick="selectVote('reject')">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          Reject
        </button>
      </div>

      <div class="reject-form" id="rejectForm">
        <label>Reason for rejection <span style="color:#f87171">*</span></label>
        <textarea id="rejectComment" placeholder="Please provide your reason for rejecting this application..."></textarea>
        <div class="error-msg" id="commentError">A comment is required when rejecting.</div>
      </div>

      <button class="submit-btn submit-approve" id="submitApprove" style="display:none" onclick="submitVote('approved')">
        Confirm Approval
      </button>
      <button class="submit-btn submit-reject" id="submitReject" style="display:none" onclick="submitVote('rejected')">
        Submit Rejection
      </button>
    </div>

    <div class="result" id="resultSection">
      <div class="result-icon" id="resultIcon"></div>
      <h3 id="resultTitle"></h3>
      <p id="resultText"></p>
    </div>
  </div>

  <script>
    let selectedVote = null;
    const appId = ${JSON.stringify(id)};
    const voterEmail = ${JSON.stringify(email)};
    // Carried through the POST so the log can say a vote came in from WhatsApp
    // or LINE rather than from the email.
    const via = ${JSON.stringify(opts.via || '')};

    // Auto-select if action was specified
    const initApprove = ${approveActive};
    const initReject = ${rejectActive};
    if (initApprove) selectVote('approve');
    if (initReject) selectVote('reject');

    function selectVote(type) {
      selectedVote = type;
      document.getElementById('btnApprove').classList.toggle('active', type === 'approve');
      document.getElementById('btnReject').classList.toggle('active', type === 'reject');
      document.getElementById('rejectForm').classList.toggle('show', type === 'reject');
      document.getElementById('submitApprove').style.display = type === 'approve' ? 'block' : 'none';
      document.getElementById('submitReject').style.display = type === 'reject' ? 'block' : 'none';
      document.getElementById('commentError').classList.remove('show');
    }

    async function submitVote(vote) {
      const voterName = document.getElementById('voterName').value.trim();
      const comment = document.getElementById('rejectComment').value.trim();

      if (vote === 'rejected' && !comment) {
        document.getElementById('commentError').classList.add('show');
        document.getElementById('rejectComment').focus();
        return;
      }

      const submitBtn = vote === 'approved' ? document.getElementById('submitApprove') : document.getElementById('submitReject');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const url = window.location.pathname + '?id=' + encodeURIComponent(appId)
          + '&email=' + encodeURIComponent(voterEmail)
          + (via ? '&via=' + encodeURIComponent(via) : '');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote, comment, voterName: voterName || voterEmail }),
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('voteSection').style.display = 'none';
          const result = document.getElementById('resultSection');
          result.classList.add('show');
          if (vote === 'approved') {
            document.getElementById('resultIcon').textContent = '\\u2705';
            document.getElementById('resultTitle').textContent = 'Application Approved';
            document.getElementById('resultText').textContent = 'Thank you for your vote. The admin has been notified.';
          } else {
            document.getElementById('resultIcon').textContent = '\\u274C';
            document.getElementById('resultTitle').textContent = 'Application Rejected';
            document.getElementById('resultTitle').style.color = '#f87171';
            document.getElementById('resultText').textContent = 'Your rejection and comment have been recorded.';
          }
        } else {
          alert(data.error || 'Failed to submit vote');
          submitBtn.disabled = false;
          submitBtn.textContent = vote === 'approved' ? 'Confirm Approval' : 'Submit Rejection';
        }
      } catch (err) {
        alert('Network error. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = vote === 'approved' ? 'Confirm Approval' : 'Submit Rejection';
      }
    }
  </script>
</body>
</html>`;
}

function renderPage(title, body, type) {
  const iconMap = {
    success: '<svg width="48" height="48" fill="none" stroke="#4ade80" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    rejected: '<svg width="48" height="48" fill="none" stroke="#f87171" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    error: '<svg width="48" height="48" fill="none" stroke="#f7a81b" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>',
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Rotary Club Bangkok DACH</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: linear-gradient(135deg, #0a1628 0%, #17458f 60%, #00a2e0 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(40px);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 24px;
      padding: 40px;
      max-width: 440px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 22px; margin: 16px 0 12px; }
    p { color: rgba(255,255,255,0.7); font-size: 14px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    ${iconMap[type] || ''}
    <h1>${title}</h1>
    <div>${body}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
