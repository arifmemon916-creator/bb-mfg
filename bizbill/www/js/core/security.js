// PIN hashing with PBKDF2-SHA256 (WebCrypto). The PIN itself is never
// stored; only a random salt and the derived hash.

const ITERATIONS = 150000;

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(pin, saltHex, iterations) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

export function pinError(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) return 'PIN must be 4 to 8 digits';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be the same digit repeated';
  return '';
}

export async function hashPin(pin) {
  const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(pin, salt, ITERATIONS);
  return { pinHash: hash, pinSalt: salt, pinIterations: ITERATIONS };
}

export async function verifyPin(pin, sec) {
  if (!sec || !sec.pinHash || !sec.pinSalt) return false;
  const hash = await derive(pin, sec.pinSalt, sec.pinIterations || ITERATIONS);
  // Constant-time comparison.
  let diff = hash.length ^ sec.pinHash.length;
  for (let i = 0; i < hash.length && i < sec.pinHash.length; i++) diff |= hash.charCodeAt(i) ^ sec.pinHash.charCodeAt(i);
  return diff === 0;
}
