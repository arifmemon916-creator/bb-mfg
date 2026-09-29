// Business dates are stored as local calendar strings 'YYYY-MM-DD' so that
// a transaction never shifts to another day because of time zones.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toISODate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function today(now = new Date()) {
  return toISODate(now);
}

export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}

export function isValidISODate(s) {
  return parseISODate(s) !== null;
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  const da = parseISODate(a);
  const db = parseISODate(b);
  if (!da || !db) return 0;
  return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
}

export function formatDate(iso, fmt = 'DD-MM-YYYY') {
  const d = parseISODate(iso);
  if (!d) return iso || '';
  const DD = pad2(d.getDate());
  const MM = pad2(d.getMonth() + 1);
  const YYYY = String(d.getFullYear());
  switch (fmt) {
    case 'DD/MM/YYYY': return `${DD}/${MM}/${YYYY}`;
    case 'YYYY-MM-DD': return `${YYYY}-${MM}-${DD}`;
    case 'DD MMM YYYY': return `${DD} ${MONTHS[d.getMonth()]} ${YYYY}`;
    case 'MM/DD/YYYY': return `${MM}/${DD}/${YYYY}`;
    default: return `${DD}-${MM}-${YYYY}`;
  }
}

/** Accepts ISO or DD-MM-YYYY / DD/MM/YYYY input (CSV import). */
export function parseFlexibleDate(s) {
  s = String(s || '').trim();
  if (isValidISODate(s)) return s;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
    if (isValidISODate(iso)) return iso;
  }
  return '';
}

export const RANGE_PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This Week'],
  ['month', 'This Month'],
  ['lastmonth', 'Last Month'],
  ['quarter', 'This Quarter'],
  ['fy', 'This FY'],
  ['all', 'All Time'],
  ['custom', 'Custom'],
];

/** Resolve a preset to {from, to} ISO dates (inclusive). */
export function resolveRange(preset, now = new Date(), custom = {}) {
  const t = today(now);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDays(t, -1); return { from: y, to: y }; }
    case 'week': {
      const dow = (d.getDay() + 6) % 7; // Monday = 0
      const from = addDays(t, -dow);
      return { from, to: addDays(from, 6) };
    }
    case 'month': {
      const from = toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
      const to = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      return { from, to };
    }
    case 'lastmonth': {
      const from = toISODate(new Date(d.getFullYear(), d.getMonth() - 1, 1));
      const to = toISODate(new Date(d.getFullYear(), d.getMonth(), 0));
      return { from, to };
    }
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3);
      return {
        from: toISODate(new Date(d.getFullYear(), q * 3, 1)),
        to: toISODate(new Date(d.getFullYear(), q * 3 + 3, 0)),
      };
    }
    case 'fy': {
      const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
      return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
    }
    case 'custom': {
      const from = isValidISODate(custom.from) ? custom.from : t;
      const to = isValidISODate(custom.to) ? custom.to : t;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    default: return { from: '0000-01-01', to: '9999-12-31' };
  }
}

export function inRange(iso, range) {
  return !!iso && iso >= range.from && iso <= range.to;
}

export function nowStamp() {
  return new Date().toISOString();
}
