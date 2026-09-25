// Platform bridge. Inside the BizBill Android app, `window.BizBillNative`
// is injected by MainActivity (see android/app/src/main/java/.../NativeBridge.kt)
// and provides secure sharing (FileProvider), printing (PrintManager),
// biometric prompt, local notifications and backup file storage.
// In a normal browser the same API falls back to web equivalents.

const native = typeof window !== 'undefined' ? window.BizBillNative : undefined;
export const isAndroidApp = !!native;

const pending = new Map();
let cbSeq = 0;

// Native code resolves async calls through this global.
if (typeof window !== 'undefined') {
  window.BizBillBridge = window.BizBillBridge || {};
  window.BizBillBridge.resolve = (id, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    let v = json;
    try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { /* plain string */ }
    p(v);
  };
}

function nativeAsync(fn, ...args) {
  return new Promise((resolve) => {
    const id = 'cb' + (++cbSeq);
    pending.set(id, resolve);
    try {
      native[fn](id, ...args);
    } catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: String(e) });
    }
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Share a file. target: '' (chooser) | 'whatsapp' | 'email'.
 * On Android the file is written to the app cache and exposed ONLY through
 * a content:// FileProvider URI with a temporary read grant.
 */
export async function shareFile(blob, name, { text = '', subject = '', target = '', phone = '' } = {}) {
  if (native && native.shareFile) {
    const b64 = await blobToBase64(blob);
    return nativeAsync('shareFile', name, blob.type || 'application/octet-stream', b64, text, subject, target, phone);
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: subject || name, text });
      return { ok: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, cancelled: true };
    }
  }
  download(blob, name);
  return { ok: true, downloaded: true };
}

/** Share plain text (e.g. customer details) via WhatsApp / chooser. */
export async function shareText(text, { target = '', phone = '', subject = '' } = {}) {
  if (native && native.shareText) return nativeAsync('shareText', text, subject, target, phone);
  if (target === 'whatsapp') {
    const p = String(phone || '').replace(/\D/g, '');
    window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    return { ok: true };
  }
  if (navigator.share) {
    try { await navigator.share({ text, title: subject }); return { ok: true }; } catch { return { ok: false }; }
  }
  try { await navigator.clipboard.writeText(text); return { ok: true, copied: true }; } catch { return { ok: false }; }
}

/** Save a file where the user chooses (Storage Access Framework on Android). */
export async function saveFile(blob, name) {
  if (native && native.saveFile) {
    const b64 = await blobToBase64(blob);
    return nativeAsync('saveFile', name, blob.type || 'application/octet-stream', b64);
  }
  download(blob, name);
  return { ok: true, downloaded: true };
}

/** Print a PDF via Android PrintManager (or the browser print dialog). */
export async function printPdf(blob, name) {
  if (native && native.printPdf) {
    const b64 = await blobToBase64(blob);
    return nativeAsync('printPdf', name, b64);
  }
  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  frame.src = url;
  document.body.appendChild(frame);
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank'); }
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
  };
  return { ok: true };
}

export function canUseBiometric() {
  try { return !!(native && native.canUseBiometric && native.canUseBiometric()); } catch { return false; }
}

export function authenticateBiometric(title = 'Unlock BizBill') {
  if (!canUseBiometric()) return Promise.resolve({ ok: false, error: 'unavailable' });
  return nativeAsync('authenticateBiometric', title);
}

export function notify(id, title, body) {
  if (native && native.notify) {
    try { native.notify(id, title, body); return true; } catch { return false; }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'bizbill-' + id }); return true; } catch { return false; }
  }
  return false;
}

export async function requestNotificationPermission() {
  if (native && native.requestNotificationPermission) return nativeAsync('requestNotificationPermission');
  if (typeof Notification === 'undefined') return { ok: false };
  const r = await Notification.requestPermission();
  return { ok: r === 'granted' };
}

/** Schedule a one-shot reminder notification (Android AlarmManager). */
export function scheduleReminder(kind, atMillis, title, body) {
  if (native && native.scheduleReminder) {
    try { native.scheduleReminder(kind, String(atMillis), title, body); return true; } catch { return false; }
  }
  return false;
}

export function cancelReminder(kind) {
  if (native && native.cancelReminder) try { native.cancelReminder(kind); } catch { /* ignore */ }
}

export function setFullscreen(on) {
  if (native && native.setFullscreen) { try { native.setFullscreen(!!on); } catch { /* ignore */ } return; }
  try {
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch { /* ignore */ }
}

export function setSecureScreen(on) {
  if (native && native.setSecureScreen) try { native.setSecureScreen(!!on); } catch { /* ignore */ }
}

export function setSystemBars(color, dark) {
  if (native && native.setSystemBars) try { native.setSystemBars(color, !!dark); } catch { /* ignore */ }
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', color);
}

export function appInfo() {
  if (native && native.getAppInfo) {
    try { return JSON.parse(native.getAppInfo()); } catch { /* ignore */ }
  }
  return { versionName: null, versionCode: 0, platform: 'web' };
}

export function openExternal(url) {
  if (native && native.openUrl) { native.openUrl(url); return; }
  window.open(url, '_blank', 'noopener');
}

export function exitApp() {
  if (native && native.exitApp) native.exitApp();
}

// ---- Backup files kept by the Android app (app-specific storage) ----

export const hasNativeBackups = !!(native && native.writeBackupFile);

export function writeBackupFile(name, json) {
  if (!hasNativeBackups) return { ok: false };
  try { return JSON.parse(native.writeBackupFile(name, json)); } catch (e) { return { ok: false, error: String(e) }; }
}

export function listBackupFiles() {
  if (!hasNativeBackups) return [];
  try { return JSON.parse(native.listBackupFiles()); } catch { return []; }
}

export function readBackupFile(name) {
  if (!hasNativeBackups) return null;
  try { return native.readBackupFile(name); } catch { return null; }
}

export function deleteBackupFile(name) {
  if (!hasNativeBackups) return false;
  try { return native.deleteBackupFile(name) === 'true'; } catch { return false; }
}

