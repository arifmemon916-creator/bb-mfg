// A tiny page layout engine shared by every generated document.
//
// Documents are laid out once into a display list (text / line / rect /
// image operations in millimetres). The list is then played back either to
// jsPDF (vector PDF, for sharing & printing) or to a <canvas> (JPG image).
// This keeps PDF and JPG output identical and avoids duplicate templates.

export const A4 = { w: 210, h: 297 };

/** Text measurer backed by a jsPDF instance (Helvetica metrics). */
export function makeMeasurer(jsPDF) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  let key = '';
  return (text, size, style) => {
    const k = style + size;
    if (k !== key) {
      pdf.setFont('helvetica', style === 'bold' ? 'bold' : 'normal');
      pdf.setFontSize(size);
      key = k;
    }
    return pdf.getTextWidth(text);
  };
}

/**
 * The standard PDF fonts only cover Latin-1. Replace the rupee sign and any
 * unsupported character so that output is never garbled.
 */
export function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

export class Layout {
  constructor(measure, { width = A4.w, height = A4.h, margin = 12, continuous = false } = {}) {
    this.measure = measure;
    this.W = width;
    this.H = height;
    this.M = margin;
    this.continuous = continuous;
    this.ops = [];
    this.page = 0;
    this.pages = 1;
    this.y = margin;
    this.footerSpace = 10;
    this.onNewPage = null;
    this.font = { size: 9, style: 'normal', color: '#111111' };
  }

  get contentW() { return this.W - 2 * this.M; }
  get bottom() { return this.continuous ? Infinity : this.H - this.M - this.footerSpace; }

  setFont(size, style = 'normal', color = '#111111') {
    this.font = { size, style, color };
    return this;
  }

  width(text, size = this.font.size, style = this.font.style) {
    return this.measure(pdfSafe(text), size, style);
  }

  /** Line height in mm for a font size in pt. */
  lh(size = this.font.size) {
    return size * 0.3528 * 1.25;
  }

  text(str, x, y, opts = {}) {
    const s = pdfSafe(str);
    if (!s) return;
    this.ops.push({ t: 'text', p: this.page, s, x, y, size: opts.size || this.font.size, style: opts.style || this.font.style, color: opts.color || this.font.color, align: opts.align || 'left' });
  }

  line(x1, y1, x2, y2, w = 0.2, color = '#999999') {
    this.ops.push({ t: 'line', p: this.page, x1, y1, x2, y2, w, color });
  }

  rect(x, y, w, h, { fill = null, stroke = null, lw = 0.2 } = {}) {
    this.ops.push({ t: 'rect', p: this.page, x, y, w, h, fill, stroke, lw });
  }

  image(data, x, y, w, h) {
    if (!data) return;
    this.ops.push({ t: 'image', p: this.page, data, x, y, w, h });
  }

  newPage() {
    this.page++;
    this.pages = Math.max(this.pages, this.page + 1);
    this.y = this.M;
    if (this.onNewPage) this.onNewPage(this);
  }

  ensure(h) {
    if (this.y + h > this.bottom) this.newPage();
  }

  /** Wrap text to lines not wider than maxW. Respects explicit newlines. */
  wrap(text, maxW, size = this.font.size, style = this.font.style) {
    const out = [];
    for (const para of pdfSafe(text).split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const w of words) {
        const cand = line ? line + ' ' + w : w;
        if (this.measure(cand, size, style) <= maxW) { line = cand; continue; }
        if (line) out.push(line);
        // Break very long words.
        let word = w;
        while (this.measure(word, size, style) > maxW && word.length > 1) {
          let i = word.length - 1;
          while (i > 1 && this.measure(word.slice(0, i), size, style) > maxW) i--;
          out.push(word.slice(0, i));
          word = word.slice(i);
        }
        line = word;
      }
      if (line) out.push(line);
    }
    return out;
  }

  /** Draw wrapped paragraph at current y, advancing y (with page breaks). */
  paragraph(text, x, maxW, opts = {}) {
    const size = opts.size || this.font.size;
    const style = opts.style || this.font.style;
    const lines = this.wrap(text, maxW, size, style);
    const lh = this.lh(size);
    for (const l of lines) {
      this.ensure(lh);
      this.y += lh * 0.8;
      this.text(l, x, this.y, { size, style, color: opts.color, align: opts.align });
      this.y += lh * 0.2;
    }
    return lines.length;
  }

  /**
   * Draw a table with header repetition and page breaks.
   * columns: [{label, w, align}] (w in mm; one column may have w: 0 = flexible)
   * rows: [[cellText...]] or [{cells, style, fill}]
   */
  table(columns, rows, opts = {}) {
    const x0 = opts.x ?? this.M;
    const totalW = opts.width ?? this.contentW;
    const fixed = columns.reduce((a, c) => a + (c.w || 0), 0);
    const flexCount = columns.filter((c) => !c.w).length || 1;
    const widths = columns.map((c) => c.w || Math.max(10, (totalW - fixed) / flexCount));
    const size = opts.size || 8;
    const pad = 1.2;
    const lh = this.lh(size);
    const headFill = opts.headFill || '#1f4e79';
    const drawHead = () => {
      const hh = lh + 2 * pad;
      this.ensure(hh + lh);
      this.rect(x0, this.y, totalW, hh, { fill: headFill });
      let x = x0;
      columns.forEach((c, i) => {
        const tx = c.align === 'right' ? x + widths[i] - pad : c.align === 'center' ? x + widths[i] / 2 : x + pad;
        this.text(c.label, tx, this.y + pad + lh * 0.75, { size, style: 'bold', color: '#ffffff', align: c.align || 'left' });
        x += widths[i];
      });
      this.y += hh;
    };
    drawHead();
    rows.forEach((row, ri) => {
      const cells = Array.isArray(row) ? row : row.cells;
      const style = (!Array.isArray(row) && row.style) || 'normal';
      const wrapped = cells.map((c, i) => (columns[i].wrap === false ? [pdfSafe(c)] : this.wrap(c == null ? '' : String(c), widths[i] - 2 * pad, size, style)));
      const nLines = Math.max(1, ...wrapped.map((w) => w.length));
      const rh = nLines * lh + 2 * pad;
      if (this.y + rh > this.bottom) { this.newPage(); drawHead(); }
      const fill = (!Array.isArray(row) && row.fill) || (opts.zebra !== false && ri % 2 ? '#f3f6fa' : null);
      if (fill) this.rect(x0, this.y, totalW, rh, { fill });
      let x = x0;
      wrapped.forEach((lines, i) => {
        const c = columns[i];
        lines.forEach((l, li) => {
          const tx = c.align === 'right' ? x + widths[i] - pad : c.align === 'center' ? x + widths[i] / 2 : x + pad;
          this.text(l, tx, this.y + pad + lh * (li + 0.75), { size, style, align: c.align || 'left' });
        });
        x += widths[i];
      });
      this.y += rh;
      this.line(x0, this.y, x0 + totalW, this.y, 0.1, '#d0d7e1');
    });
    return widths;
  }

  finalize() {
    if (this.continuous) this.H = this.y + this.M;
    return this;
  }
}

