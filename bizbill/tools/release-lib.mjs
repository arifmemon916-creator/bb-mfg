// Shared helpers for release scripts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readVersion() {
  const props = Object.fromEntries(fs.readFileSync(path.join(root, 'version.properties'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }));
  const v = {
    name: props.VERSION_NAME,
    code: Number(props.VERSION_CODE),
    packageName: props.PACKAGE_NAME,
    minSupported: props.MIN_SUPPORTED_VERSION || '',
    mandatory: String(props.MANDATORY_UPDATE).toLowerCase() === 'true',
  };
  if (!/^\d+(\.\d+){0,3}$/.test(v.name)) throw new Error('VERSION_NAME is invalid');
  if (!Number.isInteger(v.code) || v.code < 1 || v.code > 2100000000) throw new Error('VERSION_CODE is invalid');
  if (v.packageName !== 'tech.bbmfg.bizbill') throw new Error('PACKAGE_NAME must be tech.bbmfg.bizbill');
  if (v.minSupported && !/^\d+(\.\d+){0,3}$/.test(v.minSupported)) throw new Error('MIN_SUPPORTED_VERSION is invalid');
  return v;
}

/** Release notes: the first "## " section of RELEASE_NOTES.md. */
export function releaseNotes() {
  const file = path.join(root, 'RELEASE_NOTES.md');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const m = /^## .*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  return m ? m[0].trim() : '';
}
