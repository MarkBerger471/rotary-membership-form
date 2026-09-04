const nodemailer = require('nodemailer');

const BRAND = { blue: '#17458f', gold: '#f7a81b' };

function fromAddress() {
  return `"Rotary Club Bangkok DACH" <${process.env.GMAIL_USER || 'markberger471@gmail.com'}>`;
}

function siteUrl() {
  return (
    process.env.SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL
      : '') ||
    'https://rotary-bkkdach.vercel.app'
  );
}

function replyToAddress() {
  return process.env.REPLY_TO || 'office@rotary-club-bangkok-dach.org';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '\u00b7' };

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] || m);
}

// A plain-text alternative for every message. HTML-only mail is one of the
// strongest spam signals at consumer providers, which is where most of the
// board reads its email. Links are spelled out so the vote URLs survive.
function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
               (_, href, label) => `${label.replace(/<[^>]+>/g, '').trim()}: ${href}`)
      .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '  - ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Single place every message is built, so no send path can forget the
// plain-text part or the reply address.
function message({ to, subject, html, attachments, textTail }) {
  const text = [htmlToText(html), textTail && String(textTail).trim()]
    .filter(Boolean).join('\n\n');
  return {
    from: fromAddress(),
    replyTo: replyToAddress(),
    to,
    subject,
    html,
    text,
    ...(attachments && attachments.length ? { attachments } : {}),
  };
}

function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER || 'markberger471@gmail.com',
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The club shell used by the reminder and result emails, matching the look of
// the default new-application template.
function wrap(title, innerHtml) {
  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: ${BRAND.blue}; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: #fff; margin: 0; font-size: 20px;">${escapeHtml(title)}</h1>
    <p style="color: ${BRAND.gold}; margin: 5px 0 0;">Rotary Club Bangkok DACH</p>
  </div>
  <div style="background: #f8f9fa; padding: 20px; border: 1px solid #e9ecef;">
${innerHtml}
  </div>
  <div style="background: ${BRAND.gold}; padding: 8px; text-align: center; border-radius: 0 0 8px 8px;">
    <span style="color: ${BRAND.blue}; font-size: 11px; font-weight: bold;">Rotary Club Bangkok DACH</span>
  </div>
</div>`;
}

function voteUrl(appId, email, name, action) {
  return `${siteUrl()}/api/admin/vote?id=${encodeURIComponent(appId)}&email=${encodeURIComponent(
    email
  )}&name=${encodeURIComponent(name || '')}&action=${action}`;
}

// The Approve / Reject block appended to new-application and reminder emails.
function voteSection(appId, email, name, heading) {
  const approveUrl = voteUrl(appId, email, name, 'approve');
  const rejectUrl = voteUrl(appId, email, name, 'reject');
  return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 24px auto 0;">
          <div style="background: #f0f4f8; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; text-align: center;">
            <p style="margin: 0 0 6px; font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">${escapeHtml(
              heading || 'Board Member Action Required'
            )}</p>
            <p style="margin: 0 0 20px; font-size: 14px; color: #475569;">Please review the attached application and cast your vote.</p>
            <div style="display: inline-block;">
              <a href="${approveUrl}" style="display: inline-block; background: #16a34a; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; margin-right: 12px;">&#10003; Approve</a>
              <a href="${rejectUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px;">&#10007; Reject</a>
            </div>
            <p style="margin: 16px 0 0; font-size: 11px; color: #94a3b8;">This link is unique to you. Do not forward this email.</p>
          </div>
        </div>`;
}

function reminderBody(applicantName, daysLeft, closeDays) {
  return `    <p>Dear Board Member,</p>
    <p>The membership application from <strong>${escapeHtml(
      applicantName
    )}</strong> is still awaiting your vote.</p>
    <p>The poll closes <strong>${
      daysLeft <= 1 ? 'tomorrow' : `in ${Math.round(daysLeft)} days`
    }</strong>, ${closeDays} days after the application was submitted. The application summary${''} is attached again for convenience.</p>
    <p style="margin-top: 20px; color: #666; font-size: 12px;">
      If you have already voted, please ignore this reminder.
    </p>`;
}

function voterLine(v, colour) {
  const who = escapeHtml(v.voterName || v.email);
  const comment = v.comment
    ? `<div style="margin: 2px 0 0 14px; color: #666; font-style: italic;">"${escapeHtml(
        v.comment
      )}"</div>`
    : '';
  return `<li style="margin-bottom: 6px;"><span style="color: ${colour}; font-weight: 600;">${who}</span>${comment}</li>`;
}

function resultBody(applicantName, result, { approved, rejected, pending }, closeDays) {
  const colour =
    result.label === 'Approved' ? '#16a34a' : result.label === 'Rejected' ? '#dc2626' : '#64748b';

  const section = (title, items, render) =>
    items.length
      ? `<p style="margin: 18px 0 6px; font-weight: 700; color: #334155;">${title} (${items.length})</p>
    <ul style="margin: 0; padding-left: 20px; color: #334155; font-size: 14px;">${items
      .map(render)
      .join('')}</ul>`
      : '';

  return `    <p>Dear Board Member,</p>
    <p>The ${closeDays}-day voting period for the membership application from
      <strong>${escapeHtml(applicantName)}</strong> has closed.</p>

    <div style="background: #fff; border: 2px solid ${colour}; border-radius: 12px; padding: 18px; text-align: center; margin: 20px 0;">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; font-weight: 600;">Result</div>
      <div style="font-size: 26px; font-weight: 800; color: ${colour}; margin-top: 4px;">${escapeHtml(
    result.label
  )}</div>
      <div style="font-size: 13px; color: #475569; margin-top: 6px;">${escapeHtml(
        result.detail
      )}</div>
    </div>

    <p style="margin: 0; font-size: 14px; color: #334155;">
      <strong>${approved.length}</strong> approved &middot;
      <strong>${rejected.length}</strong> rejected &middot;
      <strong>${pending.length}</strong> did not vote
    </p>

${section('Approved', approved, v => voterLine(v, '#16a34a'))}
${section('Rejected', rejected, v => voterLine(v, '#dc2626'))}
${section(
  'No response',
  pending,
  v => `<li style="margin-bottom: 4px; color: #94a3b8;">${escapeHtml(v.email)}</li>`
)}

    <p style="margin-top: 20px; color: #666; font-size: 12px;">
      Voting links for this application are now closed. This tally is advisory - the
      final membership decision rests with the board.
    </p>`;
}

// Run an async op over a list with a concurrency cap. Sending one large
// attachment at a time took ~8s per recipient, which blew the function's
// time limit at only four board members.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  mapLimit,
  fromAddress,
  replyToAddress,
  htmlToText,
  message,
  siteUrl,
  createTransporter,
  escapeHtml,
  wrap,
  voteUrl,
  voteSection,
  reminderBody,
  resultBody,
};
