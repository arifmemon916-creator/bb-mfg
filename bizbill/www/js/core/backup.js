// Backup & restore. A backup is a single JSON file containing every
// business store (no caches, no local snapshots) plus a SHA-256 checksum.

import { DATA_VERSION, migrateData } from './migrate.js';
import { newId, DATA_STORES } from './db.js';
import { nowStamp } from './dates.js';
import { isValidAttachment } from './files.js';

export const BACKUP_FORMAT = 'bizbill-backup';
export const ENCRYPTED_FORMAT = 'bizbill-backup-encrypted';
// 1 = initial; 2 = adds notifications, product images, payment attachments, encryption envelope.
export const BACKUP_FORMAT_VERSION = 2;
export { VERSION_NAME as APP_VERSION } from '../version.js';
import { VERSION_NAME as APP_VERSION } from '../version.js';
const STORES = DATA_STORES;
const COUNT_LABELS = {
  parties: 'Customers & suppliers', products: 'Products', documents: 'Invoices / purchases / quotations',
  payments: 'Payments', expenses: 'Expenses', stockMoves: 'Stock adjustments', attachments: 'Attachments', audit: 'Activity entries',
};

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function countsOf(data) {
  const c = {};
  for (const s of STORES) c[s] = Array.isArray(data[s]) ? data[s].length : 0;
  c.customers = (data.parties || []).filter((p) => p.type === 'customer').length;
  c.suppliers = (data.parties || []).filter((p) => p.type === 'supplier').length;
  c.sales = (data.documents || []).filter((d) => d.kind === 'sale').length;
  c.purchases = (data.documents || []).filter((d) => d.kind === 'purchase').length;
  c.quotations = (data.documents || []).filter((d) => d.kind === 'quotation').length;
  return c;
}

export async function createBackup(store) {
  const data = await store.exportStores();
  // The PIN hash is never needed off-device; strip it from the file.
  for (const s of data.settings) {
    if (s.key === 'app' && s.security) s.security = { ...s.security, pinHash: '', pinSalt: '', enabled: false };
  }
  const payload = JSON.stringify(data);
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    dataVersion: DATA_VERSION,
    createdAt: nowStamp(),
    company: store.settings.company.name || '',
    counts: countsOf(data),
    checksum: await sha256Hex(payload),
    data,
  };
}

export function backupFileName(company, date = new Date()) {
  const slug = String(company || 'BizBill').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 30) || 'BizBill';
  const p = (n) => String(n).padStart(2, '0');
  return `${slug}-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.json`;
}

/**
 * Validate a parsed backup object.
 * Returns {ok, errors[], info: {createdAt, appVersion, dataVersion, company, counts, countLabels}}
 */
export async function validateBackup(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['File is not a BizBill backup'] };
  if (obj.format === ENCRYPTED_FORMAT) return { ok: false, encrypted: true, errors: ['This backup is password protected'] };
  if (obj.format !== BACKUP_FORMAT) errors.push('File is not a BizBill backup');
  if (obj.formatVersion != null && obj.formatVersion > BACKUP_FORMAT_VERSION) errors.push('Backup format is newer than this app. Update BizBill first.');
  if (!obj.data || typeof obj.data !== 'object') errors.push('Backup has no data section');
  if (typeof obj.dataVersion !== 'number') errors.push('Backup version is missing');
  else if (obj.dataVersion > DATA_VERSION) errors.push('Backup was made by a newer version of BizBill. Update the app first.');
  if (errors.length) return { ok: false, errors };
  for (const s of STORES) {
    if (obj.data[s] != null && !Array.isArray(obj.data[s])) errors.push(`Section "${s}" is corrupt`);
  }
  if (obj.checksum) {
    const actual = await sha256Hex(JSON.stringify(obj.data));
    if (actual !== obj.checksum) errors.push('Checksum mismatch: the backup file is damaged or was modified');
  } else {
    errors.push('Backup checksum is missing');
  }
  // Record-level sanity checks.
  const ids = new Set();
  for (const s of STORES) {
    for (const r of obj.data[s] || []) {
      if (!r || typeof r !== 'object') { errors.push(`Section "${s}" contains an invalid record`); break; }
      const key = s === 'settings' || s === 'meta' ? r.key : r.id;
      if (key == null) { errors.push(`Section "${s}" contains a record without id`); break; }
      if (ids.has(s + ':' + key)) { errors.push(`Section "${s}" contains duplicate id ${key}`); break; }
      ids.add(s + ':' + key);
    }
  }
  for (const d of obj.data.documents || []) {
    if (!d.totals || typeof d.totals.grandTotal !== 'number' || !Array.isArray(d.items)) { errors.push(`Document ${d.number || d.id} is incomplete`); break; }
  }
  for (const p of obj.data.payments || []) {
    if (!Number.isInteger(p.amount)) { errors.push(`Payment ${p.number || p.id} has an invalid amount`); break; }
  }
  const badAttachments = (obj.data.attachments || []).filter((a) => !isValidAttachment(a)).length;
  const warnings = badAttachments ? [`${badAttachments} damaged image/attachment(s) will be skipped`] : [];
  const counts = countsOf(obj.data);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info: {
      createdAt: obj.createdAt, appVersion: obj.appVersion, dataVersion: obj.dataVersion, company: obj.company,
      counts, countLabels: COUNT_LABELS,
    },
  };
}

