// Generate / share / print documents. jsPDF (~400 KB) is loaded lazily the
// first time a document is produced, keeping app start-up fast.

import { Layout, makeMeasurer, toPdf, toJpeg } from './layout.js';
import { renderInvoice, renderReceipt, renderLedger, renderReport, renderReminderCard } from './templates.js';
import { shareFile, printPdf, saveFile } from '../platform/bridge.js';
import { chooseDialog, toast, errorToast } from '../ui/components.js';
import { formatMoney } from '../core/money.js';
import { formatDate } from '../core/dates.js';

let jsPDFPromise = null;
let measurer = null;

export function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!jsPDFPromise) {
    jsPDFPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => { jsPDFPromise = null; reject(new Error('PDF engine failed to load')); };
      document.head.appendChild(s);
    });
  }
  return jsPDFPromise;
}

async function newLayout(opts = {}) {
  const jsPDF = await loadJsPDF();
  if (!measurer) measurer = makeMeasurer(jsPDF);
  return { L: new Layout(measurer, opts), jsPDF };
}

const safeName = (s) => String(s || 'document').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'document';

/**
 * A "spec" describes a document: {kind, title, fileBase, render(L), phone, email, shareText}
 */
export async function buildPdf(spec) {
  const { L, jsPDF } = await newLayout(spec.layout || {});
  spec.render(L);
  const pdf = toPdf(L, jsPDF, { title: spec.title, author: spec.author });
  return new Blob([pdf.output('arraybuffer')], { type: 'application/pdf' });
}

export async function buildJpg(spec) {
  const { L } = await newLayout({ ...(spec.layout || {}), continuous: true });
  spec.render(L);
  return toJpeg(L);
}

// ---------------------------------------------------------------- specs

export function invoiceSpec(store, doc) {
  const kindName = { sale: 'Invoice', purchase: 'Purchase', quotation: 'Quotation' }[doc.kind];
  const due = store.docDue(doc);
  const paid = doc.kind === 'quotation' ? null : doc.totals.grandTotal - due;
  const s = store.settings;
  const money = (p) => formatMoney(p, { symbol: s.billing.currencySymbol, grouping: s.billing.grouping });
  const party = doc.partyId ? store.parties.get(doc.partyId) : null;
  const lines = [
    `${kindName} ${doc.number} dated ${formatDate(doc.date, s.billing.dateFormat)}`,
    `Amount: ${money(doc.totals.grandTotal)}`,
  ];
  if (doc.kind === 'sale' && due > 0) lines.push(`Balance due: ${money(due)}`);
  if (doc.kind === 'sale' && s.company.upiId && due > 0) lines.push(`Pay via UPI: ${s.company.upiId}`);
  lines.push('', `– ${s.company.name || 'BizBill'}`);
  return {
    title: `${kindName} ${doc.number}`,
    fileBase: safeName(`${kindName}_${doc.number}`),
    author: s.company.name,
    phone: (party && (party.whatsapp || party.mobile)) || doc.party.mobile || '',
    email: (party && party.email) || '',
    shareText: lines.join('\n'),
    render: (L) => renderInvoice(L, doc, s, { paid, due, status: store.docStatus(doc), thumbs: productThumbs(store, doc) }),
  };
}

export function receiptSpec(store, pay) {
  const s = store.settings;
  const docs = (pay.allocations || []).map((a) => ({ doc: store.documents.get(a.docId), amount: a.amount })).filter((x) => x.doc);
  const party = store.parties.get(pay.partyId);
  const money = (p) => formatMoney(p, { symbol: s.billing.currencySymbol, grouping: s.billing.grouping });
  return {
    title: `${pay.direction === 'in' ? 'Receipt' : 'Payment'} ${pay.number}`,
    fileBase: safeName(`${pay.direction === 'in' ? 'Receipt' : 'Payment'}_${pay.number}`),
    author: s.company.name,
    phone: party ? party.whatsapp || party.mobile : '',
    email: party ? party.email : '',
    shareText: `${pay.direction === 'in' ? 'Payment received' : 'Payment made'}: ${money(pay.amount)} (${pay.method}) on ${formatDate(pay.date, s.billing.dateFormat)}. Ref ${pay.number}.\n– ${s.company.name || 'BizBill'}`,
    render: (L) => renderReceipt(L, pay, s, docs),
  };
}

export function ledgerSpec(store, party, statement, range) {
  const s = store.settings;
  const money = (p) => formatMoney(Math.abs(p), { symbol: s.billing.currencySymbol, grouping: s.billing.grouping });
  return {
    title: `Ledger ${party.name}`,
    fileBase: safeName(`Ledger_${party.name}`),
    author: s.company.name,
    phone: party.whatsapp || party.mobile,
    email: party.email,
    shareText: `Account statement for ${party.name}. Closing balance: ${money(statement.closing)} ${statement.closing ? (((statement.closing > 0) !== statement.isSupplier) ? 'Dr' : 'Cr') : ''}\n– ${s.company.name || 'BizBill'}`,
    render: (L) => renderLedger(L, party, statement, s, range),
  };
}

export function reportSpec(store, title, rangeLabel, report) {
  const s = store.settings;
  const wide = report.columns.length > 7;
  return {
    title,
    fileBase: safeName(`${title}_${rangeLabel}`),
    author: s.company.name,
    shareText: `${title} (${rangeLabel}) – ${s.company.name || 'BizBill'}`,
    layout: wide ? { width: 297, height: 210 } : {},
    render: (L) => renderReport(L, title, rangeLabel, report, s),
  };
}

