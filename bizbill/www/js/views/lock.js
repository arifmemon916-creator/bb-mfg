// App lock screen (PIN + optional biometric). While locked, the lock
// overlay covers the whole UI and the app content is removed from view.

import { h, icon } from '../ui/dom.js';
import { verifyPin } from '../core/security.js';
import { authenticateBiometric, canUseBiometric } from '../platform/bridge.js';

let lockEl = null;
let lockPromise = null;
let failures = 0;
let blockedUntil = 0;

export function isLocked() {
  return !!lockEl;
}

export function showLock(store) {
  if (lockPromise) return lockPromise;
  const sec = store.settings.security;
  if (!sec.enabled || !sec.pinHash) return Promise.resolve();
  lockPromise = new Promise((resolve) => {
    let pin = '';
    const dots = h('div', { class: 'dots', 'aria-label': 'PIN entered' });
    const err = h('div', { class: 'err', role: 'alert' });
    const maxLen = 8;
    const app = document.getElementById('app');
    if (app) app.setAttribute('aria-hidden', 'true');
    const paint = () => {
      dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
    };
    const unlock = () => {
      failures = 0;
      lockEl.remove();
      lockEl = null;
      lockPromise = null;
      if (app) { app.removeAttribute('aria-hidden'); app.style.visibility = ''; }
      resolve();
    };
    const tryPin = async () => {
      if (Date.now() < blockedUntil) {
        err.textContent = `Too many attempts. Try again in ${Math.ceil((blockedUntil - Date.now()) / 1000)} s`;
        pin = ''; paint(); return;
      }
      if (await verifyPin(pin, sec)) { unlock(); return; }
      failures++;
      if (failures >= 5) {
        blockedUntil = Date.now() + Math.min(300, 30 * 2 ** (failures - 5)) * 1000;
        err.textContent = 'Too many attempts. Please wait.';
      } else {
        err.textContent = 'Incorrect PIN';
      }
      pin = '';
      paint();
    };
    const press = async (k) => {
      err.textContent = '';
      if (k === 'del') pin = pin.slice(0, -1);
      else if (k === 'ok') { if (pin.length >= 4) await tryPin(); return; }
      else if (pin.length < maxLen) pin += k;
      paint();
      // Auto-submit when the stored PIN length is reached is not possible
      // (length is not stored), so submit on 'OK' or when 8 digits typed.
      if (pin.length === maxLen) await tryPin();
    };
    const bio = async () => {
      const r = await authenticateBiometric('Unlock BizBill');
      if (r && r.ok) unlock();
      else if (r && r.error && r.error !== 'cancelled') err.textContent = r.error;
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    const useBio = sec.biometric && canUseBiometric();
    lockEl = h('div', { class: 'lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'App locked' },
      icon('lock'),
      h('h2', null, store.settings.company.name || 'BizBill'),
      h('div', null, 'Enter PIN to unlock'),
      dots, err,
      h('div', { class: 'keypad' }, keys.map((k) => h('button', {
        'aria-label': k === 'del' ? 'Delete' : k === 'ok' ? 'Unlock' : k,
        onclick: () => press(k),
      }, k === 'del' ? '⌫' : k === 'ok' ? '✓' : k))),
      useBio ? h('button', { class: 'btn ghost', style: { color: 'inherit' }, onclick: bio }, icon('fingerprint'), 'Use fingerprint') : null);
    const onKey = (e) => {
      if (!lockEl) { document.removeEventListener('keydown', onKey); return; }
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    };
    document.addEventListener('keydown', onKey);
    paint();
    if (app) app.style.visibility = 'hidden';
    document.body.appendChild(lockEl);
    if (useBio) setTimeout(bio, 300);
  });
  return lockPromise;
}
