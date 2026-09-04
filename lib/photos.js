const SOI = Buffer.from([0xff, 0xd8, 0xff]);   // JPEG start of image
const EOI = Buffer.from([0xff, 0xd9]);         // JPEG end of image

const MAX_PHOTO_BYTES = 600 * 1024;
const MIN_PHOTO_BYTES = 8 * 1024;   // below this it is a logo or an icon, not a face

// The application PDF carries the applicant's uploaded photo inside it. When
// the photo is not posted as its own file we recover it from the PDF, so a
// member's picture never depends on how the application happened to arrive.
// JPEGs are stored uncompressed in a PDF (DCTDecode), so they can be read out
// directly by their markers.
function extractEmbeddedJpeg(pdfBuffer, opts = {}) {
  const min = opts.minBytes || MIN_PHOTO_BYTES;
  const max = opts.maxBytes || MAX_PHOTO_BYTES;
  if (!Buffer.isBuffer(pdfBuffer)) return null;

  let best = null;
  let i = 0;
  while (i < pdfBuffer.length) {
    const start = pdfBuffer.indexOf(SOI, i);
    if (start === -1) break;
    const end = pdfBuffer.indexOf(EOI, start + 3);
    if (end === -1) break;
    const blob = pdfBuffer.subarray(start, end + 2);
    // Largest wins: club logos and icons are far smaller than a portrait.
    if (blob.length >= min && blob.length <= max && (!best || blob.length > best.length)) {
      best = Buffer.from(blob);
    }
    i = end + 2;
  }
  return best;
}

// Decide what to store as the member's picture, preferring the file the
// applicant uploaded and falling back to whatever is embedded in the PDF.
function choosePhoto(files) {
  if (files && files.photo && files.photo.buffer && files.photo.buffer.length <= MAX_PHOTO_BYTES) {
    return { content: files.photo.buffer, mimeType: files.photo.mimeType || 'image/jpeg', source: 'upload' };
  }
  const embedded = files && files.pdf ? extractEmbeddedJpeg(files.pdf.buffer) : null;
  if (embedded) return { content: embedded, mimeType: 'image/jpeg', source: 'pdf' };
  return null;
}

module.exports = { extractEmbeddedJpeg, choosePhoto, MAX_PHOTO_BYTES, MIN_PHOTO_BYTES };
