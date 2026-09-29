// Minimal DOM helpers. User data is always inserted as text nodes, never
// as HTML, so names / notes cannot inject markup or script.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Append children, skipping null/false (unlike Element.append, which prints "null"). */
export function put(el, ...children) {
  return append(el, children);
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

const ICONS = {
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  sales: 'M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2z M9 7h6 M9 11h6 M9 15h4',
  purchase: 'M3 3h2l2.4 12.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 7H6 M8 20.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M17 20.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  box: 'M21 8l-9-5-9 5 9 5 9-5z M3 8v8l9 5 9-5V8 M12 13v8',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4 M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z M16 14h.01',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  truck: 'M1 4h14v12H1z M15 9h4l3 3v4h-7 M4 18.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0 M17 18.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z M7 7h.01',
  quote: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
  expense: 'M2 6h20v12H2z M2 10h20 M6 15h4',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  percent: 'M19 5L5 19 M4 6.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0 M15 17.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3',
  upload: 'M12 21V9 M7 14l5-5 5 5 M4 7V4h16v3',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8 M21 3v5h-5',
  info: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0 M12 16v-4 M12 8h.01',
  search: 'M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M21 21l-4.3-4.3',
  plus: 'M12 5v14 M5 12h14',
  back: 'M19 12H5 M12 19l-7-7 7-7',
  close: 'M18 6L6 18 M6 6l12 12',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18 M8 6V4h8v2 M19 6l-1 14H6L5 6',
  share: 'M15 5a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M15 19a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4',
  print: 'M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z',
  image: 'M3 3h18v18H3z M7 8.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0 M21 15l-5-5L5 21',
  whatsapp: 'M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z',
  mail: 'M3 5h18v14H3z M21 6l-9 7-9-7',
  check: 'M20 6L9 17l-5-5',
  ban: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0 M4.9 4.9l14.2 14.2',
  alert: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  calendar: 'M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18',
  trend: 'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  clock: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0 M12 6v6l4 2',
  rupee: 'M6 3h12 M6 8h12 M6 13l8.5 8 M6 13h3 M9 13a5 5 0 0 0 0-10',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M7 8v8 M11 8v8 M15 8v8 M18 8v8',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  in: 'M17 7L7 17 M17 17H7V7',
  out: 'M7 17L17 7 M7 7h10v10',
  copy: 'M9 9h13v13H9z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  dots: 'M12 5h.01 M12 12h.01 M12 19h.01',
  help: 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0 M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3 M12 17h.01',
  maximize: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  convert: 'M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  fingerprint: 'M12 11v3a8 8 0 0 1-2 5 M8 15a14 14 0 0 0 .5-4 3.5 3.5 0 0 1 7 0c0 1 0 2-.2 3 M5 17a15 15 0 0 0 .5-6 6.5 6.5 0 0 1 13 0 M17 20c.5-1.5 1-3 1-5',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  svg.appendChild(path);
  return svg;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