/** Keep a local copy of the current data before a restore (and for auto backup in browsers). */
export async function saveSnapshot(store, reason, keep = 5) {
  const backup = await createBackup(store);
  const snap = { id: newId('s'), createdAt: backup.createdAt, reason, counts: backup.counts, json: JSON.stringify(backup) };
  const all = (await store.db.getAll('snapshots')).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const ops = [{ store: 'snapshots', op: 'put', value: snap }];
  const sameReason = all.filter((s) => s.reason === reason);
  for (const old of sameReason.slice(Math.max(0, keep - 1))) ops.push({ store: 'snapshots', op: 'delete', key: old.id });
  await store.db.write(ops);
  return { snap, backup };
}

export async function listSnapshots(store) {
  const all = await store.db.getAll('snapshots');
  return all.map(({ json, ...meta }) => ({ ...meta, size: json ? json.length : 0 }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getSnapshot(store, id) {
  const s = await store.db.get('snapshots', id);
  return s ? JSON.parse(s.json) : null;
}

export async function deleteSnapshot(store, id) {
  await store.db.write([{ store: 'snapshots', op: 'delete', key: id }]);
}

/**
 * Restore a validated backup. Creates a safety snapshot first, then replaces
 * all data in ONE transaction (if anything fails, nothing changes).
 */
export async function restoreBackup(store, obj, { safety = true } = {}) {
  const v = await validateBackup(obj);
  if (!v.ok) throw new Error(v.errors.join('\n'));
  let safetySnap = null;
  if (safety) safetySnap = (await saveSnapshot(store, 'before-restore', 3)).snap;
  const data = migrateData(structuredClone(obj.data), obj.dataVersion);
  // App lock and backup schedule belong to this device, not to the file:
  // keep the current ones so a restore can never lock the user out.
  data.settings = data.settings || [];
  let app = data.settings.find((s) => s.key === 'app');
  if (!app) { app = { key: 'app' }; data.settings.push(app); }
  app.security = structuredClone(store.settings.security);
  // Skip damaged attachments instead of failing the whole restore.
  const good = (data.attachments || []).filter(isValidAttachment);
  const goodIds = new Set(good.map((a) => a.id));
  const skipped = (data.attachments || []).length - good.length;
  data.attachments = good;
  for (const p of data.products || []) if (p.imageId && !goodIds.has(p.imageId)) { p.imageId = ''; p.imageSha = ''; p.thumb = ''; }
  for (const p of data.payments || []) if (Array.isArray(p.attachments)) p.attachments = p.attachments.filter((a) => goodIds.has(a.id));
  for (const e of data.expenses || []) if (e.attachmentId && !goodIds.has(e.attachmentId)) e.attachmentId = '';
  app.backup = structuredClone(store.settings.backup);
  await store.replaceAll(data, 'restore');
  return { safetySnapshotId: safetySnap ? safetySnap.id : null, skippedAttachments: skipped };
}

// ---------------------------------------------------------------- encryption
// Password protected backups: AES-256-GCM, key from PBKDF2-SHA256 (310k
// iterations, random salt). GCM authenticates the data, so a wrong password
// or any modification is detected.

const ENC_ITERATIONS = 310000;

function b64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function backupPasswordError(pw) {
  if (String(pw || '').length < 8) return 'Use at least 8 characters for the backup password';
  return '';
}

export async function encryptBackup(backup, password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ENC_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(backup));
  const cipher = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    format: ENCRYPTED_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: backup.createdAt,
    company: backup.company,
    counts: backup.counts,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ENC_ITERATIONS, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    payload: b64(cipher),
  };
}

export function isEncryptedBackup(obj) {
  return !!obj && obj.format === ENCRYPTED_FORMAT;
}

export async function decryptBackup(env, password) {
  if (!isEncryptedBackup(env) || !env.kdf || !env.cipher || typeof env.payload !== 'string') throw new Error('Encrypted backup is damaged');
  const iterations = Math.min(Math.max(Number(env.kdf.iterations) || 0, 100000), 5000000);
  let plain;
  try {
    const key = await deriveKey(password, unb64(env.kdf.salt), iterations);
    plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.cipher.iv) }, key, unb64(env.payload));
  } catch {
    throw new Error('Wrong password, or the backup file is damaged');
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
