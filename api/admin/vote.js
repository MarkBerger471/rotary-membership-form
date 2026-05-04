const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { id, email, action, name: voterNameParam } = req.query;

  if (!id || !email) {
    return res.status(400).send(renderPage('Missing Parameters', 'Invalid vote link. Please use the link from your email.', 'error'));
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

    if (action === 'approve') {
      return res.send(renderVotePage(id, email, applicantName, 'approve', voterNameParam));
    } else if (action === 'reject') {
      return res.send(renderVotePage(id, email, applicantName, 'reject', voterNameParam));
    } else {
      return res.send(renderVotePage(id, email, applicantName, 'choose', voterNameParam));
    }
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

    try {
      const votes = (await kv.get(`votes:${id}`)) || {};
      votes[email] = {
        vote,
        comment: comment.trim(),
        voterName,
        date: new Date().toISOString(),
      };
      await kv.set(`votes:${id}`, votes);

      return res.json({ success: true, vote });
    } catch (err) {
      console.error('Vote error:', err);
      return res.status(500).json({ error: 'Failed to record vote.' });
    }
  }

  res.status(405).send('Method not allowed');
};

function renderVotePage(id, email, applicantName, mode, voterName) {
  const approveActive = mode === 'approve' ? 'true' : 'false';
  const rejectActive = mode === 'reject' ? 'true' : 'false';

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
        const res = await fetch(window.location.pathname + '?id=' + encodeURIComponent(appId) + '&email=' + encodeURIComponent(voterEmail), {
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