// ---------------------------------------------------------------- output

function hexToRgb(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function imgFormat(data) {
  return /^data:image\/png/i.test(data) ? 'PNG' : 'JPEG';
}

/** Play a layout into a jsPDF document and return it. */
export function toPdf(layout, jsPDF, meta = {}) {
  const pdf = new jsPDF({ unit: 'mm', format: [layout.W, layout.H], orientation: layout.W > layout.H ? 'l' : 'p', compress: true });
  pdf.setProperties({ title: pdfSafe(meta.title || 'Document'), creator: 'BizBill', author: pdfSafe(meta.author || '') });
  for (let i = 1; i < layout.pages; i++) pdf.addPage([layout.W, layout.H], layout.W > layout.H ? 'l' : 'p');
  let cur = -1;
  for (const o of layout.ops) {
    if (o.p !== cur) { pdf.setPage(o.p + 1); cur = o.p; }
    if (o.t === 'text') {
      pdf.setFont('helvetica', o.style === 'bold' ? 'bold' : 'normal');
      pdf.setFontSize(o.size);
      pdf.setTextColor(...hexToRgb(o.color));
      pdf.text(o.s, o.x, o.y, { align: o.align, baseline: 'alphabetic' });
    } else if (o.t === 'line') {
      pdf.setDrawColor(...hexToRgb(o.color));
      pdf.setLineWidth(o.w);
      pdf.line(o.x1, o.y1, o.x2, o.y2);
    } else if (o.t === 'rect') {
      if (o.fill) pdf.setFillColor(...hexToRgb(o.fill));
      if (o.stroke) { pdf.setDrawColor(...hexToRgb(o.stroke)); pdf.setLineWidth(o.lw); }
      pdf.rect(o.x, o.y, o.w, o.h, o.fill && o.stroke ? 'FD' : o.fill ? 'F' : 'S');
    } else if (o.t === 'image') {
      try { pdf.addImage(o.data, imgFormat(o.data), o.x, o.y, o.w, o.h, undefined, 'FAST'); } catch (e) { console.warn('image skipped', e); }
    }
  }
  return pdf;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Render a continuous layout onto a canvas and return a JPEG Blob. */
export async function toJpeg(layout, { pxPerMm = 6, quality = 0.9 } = {}) {
  const canvas = document.createElement('canvas');
  const pageOffsets = [];
  for (let i = 0; i < layout.pages; i++) pageOffsets.push(i * layout.H);
  const totalH = layout.H * layout.pages;
  canvas.width = Math.round(layout.W * pxPerMm);
  canvas.height = Math.round(totalH * pxPerMm);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(pxPerMm, pxPerMm);
  const images = new Map();
  for (const o of layout.ops) if (o.t === 'image' && !images.has(o.data)) images.set(o.data, await loadImage(o.data));
  for (const o of layout.ops) {
    const oy = pageOffsets[o.p] || 0;
    if (o.t === 'text') {
      ctx.fillStyle = o.color;
      ctx.font = `${o.style === 'bold' ? 'bold ' : ''}${o.size * 0.3528}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = o.align === 'right' ? 'right' : o.align === 'center' ? 'center' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.s, o.x, o.y + oy);
    } else if (o.t === 'line') {
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.w;
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y1 + oy);
      ctx.lineTo(o.x2, o.y2 + oy);
      ctx.stroke();
    } else if (o.t === 'rect') {
      if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(o.x, o.y + oy, o.w, o.h); }
      if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.lw; ctx.strokeRect(o.x, o.y + oy, o.w, o.h); }
    } else if (o.t === 'image') {
      const img = images.get(o.data);
      if (img) ctx.drawImage(img, o.x, o.y + oy, o.w, o.h);
    }
  }
  // Page separators for multi-page layouts.
  for (let i = 1; i < layout.pages; i++) {
    ctx.strokeStyle = '#cccccc';
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(0, i * layout.H);
    ctx.lineTo(layout.W, i * layout.H);
    ctx.stroke();
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}
