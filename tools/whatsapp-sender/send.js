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

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

async function queuedGuests() {
  const { guests } = await api('/api/admin/guests');
  return guests.filter(g => g && g.queued && g.queued.text && g.status !== 'archived');
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

async function sendOne(client, guest) {
  const chatId = chatIdFor(guest);
  if (!chatId) throw new Error('no usable number');

  // Never message a number that is not actually on WhatsApp - that is one of
  // the strongest signals of automated bulk sending.
  const registered = await client.isRegisteredUser(chatId);
  if (!registered) throw new Error('not a WhatsApp number');

  const media = await fetchMedia(guest.queued.imageUrl);
  if (media) {
    await client.sendMessage(chatId, media, { caption: guest.queued.text });
  } else {
    await client.sendMessage(chatId, guest.queued.text);
  }
}

async function drain(client) {
  const queue = await queuedGuests();
  if (!queue.length) return 0;

  log(`${queue.length} queued`);
  let sent = 0;
  for (const guest of queue.slice(0, MAX_PER_RUN)) {
    const who = guest.name || guest.waNumber;
    if (DRY) {
      log(`WOULD SEND to ${who}${guest.queued.imageUrl ? ' [with image]' : ''}`);
      log('   ' + guest.queued.text.replace(/\n/g, '\n   '));
      continue;
    }
    try {
      await sendOne(client, guest);
      await api('/api/admin/guests', 'PATCH', { id: guest.id, queued: null, invited: 'whatsapp' });
      sent++;
      log(`sent to ${who}  (${sent}/${Math.min(queue.length, MAX_PER_RUN)})`);
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