// ---------------------------------------------------------------- actions

export async function runDocAction(spec, action) {
  try {
    toast('Preparing document…');
    if (action === 'jpg' || action === 'jpg-whatsapp') {
      const blob = await buildJpg(spec);
      const r = await shareFile(blob, spec.fileBase + '.jpg', { text: spec.shareText, subject: spec.title, target: action === 'jpg-whatsapp' ? 'whatsapp' : '', phone: spec.phone });
      return report(r);
    }
    const pdf = await buildPdf(spec);
    const name = spec.fileBase + '.pdf';
    let r;
    switch (action) {
      case 'print': r = await printPdf(pdf, name); break;
      case 'save': r = await saveFile(pdf, name); break;
      case 'whatsapp': r = await shareFile(pdf, name, { text: spec.shareText, subject: spec.title, target: 'whatsapp', phone: spec.phone }); break;
      case 'email': r = await shareFile(pdf, name, { text: spec.shareText, subject: spec.title, target: 'email', phone: spec.email }); break;
      default: r = await shareFile(pdf, name, { text: spec.shareText, subject: spec.title });
    }
    return report(r);
  } catch (e) {
    errorToast(e);
    return { ok: false };
  }
}

function report(r) {
  if (r && r.downloaded) toast('File downloaded');
  else if (r && r.saved) toast('Saved', 'good');
  else if (r && r.ok === false && r.error && !r.cancelled) toast(r.error, 'bad');
  return r;
}

export async function shareMenu(spec, { jpg = true } = {}) {
  const options = [
    { value: 'whatsapp', label: 'WhatsApp (PDF)', icon: 'whatsapp' },
    jpg ? { value: 'jpg-whatsapp', label: 'WhatsApp (Image)', icon: 'image' } : null,
    { value: 'email', label: 'Email (PDF)', icon: 'mail' },
    { value: 'share', label: 'Other apps (PDF)', icon: 'share' },
    jpg ? { value: 'jpg', label: 'Share as JPG image', icon: 'image' } : null,
    { value: 'print', label: 'Print', icon: 'print' },
    { value: 'save', label: 'Save PDF to device', icon: 'download' },
  ].filter(Boolean);
  const action = await chooseDialog('Share / Print', options);
  if (action) await runDocAction(spec, action);
}

/** Open the PDF in a viewer (browser) or share sheet (Android). */
export async function previewPdf(spec) {
  try {
    const pdf = await buildPdf(spec);
    if (window.BizBillNative) {
      await shareFile(pdf, spec.fileBase + '.pdf', { subject: spec.title, target: 'view' });
    } else {
      const url = URL.createObjectURL(pdf);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  } catch (e) {
    errorToast(e);
  }
}

/** Payment reminder card for an invoice (uses the CURRENT outstanding amount). */
export function reminderCardSpec(store, doc) {
  const s = store.settings;
  const due = store.docDue(doc);
  const party = doc.partyId ? store.parties.get(doc.partyId) : null;
  const today = new Date();
  const t = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const overdueDays = doc.dueDate && doc.dueDate < t ? Math.round((new Date(t) - new Date(doc.dueDate)) / 86400000) : 0;
  const money = (p) => formatMoney(p, { symbol: s.billing.currencySymbol, grouping: s.billing.grouping });
  const data = { amount: due, total: doc.totals.grandTotal, dueDate: doc.dueDate, partyName: doc.party.name, invoiceNo: doc.number, overdueDays };
  return {
    title: 'Payment Reminder ' + doc.number,
    fileBase: safeName('Reminder_' + doc.number),
    author: s.company.name,
    phone: (party && (party.whatsapp || party.mobile)) || doc.party.mobile || '',
    email: (party && party.email) || '',
    shareText: `Dear ${doc.party.name},\nThis is a reminder that ${money(due)} is ${overdueDays ? `overdue by ${overdueDays} day(s)` : 'due'}${doc.dueDate ? ' (due ' + formatDate(doc.dueDate, s.billing.dateFormat) + ')' : ''} against invoice ${doc.number}.${s.company.upiId ? '\nUPI: ' + s.company.upiId : ''}\nThank you.\n– ${s.company.name || ''}`,
    layout: { width: 100, height: 120, margin: 0 },
    render: (L) => renderReminderCard(L, data, s),
  };
}

/** Reminder card for a party's total outstanding balance. */
export function partyReminderSpec(store, party) {
  const s = store.settings;
  const bal = store.account(party.id).balance;
  const money = (p) => formatMoney(p, { symbol: s.billing.currencySymbol, grouping: s.billing.grouping });
  return {
    title: 'Payment Reminder ' + party.name,
    fileBase: safeName('Reminder_' + party.name),
    author: s.company.name,
    phone: party.whatsapp || party.mobile || '',
    email: party.email || '',
    shareText: `Dear ${party.name},\nA balance of ${money(bal)} is outstanding on your account.${s.company.upiId ? '\nUPI: ' + s.company.upiId : ''}\nThank you.\n– ${s.company.name || ''}`,
    layout: { width: 100, height: 120, margin: 0 },
    render: (L) => renderReminderCard(L, { amount: bal, partyName: party.name, invoiceNo: 'All outstanding bills', overdueDays: 0 }, s),
  };
}

function productThumbs(store, doc) {
  if (!store.settings.billing.showProductImage) return null;
  const out = {};
  for (const it of doc.items) {
    const p = it.productId && store.products.get(it.productId);
    if (p && p.thumb) out[p.id] = p.thumb;
  }
  return out;
}
