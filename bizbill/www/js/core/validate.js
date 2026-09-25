// Input validation helpers shared by forms and CSV import.
import { isKnownStateCode } from './states.js';

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z0-9][0-9A-Z]$/;

export function normalizeGstin(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, '');
}

export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const val = GST_CHARS.indexOf(first14[i]);
    if (val < 0) return null;
    const prod = val * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}

/** Returns '' when valid (or empty), else a human readable error. */
export function gstinError(v) {
  const g = normalizeGstin(v);
  if (!g) return '';
  if (g.length !== 15) return 'GSTIN must be 15 characters';
  if (!GSTIN_RE.test(g)) return 'GSTIN format is invalid';
  if (!isKnownStateCode(g.slice(0, 2))) return 'GSTIN state code is invalid';
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'GSTIN checksum does not match';
  return '';
}

export function mobileError(v) {
  const s = String(v || '').replace(/[\s-]/g, '');
  if (!s) return '';
  if (!/^\+?\d{7,15}$/.test(s)) return 'Mobile number is invalid';
  return '';
}

export function emailError(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Email is invalid';
  return '';
}

export function hsnError(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^\d{2,8}$/.test(s)) return 'HSN/SAC must be 2–8 digits';
  return '';
}

export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

export function gstRateError(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 'GST % must be between 0 and 100';
  if (Math.round(n * 100) !== n * 100 && Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'GST % allows at most 2 decimals';
  return '';
}

export function stateCodeError(v) {
  if (!v) return '';
  return isKnownStateCode(String(v).padStart(2, '0')) ? '' : 'Unknown state code';
}
