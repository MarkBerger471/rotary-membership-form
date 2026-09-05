const ADMIN_PASSWORD_KEY = 'rotaryAdminPassword';

let adminPassword = sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';

function setAdminPassword(pwd) {
  adminPassword = pwd;
  sessionStorage.setItem(ADMIN_PASSWORD_KEY, pwd);
}

function clearAdminPassword() {
  adminPassword = '';
  sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
}

async function tryLogin(pwd) {
  try {
    const res = await fetch('/api/admin/settings', { headers: { 'X-Admin-Password': pwd } });
    return res.ok;
  } catch {
    return false;
  }
}

function requireAuthOrRedirect() {
  if (!adminPassword) {
    window.location.replace('/admin');
    return false;
  }
  return true;
}

function adminLogout() {
  clearAdminPassword();
  window.location.replace('/admin');
}

function handleUnauthorized() {
  clearAdminPassword();
  showToast('Session expired. Please log in again.', 'error');
  setTimeout(() => window.location.replace('/admin'), 1000);
}

async function apiFetch(url, options = {}) {
  const headers = { 'X-Admin-Password': adminPassword, ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('Unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  // Without this a 400/409/500 resolved like a success and the caller showed
  // "Saved" over a rejected write.
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

async function openFile(id, type) {
  try {
    const res = await fetch(`/api/admin/download?id=${encodeURIComponent(id)}&type=${type}`, {
      headers: { 'X-Admin-Password': adminPassword },
    });
    if (res.status === 401) { handleUnauthorized(); return; }
    if (!res.ok) { showToast('Failed to open file', 'error'); return; }
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  } catch {
    showToast('Failed to open file', 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function ensureToastEl() {
  if (document.getElementById('toast')) return;
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = 'fixed bottom-6 right-6 z-50 hidden';
  toast.innerHTML = `
    <div class="glass-card rounded-xl px-5 py-3 flex items-center gap-3 shadow-lg">
      <div id="toastIcon"></div>
      <span id="toastText" class="text-sm font-medium"></span>
    </div>
  `;
  document.body.appendChild(toast);
}

function showToast(message, type) {
  ensureToastEl();
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const text = document.getElementById('toastText');
  text.textContent = message;
  if (type === 'success') {
    icon.innerHTML = '<svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
  } else {
    icon.innerHTML = '<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
  }
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

/* ==================================================================
 * Admin area navigation
 *
 * Every admin page used to be a dead end: the only route from Guests to
 * Membership was the back arrow to /admin and then out again through a tile.
 * This renders one shared bar of the five admin areas underneath the page
 * header so they are always one tap apart.
 *
 * It lives here, in the one script every admin page already loads, rather
 * than being pasted into seven files. A header copied by hand into
 * guests.html once already drifted and silently lost its back link and
 * title; five hand-maintained copies of a nav would go the same way.
 *
 * The markup is injected after the last <header> on the page - that is the
 * brand bar on /admin and the back-arrow/title bar on every subpage - and
 * the active item is derived from location.pathname, so a page gets the bar
 * (correctly highlighted) just by loading admin.js.
 * ================================================================== */

const ADMIN_NAV_ITEMS = [
  {
    label: 'Meeting Planner',
    href: '/admin/meeting-planner',
    // The flyer is a sub-page of the planner, so it lights the planner up.
    match: ['/admin/meeting-planner', '/admin/meeting-flyer'],
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  },
  {
    label: 'Membership',
    href: '/admin/membership',
    match: ['/admin/membership'],
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  },
  {
    label: 'Member Contacts',
    href: '/admin/member-contacts',
    match: ['/admin/member-contacts'],
    icon: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5.13a4 4 0 11-8 0 4 4 0 018 0zm6 3a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    label: 'Guests',
    href: '/admin/guests',
    match: ['/admin/guests'],
    icon: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z',
  },
  {
    label: 'Invite',
    href: '/admin/invite',
    match: ['/admin/invite'],
    icon: 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 4v-4z',
  },
];

// /admin/guests, /admin/guests.html and /admin/guests/ are all the same page:
// cleanUrls is on in production but a local static server serves the .html.
function adminNavPath() {
  let path = '';
  try { path = (window.location && window.location.pathname) || ''; } catch { return ''; }
  path = String(path).toLowerCase().replace(/index\.html$/, '').replace(/\.html$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

function adminNavHtml() {
  const here = adminNavPath();
  const items = ADMIN_NAV_ITEMS.map((item) => {
    const active = item.match.indexOf(here) !== -1;
    return `<a href="${item.href}" class="admin-nav-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>`
      + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">`
      + `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${item.icon}"/></svg>`
      + `<span>${item.label}</span></a>`;
  }).join('');
  return `<nav class="admin-nav no-print" aria-label="Admin areas"><div class="admin-nav-inner">${items}</div></nav>`;
}

// On a phone the five items are wider than the screen, so the row scrolls
// sideways. Park the current area in the middle of it, otherwise you can land
// on Invite and see no highlight at all because it sits off the right edge.
function centerAdminNavActive() {
  try {
    const row = document.querySelector('.admin-nav-inner');
    const active = document.querySelector('.admin-nav-item.active');
    if (!row || !active) return;
    // Re-measured after web fonts land, which changes every item's width - but
    // not if the reader has since scrolled the row themselves.
    if (row._navScrollLeft != null && Math.abs(row.scrollLeft - row._navScrollLeft) > 1) return;
    if (row.scrollWidth <= row.clientWidth) { row._navScrollLeft = 0; return; }
    row.scrollLeft = Math.max(0, active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2);
    row._navScrollLeft = row.scrollLeft;
  } catch (err) {
    /* purely cosmetic */
  }
}

function renderAdminNav() {
  try {
    if (document.querySelector('.admin-nav')) return;
    const headers = document.querySelectorAll('header');
    const anchor = headers && headers.length ? headers[headers.length - 1] : null;
    if (!anchor || !anchor.insertAdjacentHTML) return;
    anchor.insertAdjacentHTML('afterend', adminNavHtml());
    centerAdminNavActive();
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(centerAdminNavActive).catch(() => {});
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('load', centerAdminNavActive);
    }
  } catch (err) {
    /* The nav is a convenience; never let it take a page down. */
  }
}

if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAdminNav);
  } else {
    renderAdminNav();
  }
}
