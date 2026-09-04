// Phone push notifications. There is no push provider in the Vercel
// Marketplace (messaging offers email only), so this talks to whichever
// service is configured by environment variable and does nothing if none is.
//
//   ntfy      NTFY_TOPIC            (optional NTFY_SERVER, default https://ntfy.sh)
//   Pushover  PUSHOVER_TOKEN + PUSHOVER_USER
//   Telegram  TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//
// Every failure is swallowed: a notification must never break an application
// submission or a board member's vote.

const TIMEOUT_MS = 5000;

function configured() {
  if (process.env.NTFY_TOPIC) return 'ntfy';
  if (process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER) return 'pushover';
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) return 'telegram';
  return null;
}

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// title: short headline. message: body. url: opened when the push is tapped.
// priority: 'high' for things needing attention now, 'normal' otherwise.
async function push({ title, message, url, priority = 'normal', tags = [] }) {
  const provider = configured();
  if (!provider) {
    console.log(`[notify] no push provider configured; would have sent: ${title} - ${message}`);
    return { sent: false, reason: 'not configured' };
  }

  try {
    if (provider === 'ntfy') {
      const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: title,
        Priority: priority === 'high' ? 'high' : 'default',
      };
      if (tags.length) headers.Tags = tags.join(',');
      if (url) headers.Click = url;
      if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
      const res = await timedFetch(`${server}/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
        method: 'POST', headers, body: message,
      });
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    }

    if (provider === 'pushover') {
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_TOKEN,
        user: process.env.PUSHOVER_USER,
        title,
        message,
        priority: priority === 'high' ? '1' : '0',
      });
      if (url) body.set('url', url);
      const res = await timedFetch('https://api.pushover.net/1/messages.json', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      });
      if (!res.ok) throw new Error(`pushover responded ${res.status}`);
    }

    if (provider === 'telegram') {
      const text = `*${title}*\n${message}` + (url ? `\n${url}` : '');
      const res = await timedFetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
        });
      if (!res.ok) throw new Error(`telegram responded ${res.status}`);
    }

    console.log(`[notify] sent via ${provider}: ${title}`);
    return { sent: true, provider };
  } catch (err) {
    console.error(`[notify] ${provider} push failed:`, err.message);
    return { sent: false, provider, error: err.message };
  }
}

module.exports = { push, configured };
