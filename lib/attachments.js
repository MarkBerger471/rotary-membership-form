/*
 * What may be attached to a meeting, and what is stored about it.
 *
 * Three kinds hang off a meeting: pictures, files (the flyer PDF, a programme,
 * a list), and links to something that lives elsewhere. Only the description of
 * an attachment is kept on the meeting itself - the bytes live under their own
 * key, the way invite images and member photos already do. The planner loads
 * every meeting of the Rotary year in one go, so a flyer PDF folded into that
 * blob would be paid for on every page load and on every save.
 *
 * Shared by the meetings API and the attachment endpoint so that what one
 * writes is exactly what the other will accept back.
 */

const KINDS = ['image', 'file', 'link'];

// Twelve is more than a meeting has ever needed and keeps one badly-behaved
// date from growing the meetings blob without limit.
const MAX_ATTACHMENTS = 12;

// The same ceiling api/invite-image.js uses, for the same reason: KV stores the
// bytes base64-encoded inside one value, and that value has to stay small
// enough to write and read comfortably.
const MAX_BYTES = 900 * 1024;

// Pictures are shrunk in the browser before they arrive, so they land well
// under the limit. The rest cannot be shrunk, which is what the link kind is
// for when something is too big to hold.
const UPLOAD_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/pdf': 'file',
  'text/plain': 'file',
  'text/csv': 'file',
  'application/msword': 'file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file',
  'application/vnd.ms-excel': 'file',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file',
  'application/vnd.ms-powerpoint': 'file',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'file',
};

const attachmentKey = (id) => `file:meeting:${id}`;
const newAttachmentId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const str = (v, max = 160) => (typeof v === 'string' ? v : '').trim().slice(0, max);

// A link is rendered as an href on the planner, so a "javascript:" or "data:"
// URL typed into the label box would run as soon as anyone clicked it. Only
// http and https survive; a bare "rotary.org" is read as the site it obviously
// means rather than rejected.
function safeUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return url.toString();
  } catch {
    return '';
  }
}

// Anything that cannot be made sense of is dropped rather than stored half
// formed - a link with no usable address, or a file with no id, would show on
// the card as something that cannot be opened.
function normalizeAttachment(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) return null;

  const base = {
    id: str(input.id, 64) || newAttachmentId(),
    kind,
    name: str(input.name),
    addedAt: str(input.addedAt, 40) || new Date().toISOString(),
  };

  if (kind === 'link') {
    const url = safeUrl(input.url);
    if (!url) return null;
    // A link with no label of its own is shown by its host, which reads better
    // on a small card than a full URL.
    let label = base.name;
    if (!label) {
      try { label = new URL(url).hostname.replace(/^www\./, ''); } catch { label = url; }
    }
    return { ...base, name: label, url };
  }

  const mimeType = str(input.mimeType, 120);
  if (!UPLOAD_TYPES[mimeType]) return null;
  const bytes = Number(input.bytes);
  return {
    ...base,
    name: base.name || (kind === 'image' ? 'Picture' : 'File'),
    mimeType,
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0,
  };
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const att = normalizeAttachment(item);
    if (!att || seen.has(att.id)) continue;
    seen.add(att.id);
    out.push(att);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

module.exports = {
  KINDS,
  MAX_ATTACHMENTS,
  MAX_BYTES,
  UPLOAD_TYPES,
  attachmentKey,
  newAttachmentId,
  safeUrl,
  normalizeAttachment,
  normalizeAttachments,
};
