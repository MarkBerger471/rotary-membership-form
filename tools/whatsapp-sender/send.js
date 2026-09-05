#!/usr/bin/env node
/*
 * Local WhatsApp sender for Rotary Club Bangkok DACH meeting invites.
 *
 * Runs on Mark's Mac and drives his own WhatsApp Web session, so invites go out
 * from his number and every reply lands in his normal WhatsApp. It sends the
 * image as a real attachment with the personal message as the caption - a
 * wa.me link can do neither.
 *
 * Guests are queued from the admin Invite page; this picks them up, sends, and
 * writes the invite back onto the guest record.
 *
 *   ADMIN_PASSWORD=... npm run dry      # show what would be sent, send nothing
 *   ADMIN_PASSWORD=... npm run once     # send whatever is queued, then exit
 *   ADMIN_PASSWORD=... npm start        # stay open and send as things are queued
 *
 * First run prints a QR code. Scan it in WhatsApp > Linked devices, once.
 *
 * NOTE ON RISK: automating WhatsApp is against its terms and bulk sending can
 * get a number banned. Hence the deliberate pacing below - a slow human-like
 * rate, a nightly cap, and a refusal to message anyone twice in one run.
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrimage = require('qrcode');

const BASE = process.env.BASE_URL || 'https://rotary-bkkdach.vercel.app';
const PW = process.env.ADMIN_PASSWORD;
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');

// Pacing. Messages that leave in a burst are what gets a number flagged.
const MIN_GAP_MS = 18000;
const MAX_GAP_MS = 42000;
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 40);
const POLL_MS = 15000;
// A short pause between the images of one message so WhatsApp groups them as a
// set rather than treating each as a separate send.
const IMAGE_GAP_MS = 1500;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A running sender keeps using the code it loaded at startup. On 5 Sep a batch
// went out with the pictures silently dropped because this file had gained
// multi-image support 44 minutes after the process was started, and the old
// code was still looking for a field the page no longer sends. Never send with
// code that is known to be out of date.
const SELF = path.join(__dirname, 'send.js');
const LOADED_MTIME = (() => { try { return fs.statSync(SELF).mtimeMs; } catch { return 0; } })();
const selfChanged = () => {
  try { return fs.statSync(SELF).mtimeMs !== LOADED_MTIME; } catch { return false; }
};

if (!PW) {
  console.error('Set ADMIN_PASSWORD first:\n  ADMIN_PASSWORD=... npm run dry');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
const stamp = () => new Date().toLocaleTimeString('en-GB');
const log = (...a) => console.log(`[${stamp()}]`, ...a);

async function api(pathname, method = 'GET', body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'X-Admin-Password': PW, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
  return res.json();
}

// Only what was queued for WhatsApp. The Invite page can now queue a message
// for LINE instead, and those are for tools/line-sender - picking them up here
// would deliver a LINE invite to a WhatsApp number, which is exactly the kind
// of quiet mis-send this whole tool is built to avoid. Anything queued before
// the channel existed has no channel and is WhatsApp, as it always was.
const isForWhatsApp = (q) => !q.channel || q.channel === 'whatsapp';

async function queuedGuests() {
  const { guests } = await api('/api/admin/guests');
  return guests.filter(g => g && g.queued && g.queued.text && isForWhatsApp(g.queued) && g.status !== 'archived');
}

// The image is fetched from the public endpoint, the same URL a recipient would
// see, so what goes out is exactly what was uploaded.
async function fetchMedia(url) {
  if (!url) return null;
  try {
    const res = await fetch(url.startsWith('http') ? url : BASE + url);
    if (!res.ok) throw new Error('image fetch ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/jpeg';
    return new MessageMedia(mime, buf.toString('base64'), 'invite.jpg');
  } catch (err) {
    log('could not fetch the invite image:', err.message);
    return null;
  }
}

function chatIdFor(guest) {
  const digits = String(guest.waNumber || guest.phone || '').replace(/[^0-9]/g, '');
  return digits ? `${digits}@c.us` : null;
}

// The queue now carries an ordered imageUrls array; older entries may still
// carry a single imageUrl. Read the array, fall back to the old field.
function imageUrlsOf(queued) {
  if (!queued) return [];
  if (Array.isArray(queued.imageUrls)) return queued.imageUrls.filter(Boolean);
  if (queued.imageUrl) return [queued.imageUrl];
  return [];
}

// Returns what actually went out, so the caller can say so out loud instead of
// letting a message that lost its pictures look like a clean send.
async function sendOne(client, guest) {
  const chatId = chatIdFor(guest);
  if (!chatId) throw new Error('no usable number');

  // Never message a number that is not actually on WhatsApp - that is one of
  // the strongest signals of automated bulk sending.
  const registered = await client.isRegisteredUser(chatId);
  if (!registered) throw new Error('not a WhatsApp number');

  const text = guest.queued.text;
  const urls = imageUrlsOf(guest.queued);

  if (!urls.length) {
    await client.sendMessage(chatId, text);
    return { wanted: 0, attached: 0 };
  }

  // whatsapp-web.js has no single album call, so the images go one at a time
  // with a short gap so WhatsApp groups them. The message text rides as the
  // caption on the FIRST image only; the rest go without a caption. A single
  // image that fails to fetch is skipped rather than sinking the whole message.
  let captioned = false, attached = 0;
  for (const url of urls) {
    const media = await fetchMedia(url);
    if (!media) continue;
    if (!captioned) {
      await client.sendMessage(chatId, media, { caption: text });
      captioned = true;
    } else {
      await sleep(IMAGE_GAP_MS);
      await client.sendMessage(chatId, media);
    }
    attached++;
  }
  // If every image failed to fetch, the guest still gets the message text.
  if (!captioned) await client.sendMessage(chatId, text);
  return { wanted: urls.length, attached };
}

async function drain(client) {
  if (selfChanged()) {
    log('send.js has changed on disk since this sender started.');
    log('Stopping rather than sending with the old code - start it again to pick up the change:');
    log('  ADMIN_PASSWORD=... npm start');
    if (client) await client.destroy().catch(() => {});
    process.exit(0);
  }
  const queue = await queuedGuests();
  if (!queue.length) return 0;

  log(`${queue.length} queued`);
  let sent = 0;
  for (const guest of queue.slice(0, MAX_PER_RUN)) {
    const who = guest.name || guest.waNumber;
    if (DRY) {
      const imgs = imageUrlsOf(guest.queued);
      log(`WOULD SEND to ${who}${imgs.length ? ` [${imgs.length} image${imgs.length === 1 ? '' : 's'}]` : ''}`);
      log('   ' + guest.queued.text.replace(/\n/g, '\n   '));
      continue;
    }
    try {
      const { wanted, attached } = await sendOne(client, guest);
      // A message that lost its pictures is not a clean send. Say so here and
      // record it on the guest, so the Invite page shows it too.
      const lost = wanted - attached;
      const note = lost > 0 ? `sent without ${lost} of ${wanted} image${wanted === 1 ? '' : 's'} - could not be fetched` : '';
      await api('/api/admin/guests', 'PATCH', {
        id: guest.id, queued: null, invited: 'whatsapp', ...(note ? { queueError: note } : {}),
      });
      sent++;
      const how = attached ? `with ${attached} image${attached === 1 ? '' : 's'}` : 'text only';
      log(`sent to ${who} (${how})  (${sent}/${Math.min(queue.length, MAX_PER_RUN)})`);
      if (note) log('   WARNING: ' + note);
    } catch (err) {
      // Clear the queue entry so one bad number cannot jam the run forever.
      await api('/api/admin/guests', 'PATCH', { id: guest.id, queued: null, queueError: err.message })
        .catch(() => {});
      log(`FAILED for ${who}: ${err.message}`);
    }
    const gap = jitter();
    log(`   waiting ${Math.round(gap / 1000)}s`);
    await sleep(gap);
  }
  return sent;
}

(async () => {
  if (DRY) {
    // A dry run needs no WhatsApp session at all.
    const n = await drain(null);
    log('dry run complete, nothing sent');
    process.exit(0);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  // The QR also opens as an image. Printing it to a terminal is no use when
  // the sender is started for you, or when the terminal font mangles the
  // blocks - a PNG in Preview always scans.
  const QR_PNG = path.join(__dirname, 'link-whatsapp.png');
  let qrOpened = false;
  client.on('qr', async (qr) => {
    console.log('\nScan this in WhatsApp > Settings > Linked devices > Link a device:\n');
    qrcode.generate(qr, { small: true });
    try {
      await qrimage.toFile(QR_PNG, qr, { width: 520, margin: 2 });
      if (!qrOpened) {
        qrOpened = true;
        require('child_process').spawn('open', [QR_PNG], { stdio: 'ignore', detached: true }).unref();
        console.log(`(also opened as an image: ${QR_PNG})`);
      }
    } catch (err) {
      console.log('could not write the QR image:', err.message);
    }
  });
  client.on('authenticated', () => {
    log('authenticated');
    try { fs.unlinkSync(path.join(__dirname, 'link-whatsapp.png')); } catch {}
  });
  client.on('auth_failure', (m) => { log('auth failed:', m); process.exit(1); });
  client.on('disconnected', (r) => { log('disconnected:', r); process.exit(1); });

  client.on('ready', async () => {
    log('WhatsApp ready');
    const total = await drain(client);
    if (!WATCH) {
      log(`done, ${total} sent`);
      await client.destroy();
      process.exit(0);
    }
    log('watching for newly queued invites - Ctrl+C to stop');
    setInterval(() => drain(client).catch(e => log('poll error:', e.message)), POLL_MS);
  });

  await client.initialize();
})().catch(err => { console.error('sender failed:', err.message); process.exit(1); });
