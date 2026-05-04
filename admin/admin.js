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
  return res.json();
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
