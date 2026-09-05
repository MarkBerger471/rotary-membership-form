#!/usr/bin/env node
/*
 * Local LINE sender for Rotary Club Bangkok DACH meeting invites.
 *
 * The twin of tools/whatsapp-sender, for the guests Mark only has on LINE.
 * Same queue, same wordings, same pictures - a different way of delivering.
 *
 *   ADMIN_PASSWORD=... npm run dry      # show what would be sent, send nothing
 *   ADMIN_PASSWORD=... npm run once     # send whatever is queued, then exit
 *   ADMIN_PASSWORD=... npm start        # stay open and send as things are queued
 *
 * HOW IT WORKS, AND WHY IT IS BUILT THIS CAREFULLY
 *
 * LINE has no linked-device protocol for a personal account, so nothing here
 * talks to LINE's servers. It drives the LINE app on Mark's Mac: search for the
 * chat, open it, paste, press Enter. To LINE that is Mark typing, which is why
 * it is safe - but it also means the app cannot tell us anything back. LINE's
 * accessibility tree exposes the search box and nothing else: no chat title, no
 * message box, and rows with no readable text.
 *
 * So the app is read the way a person reads it - off the screen, with OCR - and
 * every step has to prove itself before the next one runs:
 *
 *   - LINE must be the front application, or nothing is clicked at all. A click
 *     sent while another window is in front lands in that window.
 *   - The chat is chosen by matching the guest's LINE name against the "Chats"
 *     section of the search results, and only when exactly one row matches.
 *     That section is longer than the window - LINE hides all but the first
 *     five behind "See more" - so it is expanded and scrolled and read to the
 *     end before anything is decided.
 *   - After the chat opens, its title is read back and must match again. Only
 *     then is anything typed. If it cannot be confirmed, the guest is skipped.
 *   - The message box must be empty. A half-written draft of Mark's is left
 *     alone rather than sent with an invitation glued to the end of it.
 *   - After Enter, the box must be empty again, or the send is reported failed.
 *
 * The check that matters most is the third one. On WhatsApp a number is checked
 * against the account itself; here the only proof of who is on the other side is
 * the name on the screen. A wrong chat means a personal invitation sent to the
 * wrong person, so every one of these checks fails closed.
 *
 * WHAT IT NEEDS
 *
 *   - macOS, LINE installed and logged in, the Mac awake and unlocked.
 *   - Terminal permissions: Accessibility (to activate LINE and read its
 *     window) and Screen Recording (to read the screen). Both are granted to
 *     the terminal app this runs in, in System Settings > Privacy & Security.
 *   - Xcode command line tools, for the two small Swift helpers in mac/.
 *
 * While it runs it owns the keyboard and the mouse. Leave the machine alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.env.BASE_URL || 'https://rotary-bkkdach.vercel.app';
const PW = process.env.ADMIN_PASSWORD;
const DRY = process.argv.includes('--dry-run');
const WATCH = process.argv.includes('--watch');
// --find "Andy" answers "would this name find one chat, and only one?" without
// opening anything or sending anything. Worth running before a batch: a LINE
// name that matches nothing, or matches twice, is the one thing that stops a
// guest being reachable.
const FIND = (() => {
  const i = process.argv.indexOf('--find');
  // Everything after --find is the name, so it works with or without quotes.
  return i === -1 ? null : process.argv.slice(i + 1).join(' ').trim();
})();

// Pacing. There is no ban risk here - this is Mark's own app, typing at human
// speed - but a burst of identical messages still reads as a mail merge to the
// people getting them, and a pause leaves room to hit Ctrl+C.
const MIN_GAP_MS = 8000;
const MAX_GAP_MS = 20000;
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 40);
const POLL_MS = 15000;

// LINE's own English placeholder in an empty message box. It is how the sender
// knows the box is empty, both before typing and after pressing Enter.
const PLACEHOLDER = process.env.LINE_PLACEHOLDER || 'Enter a message';

const KEY = { v: 9, enter: 36 };

const DIR = __dirname;
const BIN = path.join(DIR, 'bin');
const INPUT = path.join(BIN, 'lineinput');
const OCR = path.join(BIN, 'ocr');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sender-'));

// A running sender keeps using the code it loaded at startup, which once sent a
// batch with the pictures silently dropped. Same guard as the WhatsApp sender.
const SELF = path.join(DIR, 'send.js');
const LOADED_MTIME = (() => { try { return fs.statSync(SELF).mtimeMs; } catch { return 0; } })();
const selfChanged = () => {
  try { return fs.statSync(SELF).mtimeMs !== LOADED_MTIME; } catch { return false; }
};

// Two kinds of thing go wrong here, and they need opposite treatment.
//
// Something wrong with the guest - a LINE name that matches no chat, or two,
// or a chat whose title does not confirm - will go wrong in exactly the same
// way next time, so their message is taken off the queue with the reason on
// their record.
//
// Something wrong with the machine - LINE in the background because Mark is
// using his Mac, LINE not running, a screen that cannot be read - says nothing
// at all about the guest. Their message must survive it, and the run stands
// down until the machine is free again.
class EnvironmentError extends Error {}

function failureAction(err) {
  const environment = err instanceof EnvironmentError;
  return { clearQueue: !environment, standDown: environment };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
const stamp = () => new Date().toLocaleTimeString('en-GB');
const log = (...a) => console.log(`[${stamp()}]`, ...a);

// ---------------------------------------------------------------- the website

async function api(pathname, method = 'GET', body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'X-Admin-Password': PW, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
  return res.json();
}

// Only what was queued for LINE, and only for a guest who has a LINE name to
// find the chat by. Anything else belongs to the WhatsApp sender.
const isQueuedForLine = (g) => !!(g && g.queued && g.queued.text
  && g.queued.channel === 'line' && String(g.lineName || '').trim()
  && g.status !== 'archived');

async function queuedGuests() {
  const { guests } = await api('/api/admin/guests');
  return guests.filter(isQueuedForLine);
}

function imageUrlsOf(queued) {
  if (!queued) return [];
  if (Array.isArray(queued.imageUrls)) return queued.imageUrls.filter(Boolean);
  if (queued.imageUrl) return [queued.imageUrl];
  return [];
}

// ------------------------------------------------------------------- the Mac

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
// stdio is spelled out so osascript's own error text does not print itself over
// the top of the plain-English message this catches it with.
const osa = (script) => sh('/usr/bin/osascript', [], { input: script, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const click = (x, y) => sh(INPUT, ['click', String(Math.round(x)), String(Math.round(y))]);
const press = (code, mods) => sh(INPUT, ['key', String(code), ...(mods ? [mods] : [])]);

// The two Swift helpers are built on first use and rebuilt whenever their
// source changes, so there is nothing to install and nothing to keep in step.
function ensureTools() {
  fs.mkdirSync(BIN, { recursive: true });
  for (const [src, out] of [['lineinput.swift', INPUT], ['ocr.swift', OCR]]) {
    const source = path.join(DIR, 'mac', src);
    let built = false;
    try { built = fs.statSync(out).mtimeMs > fs.statSync(source).mtimeMs; } catch {}
    if (built) continue;
    log('building ' + path.basename(out));
    try {
      sh('swiftc', ['-O', '-o', out, source], { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch {
      throw new EnvironmentError('could not build the helpers - install the Xcode command line tools:\n  xcode-select --install');
    }
  }
  if (sh(INPUT, ['trusted']).trim() !== 'trusted') {
    throw new EnvironmentError('this terminal has no Accessibility permission.\n'
      + '  System Settings > Privacy & Security > Accessibility - switch your terminal on, then run this again.');
  }
}

// Bring LINE forward and refuse to do anything unless it really is in front.
// Everything after this posts real clicks and keystrokes at fixed screen
// points; if another window were in front they would land in that window.
async function focusLine() {
  try {
    osa(`tell application "System Events"
  if not (exists process "LINE") then error "no LINE"
  tell process "LINE"
    try
      set value of attribute "AXMinimized" of (first window whose name is "LINE") to false
    end try
  end tell
end tell
tell application "LINE" to activate`);
  } catch {
    throw new EnvironmentError('LINE is not running - open it, log in, and start this again');
  }
  // Activating is not instant, and sometimes it does not take on the first
  // ask - the window comes forward a moment later, or another app is still
  // settling. Asking too early gets the answer from before the switch, and a
  // screenshot taken then still has the old window on top of LINE. So it is
  // asked again, a few times, before giving up.
  //
  // It is asked repeatedly rather than once, because the ordinary way to use
  // this is to press Send in the browser and let the sender pick the message
  // up - which means another app is in front at the very moment it starts.
  let front = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(700);
    front = osa('tell application "System Events" to return name of first process whose frontmost is true');
    if (front === 'LINE') break;
    osa('tell application "LINE" to activate');
    if (attempt === 7) {
      throw new EnvironmentError(`LINE will not come to the front (${front} is there) - nothing sent, and nothing lost`);
    }
  }

  // Closing LINE's window with the red button or Cmd-W leaves the app running
  // with nothing on screen, and it is the state LINE comes back in after a
  // restart. Activating does not bring the window back; reopening does - the
  // same thing as clicking its icon in the Dock.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (hasWindow()) return;
    osa('tell application "LINE" to reopen');
    await sleep(1200);
  }
  if (!hasWindow()) {
    if (looksLoggedOut()) {
      throw new EnvironmentError('LINE is logged out - log in on the LINE app (QR code or password), then start this again');
    }
    throw new EnvironmentError('LINE is running but has no window open - click LINE in the Dock so the chat list is showing');
  }
}

// Any window LINE has, named or not. A logged-out LINE has exactly one, with
// no name at all, and that is how the login screen is told apart from a window
// that has simply been closed.
function anyWindowFrame() {
  try {
    const out = osa(`tell application "System Events" to tell process "LINE"
  set w to window 1
  set p to position of w
  set s to size of w
  return ((item 1 of p) as text) & " " & ((item 2 of p) as text) & " " & ((item 1 of s) as text) & " " & ((item 2 of s) as text)
end tell`);
    const [x, y, w, h] = out.trim().split(/\s+/).map(Number);
    return h ? { x, y, w, h } : null;
  } catch {
    return null;
  }
}

// Quitting LINE logs it out, and it comes back on its login screen: one
// nameless window with an email box and a QR code. Without this the sender
// would only be able to say it could not find a window, which is true and
// useless - there is nothing to do about it but log in.
const LOGGED_OUT = /log ?in|qr code|email address|password/i;

function looksLoggedOut() {
  const frame = anyWindowFrame();
  if (!frame) return false;
  try {
    return read(frame, 'login').some(l => LOGGED_OUT.test(l.text));
  } catch {
    return false;
  }
}

const hasWindow = () => {
  try {
    return osa('tell application "System Events" to tell process "LINE" to return (exists (first window whose name is "LINE"))') === 'true';
  } catch {
    return false;
  }
};

// LINE tells accessibility almost nothing, but it does give the frames of the
// window, the chat list and the chat pane. Those are the anchors everything
// else is measured against, so a moved or resized window changes nothing.
function frames() {
  let out;
  try {
    out = osa(`tell application "System Events"
  tell process "LINE"
    set w to first window whose name is "LINE"
    set p to position of w
    set s to size of w
    set out to "win " & (item 1 of p) & " " & (item 2 of p) & " " & (item 1 of s) & " " & (item 2 of s)
    set sg to splitter group 1 of w
    repeat with e in (UI elements of sg)
      set ep to position of e
      set es to size of e
      set out to out & linefeed & (role of e) & " " & (item 1 of ep) & " " & (item 2 of ep) & " " & (item 1 of es) & " " & (item 2 of es)
    end repeat
    return out
  end tell
end tell`);
  } catch {
    throw new EnvironmentError('LINE\'s window could not be read - make sure its chat list is open, then try again');
  }
  const f = {};
  for (const line of out.split('\n')) {
    const [role, x, y, w, h] = line.trim().split(/\s+/);
    if (!role || !h) continue;
    const box = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    if (role === 'win') f.win = box;
    else if (role === 'AXList') f.list = box;
    else if (role === 'AXTextField') f.search = box;
    else if (role === 'AXSplitGroup') f.pane = box;
  }
  if (!f.win || !f.list || !f.search) {
    throw new EnvironmentError('LINE\'s window is not laid out as expected - open the chat list and try again');
  }
  // With no conversation open - LINE's "Start a new conversation!" screen, and
  // the state it comes back in after a restart - there is no chat pane element
  // at all. That is not a broken window, it is an empty one, and it is where
  // every run starts: the chat is opened by this tool a moment later. So the
  // pane is worked out from what is there, and read again for real once a
  // chat is on screen.
  if (!f.pane) {
    f.pane = {
      x: f.list.x + f.list.w,
      y: f.list.y,
      w: f.win.x + f.win.w - (f.list.x + f.list.w),
      h: f.win.y + f.win.h - f.list.y,
    };
    f.derived = true;
  }
  return f;
}

let shotNo = 0;
// Reads the text off part of the screen, with each line's box turned back into
// screen coordinates so it can be clicked.
function read(rect, label) {
  const file = path.join(TMP, `shot-${++shotNo}-${label || 'x'}.png`);
  sh('/usr/sbin/screencapture', ['-x', `-R${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`, file]);
  const out = sh(OCR, [file]);
  const lines = out.split('\n').filter(Boolean).map((line) => {
    const [x, y, w, h, ...rest] = line.split('\t');
    return {
      text: rest.join('\t').trim(),
      x: rect.x + Number(x) * rect.w,
      y: rect.y + Number(y) * rect.h,
      w: Number(w) * rect.w,
      h: Number(h) * rect.h,
      get cx() { return this.x + this.w / 2; },
      get cy() { return this.y + this.h / 2; },
    };
  });
  return lines;
}

// Without Screen Recording, screencapture quietly returns a picture of the
// desktop with every window missing - no error, just nothing to read. Prove the
// permission once, on LINE's own window, rather than mistaking a blank region
// later on for a permission problem.
function checkScreenReadable(f) {
  if (read(f.win, 'probe').length) return;
  throw new EnvironmentError('LINE\'s window cannot be read off the screen.\n'
    + '  System Settings > Privacy & Security > Screen Recording - switch your terminal on,\n'
    + '  then quit and reopen it (the permission only takes effect on a restart).');
}

// The same screenshot read word by word, each with its own box. Only the chat
// title needs this, and only because of the icon beside it.
function readWords(rect, label) {
  const file = path.join(TMP, `shot-${++shotNo}-${label || 'x'}.png`);
  sh('/usr/sbin/screencapture', ['-x', `-R${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`, file]);
  return sh(OCR, [file, '--words']).split('\n').filter(Boolean).map((row) => {
    const [line, x, y, w, h, ...rest] = row.split('\t');
    return {
      line: Number(line),
      text: rest.join('\t').trim(),
      x: rect.x + Number(x) * rect.w,
      y: rect.y + Number(y) * rect.h,
      w: Number(w) * rect.w,
      h: Number(h) * rect.h,
    };
  });
}

// The clipboard is Mark's, so whatever was on it is put back at the end.
let savedClipboard = null;
const saveClipboard = () => { try { savedClipboard = sh('/usr/bin/pbpaste', []); } catch { savedClipboard = null; } };
const restoreClipboard = () => {
  if (savedClipboard === null) return;
  try { sh('/usr/bin/pbcopy', [], { input: savedClipboard }); } catch {}
};

const copyText = (text) => sh('/usr/bin/pbcopy', [], { input: text });

// An image has to be on the clipboard as an image, not as a file path, or LINE
// pastes the name of the file into the message.
async function copyImage(url) {
  const res = await fetch(url.startsWith('http') ? url : BASE + url);
  if (!res.ok) throw new Error('image fetch ' + res.status);
  const raw = path.join(TMP, 'img-' + Date.now());
  fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  const png = raw + '.png';
  sh('/usr/bin/sips', ['-s', 'format', 'png', raw, '--out', png], { stdio: 'ignore' });
  osa(`set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`);
}

// --------------------------------------------------------------- reading LINE

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const SECTION = /^(chats|messages|friends|groups|official accounts)\b/i;
const SEE_MORE = /^see more/i;

// How far the list is moved between reads, and how many reads one search is
// allowed. Three wheel clicks move about half a screen, so consecutive reads
// overlap and no row can slip through between them.
const SCROLL_STEPS = 3;
const MAX_PASSES = 20;

// LINE draws the chat title between the contact's picture and a small "open in
// a new window" icon. OCR reads both as marks around the name - a bullet in
// front, and behind it whichever letter that icon happens to look like, which
// is not the same letter twice: "Keep Memo L" one run, "Keep Memo E" the next.
//
// Guessing which letters an icon might be read as was never going to hold. What
// does hold is its shape in the line: it is always the last word, and it is
// never part of the name. So the mark in front is dropped, and the title is
// read two ways - with the last word and without it. Either may be the name;
// nothing else is.
//
// This is the check that a longer name cannot slip through. A chat called
// "Andy S" reads as "Andy S" or "Andy S L", and neither of those is "Andy".
function titleReadings(words) {
  const tokens = words.map(w => String(w.text || '').trim()).filter(Boolean);
  while (tokens.length && !/[a-z0-9]/i.test(tokens[0])) tokens.shift();
  if (!tokens.length) return [];
  return [tokens.join(' '), tokens.slice(0, -1).join(' ')].filter(Boolean);
}

function titleConfirms(name, readings) {
  const n = norm(name);
  if (!n) return false;
  const list = Array.isArray(readings) ? readings : [readings];
  return list.some(r => norm(r) === n);
}

function setSearch(text) {
  const value = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  osa(`tell application "System Events"
  tell process "LINE"
    set value of (text field 1 of splitter group 1 of (first window whose name is "LINE")) to "${value}"
  end tell
end tell`);
}

// Search results come in sections - "Chats 29", then "Messages 37" - and only
// the rows under "Chats" are chats. Reading one screen is not the whole answer:
// LINE shows the first five matches and hides the rest behind "See more", and
// even expanded the list is longer than the window. So a screen is read, the
// section is worked out from what is on it, and the list is moved on.
//
// The header scrolls away as the list moves, so once it has been seen the rows
// at the top of a later screen are still chats until the next section starts.
function chatSection(lines, headerSeen = false) {
  const header = lines.findIndex(l => /^chats\b/i.test(l.text));
  const count = header === -1 ? null : String(lines[header].text).match(/(\d+)/);
  const from = header === -1 ? (headerSeen ? 0 : -1) : header + 1;
  if (from === -1) {
    return { rows: [], total: null, headerSeen: false, endSeen: false, seeMore: null };
  }
  const after = lines.slice(from);
  const end = after.findIndex(l => SECTION.test(l.text));
  const within = end === -1 ? after : after.slice(0, end);
  return {
    rows: within.filter(l => !SEE_MORE.test(l.text)),
    total: count ? Number(count[1]) : null,
    headerSeen: headerSeen || header !== -1,
    endSeen: end !== -1,
    seeMore: within.find(l => SEE_MORE.test(l.text)) || null,
  };
}

// Rows whose name is exactly the one we are looking for. A group reads as
// "RCBD Members (41)" and so never matches a person's name.
//
// Two chats can carry the same name; what tells them apart on screen is the
// line or two underneath - the last message and when it was sent. Using that
// as the row's identity is what makes it possible to read the same row twice
// while scrolling without counting it as a second chat by that name.
function matchesIn(section, name) {
  const out = [];
  section.rows.forEach((line, i) => {
    if (norm(line.text) !== norm(name)) return;
    const identity = [line.text, section.rows[i + 1], section.rows[i + 2]]
      .map(l => (typeof l === 'string' ? l : l && l.text)).filter(Boolean).join(' | ');
    out.push({ line, identity });
  });
  return out;
}

function pickChatRow(lines, name) {
  const section = chatSection(lines);
  if (!section.headerSeen) return { row: null, why: 'no chat by that name' };
  const hits = matchesIn(section, name);
  if (hits.length > 1) return { row: null, why: `more than one chat is called "${name}"` };
  if (!hits.length) return { row: null, why: 'no chat by that name' };
  return { row: hits[0].line, why: '' };
}

const listLines = (f) => read(f.list, 'list').filter(l => l.x < f.list.x + f.list.w * 0.9);
const scrollList = (f, steps) => {
  const x = f.list.x + f.list.w / 2, y = f.list.y + f.list.h / 2;
  for (let i = 0; i < Math.abs(steps); i++) {
    sh(INPUT, ['scroll', String(Math.round(x)), String(Math.round(y)), steps > 0 ? '-5' : '5']);
  }
};

// Read the whole "Chats" section, expanding and scrolling as needed, and
// collect every row that is exactly this name. Stops at the next section, or
// when the list stops moving, or when it has read enough screens that
// something is clearly wrong.
async function scanChats(name, f) {
  const found = new Map();
  let headerSeen = false, complete = false, total = null, expands = 0, pass = 0, previous = '';
  for (; pass < MAX_PASSES; pass++) {
    const lines = listLines(f);
    const section = chatSection(lines, headerSeen);
    headerSeen = section.headerSeen;
    if (section.total !== null) total = section.total;
    // Keep the freshest sighting of each row: an older one's position on the
    // screen is stale the moment the list moves.
    for (const hit of matchesIn(section, name)) found.set(hit.identity, { line: hit.line, pass });
    if (section.endSeen) { complete = true; break; }
    if (section.seeMore && expands < 2) {
      // The rest of the matches are behind this. Clicking it can also land on
      // a row as the list re-draws and open that chat - harmless, because
      // nothing is ever typed into a chat whose title has not been checked.
      expands++;
      click(section.seeMore.cx, section.seeMore.cy);
      await sleep(1200);
      continue;
    }
    const signature = lines.map(l => l.text).join('|');
    if (signature === previous) { complete = true; break; }
    previous = signature;
    scrollList(f, SCROLL_STEPS);
    await sleep(500);
  }
  return { found, total, complete, lastPass: pass };
}

// The one row we want, at coordinates that are still current. If it was read
// several screens ago the list has moved since, so it is walked back up until
// the row is on screen again rather than clicking where it used to be.
async function rowOnScreen(name, f) {
  for (let i = 0; i < MAX_PASSES; i++) {
    const hits = matchesIn(chatSection(listLines(f), true), name);
    if (hits.length === 1) return hits[0].line;
    if (hits.length > 1) return null;
    scrollList(f, -SCROLL_STEPS);
    await sleep(400);
  }
  return null;
}

async function chatRowFor(name, f) {
  const { found, total, complete, lastPass } = await scanChats(name, f);
  const many = total && total > 1 ? ` (${total} chats match "${name}")` : '';
  if (found.size > 1) return { row: null, why: `more than one chat is called "${name}"` };
  if (!complete) return { row: null, why: `the list of matching chats could not be read to the end${many}` };
  if (!found.size) return { row: null, why: `no chat by that name${many}` };

  if (lastPass > 0) log(`   read ${lastPass + 1} screens of the chat list to be sure of "${name}"`);
  const only = [...found.values()][0];
  if (only.pass === lastPass) return { row: only.line, why: '' };
  log('   scrolling back to the row');
  const row = await rowOnScreen(name, f);
  if (!row) return { row: null, why: `the chat called "${name}" could not be brought back on screen` };
  return { row, why: '' };
}

// The strip above the chat, where LINE writes whose chat it is.
const headerRect = (f) => ({ x: f.pane.x, y: f.win.y + 40, w: f.pane.w, h: f.pane.y - f.win.y - 40 });
const composerRect = (f) => ({ x: f.pane.x, y: f.pane.y + f.pane.h * 0.6, w: f.pane.w, h: f.pane.h * 0.4 });

function headerTitle(f) {
  const words = readWords(headerRect(f), 'header')
    .filter(w => w.x < f.pane.x + f.pane.w * 0.6);
  if (!words.length) return { readings: [], shown: '' };
  const line = words.filter(w => w.line === words[0].line).sort((a, b) => a.x - b.x);
  return { readings: titleReadings(line), shown: line.map(w => w.text).join(' ') };
}

const composerLines = (f) => read(composerRect(f), 'composer');
const emptyComposer = (f) => composerLines(f).find(l => norm(l.text) === norm(PLACEHOLDER)) || null;

// ---------------------------------------------------------------- sending one

async function openChat(guest, f) {
  const name = (guest.lineName || '').trim();
  setSearch(name);
  await sleep(1400);

  const { row, why } = await chatRowFor(name, f);
  if (!row) throw new Error(why);

  click(f.list.x + f.list.w * 0.3, row.cy);
  await sleep(1600);

  // A chat is on screen now, so the pane is really there even if it had to be
  // guessed at a moment ago. Read the window again and check the title against
  // the real thing.
  const open = frames();
  const { readings, shown } = headerTitle(open);
  if (!titleConfirms(name, readings)) {
    throw new Error(`the chat that opened is titled "${shown || '(unreadable)'}", not "${name}" - nothing sent`);
  }
  return { title: shown, frames: open };
}

// Types into the message box and sends. Returns nothing; it throws if the box
// was not empty first, or is not empty after.
async function sendIntoChat(f, { text, images }) {
  const box = emptyComposer(f);
  if (!box) {
    throw new Error('the message box is not empty - leaving what is in it alone');
  }

  if (text) {
    copyText(text);
    click(box.cx, box.cy);
    await sleep(400);
    press(KEY.v, 'cmd');
    await sleep(900);
    if (emptyComposer(f)) throw new Error('the text did not go into the message box');
    press(KEY.enter);
    await sleep(1600);
    if (!emptyComposer(f)) throw new Error('the message box is still full after Enter - it may not have sent');
  }

  let attached = 0;
  if (images.length) {
    const spot = emptyComposer(f);
    if (spot) click(spot.cx, spot.cy);
    await sleep(300);
    for (const url of images) {
      try {
        await copyImage(url);
      } catch (err) {
        log('   could not fetch a picture:', err.message);
        continue;
      }
      press(KEY.v, 'cmd');
      await sleep(1200);
      attached++;
    }
    if (attached) {
      if (emptyComposer(f)) throw new Error('the pictures did not go into the message box');
      press(KEY.enter);
      await sleep(2500 + attached * 800);
      if (!emptyComposer(f)) throw new Error('the pictures are still in the message box after Enter');
    }
  }
  return attached;
}

async function sendOne(guest) {
  await focusLine();
  const f = frames();
  const { title, frames: open } = await openChat(guest, f);
  const images = imageUrlsOf(guest.queued);
  const attached = await sendIntoChat(open, { text: guest.queued.text, images });
  setSearch('');
  return { title, wanted: images.length, attached };
}

// ------------------------------------------------------------------- the run

async function drain() {
  if (selfChanged()) {
    log('send.js has changed on disk since this sender started.');
    log('Stopping rather than sending with the old code - start it again to pick up the change:');
    log('  ADMIN_PASSWORD=... npm start');
    process.exit(0);
  }
  const queue = await queuedGuests();
  if (!queue.length) return 0;

  log(`${queue.length} queued for LINE`);
  let sent = 0;
  for (const guest of queue.slice(0, MAX_PER_RUN)) {
    const who = guest.name || guest.lineName;
    if (DRY) {
      const imgs = imageUrlsOf(guest.queued);
      log(`WOULD SEND to ${who} as "${guest.lineName}"${imgs.length ? ` [${imgs.length} image${imgs.length === 1 ? '' : 's'}]` : ''}`);
      log('   ' + guest.queued.text.replace(/\n/g, '\n   '));
      continue;
    }
    try {
      const { wanted, attached } = await sendOne(guest);
      const lost = wanted - attached;
      const note = lost > 0 ? `sent without ${lost} of ${wanted} picture${wanted === 1 ? '' : 's'}` : '';
      await api('/api/admin/guests', 'PATCH', {
        id: guest.id, queued: null, invited: 'line', ...(note ? { queueError: note } : {}),
      });
      sent++;
      const how = attached ? `with ${attached} picture${attached === 1 ? '' : 's'}` : 'text only';
      log(`sent to ${who} (${how})  (${sent}/${Math.min(queue.length, MAX_PER_RUN)})`);
      if (note) log('   WARNING: ' + note);
    } catch (err) {
      const { clearQueue, standDown } = failureAction(err);
      log(`NOT SENT to ${who}: ${err.message}`);
      if (clearQueue) {
        // Something about this guest is wrong and will be wrong again, so it
        // comes off the queue with the reason on the record - otherwise one
        // unmatchable name jams every run after it. The Invite page shows it.
        await api('/api/admin/guests', 'PATCH', { id: guest.id, queued: null, queueError: err.message })
          .catch(() => {});
      } else {
        log('   still queued - this is the Mac, not the guest');
      }
      // No point working through the rest of the queue while the machine is
      // not in a state to send: every one of them would fail the same way.
      if (standDown) throw err;
    }
    const gap = jitter();
    log(`   waiting ${Math.round(gap / 1000)}s`);
    await sleep(gap);
  }
  return sent;
}

async function lookUp(name) {
  ensureTools();
  await focusLine();
  const f = frames();
  checkScreenReadable(f);
  setSearch(name);
  await sleep(1400);
  // Exactly what the sender does before it opens a chat, stopping short of
  // the click - so what this says is what a real run would find.
  const { row, why } = await chatRowFor(name, f);
  setSearch('');
  console.log(`\n"${name}"`);
  console.log(row
    ? `  found, on screen at ${Math.round(row.cx)},${Math.round(row.cy)}\n  -> this name can be sent to\n`
    : `  ${why}\n  -> this name cannot be sent to as it stands\n`);
  process.exit(row ? 0 : 1);
}

async function main() {
  if (FIND) return lookUp(FIND);
  if (!PW) {
    console.error('Set ADMIN_PASSWORD first:\n  ADMIN_PASSWORD=... npm run dry');
    process.exit(1);
  }
  if (DRY) {
    const n = await drain();
    log('dry run complete, nothing sent');
    process.exit(0);
  }

  ensureTools();
  saveClipboard();
  process.on('exit', restoreClipboard);
  process.on('SIGINT', () => { restoreClipboard(); process.exit(0); });

  console.log('\nThis drives the LINE app on this Mac. While it runs it owns the');
  console.log('keyboard and the mouse - leave the machine alone until it says done.\n');

  // A one-shot run has to be able to see LINE right now. A watching one does
  // not: it is started once and left alone, so it checks when there is
  // something to send rather than refusing to start.
  if (!WATCH) {
    await focusLine();
    checkScreenReadable(frames());
  }

  const total = await drain();
  if (!WATCH) {
    log(`done, ${total} sent`);
    process.exit(0);
  }
  log('watching for newly queued LINE invites - Ctrl+C to stop');
  let waiting = '';
  setInterval(() => drain().then(() => { waiting = ''; }).catch(e => {
    if (failureAction(e).standDown) {
      // Mark is using his Mac, or LINE is not up. Nothing has been lost and
      // nothing is wrong with the queue; it will go out when the machine is
      // free. Said once, not every fifteen seconds.
      if (waiting !== e.message) { log(e.message); log('   still queued - trying again shortly'); }
      waiting = e.message;
      return;
    }
    log('stopping:', e.message);
    process.exit(1);
  }), POLL_MS);
}

if (require.main === module) {
  main().catch(err => { console.error('sender failed:', err.message); process.exit(1); });
}

// The parts that decide who gets a message are pure, so they can be tested
// without a Mac, a screen or anybody's LINE account.
module.exports = { titleConfirms, titleReadings, pickChatRow, chatSection, matchesIn, isQueuedForLine,
                   imageUrlsOf, norm, EnvironmentError, failureAction };
