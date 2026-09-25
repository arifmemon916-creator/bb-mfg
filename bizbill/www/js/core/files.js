// File validation for product images and payment attachments.
// The real type is detected from the file's first bytes ("magic numbers"),
// never from the file name or the MIME type the picker reports.

export const LIMITS = {
  imageInputBytes: 15 * 1024 * 1024, // largest photo accepted before resizing
  pdfBytes: 5 * 1024 * 1024,
  productImageSide: 800,
  productThumbSide: 96,
  attachmentImageSide: 1600,
  paymentAttachments: 4,
};

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Detect type from content. bytes: Uint8Array (first 16 bytes are enough). */
export function sniffType(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  return null;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Parse a data: URL, validating base64 and declared vs actual type. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const b64 = m[2];
  if (b64.length % 4 !== 0 || !B64.test(b64)) return null;
  const head = base64ToBytes(b64.slice(0, 24));
  const actual = sniffType(head);
  if (!actual || actual !== m[1].toLowerCase()) return null;
  return { mime: actual, b64, size: Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0) };
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export async function sha256OfString(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Is this stored attachment record intact? Used by backup validation / restore. */
export function isValidAttachment(a) {
  if (!a || typeof a !== 'object' || !a.id) return false;
  const p = parseDataUrl(a.data);
  if (!p) return false;
  if (p.mime === 'application/pdf') return p.size <= LIMITS.pdfBytes;
  return IMAGE_TYPES.includes(p.mime) && p.size <= LIMITS.imageInputBytes;
}

export function safeFileName(name, fallback = 'file') {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return s || fallback;
}
