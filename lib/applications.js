const { kv } = require('@vercel/kv');

const LOG_KEY = 'admin:applications';

// How the board poll runs, in days from pollOpenedAt.
const REMINDER_DAYS = [5, 12];
const CLOSE_DAYS = 14;

async function getApplications() {
  try {
    const apps = await kv.get(LOG_KEY);
    if (Array.isArray(apps)) return apps;
  } catch (err) {
    console.error('Error reading applications log:', err);
  }
  return [];
}

async function saveApplications(apps) {
  await kv.set(LOG_KEY, apps);
}

// Read-modify-write a single entry. Returns true if the entry was found.
async function updateApplication(appId, patch) {
  try {
    const apps = await getApplications();
    const entry = apps.find(a => a.id === appId);
    if (!entry) return false;
    Object.assign(entry, typeof patch === 'function' ? patch(entry) : patch);
    await saveApplications(apps);
    return true;
  } catch (err) {
    console.error(`Could not update application ${appId}:`, err);
    return false;
  }
}

async function getVotes(appId) {
  try {
    const votes = await kv.get(`votes:${appId}`);
    if (votes && typeof votes === 'object') return votes;
  } catch (err) {
    console.error(`Error reading votes for ${appId}:`, err);
  }
  return {};
}

async function getFile(appId, type) {
  try {
    return await kv.get(`file:${type}:${appId}`);
  } catch (err) {
    console.error(`Error reading ${type} for ${appId}:`, err);
    return null;
  }
}

// Rebuild the mail attachments for an application from KV.
async function getAttachments(app) {
  const attachments = [];
  if (app.hasPdf) {
    const pdf = await getFile(app.id, 'pdf');
    if (pdf && pdf.content) {
      attachments.push({
        filename: pdf.filename || 'application.pdf',
        content: Buffer.from(pdf.content, 'base64'),
        contentType: pdf.mimeType || 'application/pdf',
      });
    }
  }
  if (app.hasCv) {
    const cv = await getFile(app.id, 'cv');
    if (cv && cv.content) {
      attachments.push({
        filename: cv.filename || 'cv',
        content: Buffer.from(cv.content, 'base64'),
        contentType: cv.mimeType || 'application/octet-stream',
      });
    }
  }
  return attachments;
}

function daysSince(iso, now) {
  const start = new Date(iso).getTime();
  if (!isFinite(start)) return null;
  return ((now || Date.now()) - start) / 86400000;
}

// Split the people who were asked to vote into how they answered.
function tally(app, votes) {
  const asked = Array.isArray(app.emailedTo) ? app.emailedTo : [];
  const approved = [];
  const rejected = [];
  const pending = [];

  asked.forEach(email => {
    const v = votes[email];
    if (v && v.vote === 'approved') approved.push({ email, ...v });
    else if (v && v.vote === 'rejected') rejected.push({ email, ...v });
    else pending.push({ email });
  });

  // Someone may have voted from a link forwarded before a recipient edit;
  // count them rather than silently dropping the vote.
  Object.keys(votes).forEach(email => {
    if (asked.includes(email)) return;
    const v = votes[email];
    if (v && v.vote === 'approved') approved.push({ email, ...v });
    else if (v && v.vote === 'rejected') rejected.push({ email, ...v });
  });

  return { approved, rejected, pending };
}

// A single objection blocks the application, however many approvals it has.
function outcome({ approved, rejected }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (rejected.length > 0) {
    return {
      label: 'Rejected',
      detail:
        `${plural(rejected.length, 'objection')} raised - a single objection blocks the ` +
        `application` +
        (approved.length ? `, despite ${plural(approved.length, 'approval')}.` : '.'),
    };
  }
  if (approved.length > 0) {
    return {
      label: 'Approved',
      detail: `${plural(approved.length, 'approval')} and no objections.`,
    };
  }
  return { label: 'No decision', detail: 'No votes were cast.' };
}

module.exports = {
  LOG_KEY,
  REMINDER_DAYS,
  CLOSE_DAYS,
  getApplications,
  saveApplications,
  updateApplication,
  getVotes,
  getFile,
  getAttachments,
  daysSince,
  tally,
  outcome,
};
