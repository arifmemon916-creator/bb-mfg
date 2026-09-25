// Default settings. Stored as one record {key: 'app', ...} in the
// `settings` store and deep-merged over these defaults on load, so new
// settings added in later versions get sensible values automatically.

export const DOC_KINDS = {
  sale: { label: 'Tax Invoice', short: 'Invoice', party: 'customer' },
  purchase: { label: 'Purchase', short: 'Purchase', party: 'supplier' },
  quotation: { label: 'Quotation', short: 'Quotation', party: 'customer' },
};

// 'Bank' is the stored value for bank transfers (kept for existing records).
export const PAYMENT_METHODS = ['Cash', 'UPI', 'Bank', 'Card', 'Cheque', 'Other', 'Credit'];
export const METHOD_LABELS = { Bank: 'Bank Transfer' };
/** Method-specific reference fields shown on payment entry. */
export const METHOD_FIELDS = {
  UPI: [['reference', 'UPI Reference ID']],
  Bank: [['reference', 'Transaction ID']],
  Card: [['reference', 'Card transaction / approval no.']],
  Cheque: [['reference', 'Cheque Number'], ['chequeBank', 'Bank Name']],
  Other: [['reference', 'Reference']],
  Cash: [],
};
export const REMINDER_OFFSETS = [[0, 'On due date'], [1, '1 day before'], [3, '3 days before'], [7, '7 days before']];
export const EXPENSE_CATEGORIES = ['Rent', 'Salary', 'Electricity', 'Transport', 'Maintenance', 'Packaging', 'Marketing', 'Other'];
export const UNITS = ['PCS', 'NOS', 'BOX', 'KG', 'GM', 'LTR', 'ML', 'MTR', 'CM', 'FT', 'SQFT', 'DOZ', 'PKT', 'SET', 'PAIR', 'BAG', 'ROLL', 'BTL', 'CAN', 'HRS', 'DAYS', 'JOB'];
export const DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'MM/DD/YYYY'];

export const DASHBOARD_CARDS = [
  ['sales', 'Sales'],
  ['purchases', 'Purchases'],
  ['expenses', 'Expenses'],
  ['collection', 'Collection'],
  ['receivable', 'To Receive'],
  ['payable', 'To Pay'],
  ['gst', 'GST Summary'],
  ['profit', 'Net Profit'],
  ['customers', 'Customers'],
  ['suppliers', 'Suppliers'],
  ['products', 'Products'],
  ['lowstock', 'Low Stock'],
  ['duetoday', 'Due Today'],
  ['overdue', 'Overdue'],
  ['paidtoday', 'Paid Today'],
];

export const NAV_TABS = [
  ['dashboard', 'Home'],
  ['sales', 'Sales'],
  ['purchases', 'Purchase'],
  ['inventory', 'Stock'],
  ['payments', 'Payments'],
  ['reports', 'Reports'],
  ['customers', 'Customers'],
  ['products', 'Products'],
  ['expenses', 'Expenses'],
  ['quotations', 'Quotes'],
];

export function defaultSettings() {
  return {
    key: 'app',
    company: {
      name: '',
      logo: '', // data URL (JPEG/PNG), kept small
      address: '',
      city: '',
      state: '',
      stateCode: '',
      pincode: '',
      mobile: '',
      email: '',
      gstin: '',
      pan: '',
      bankName: '',
      bankAccount: '',
      bankIfsc: '',
      bankBranch: '',
      upiId: '',
      terms: '1. Goods once sold will not be taken back.\n2. Interest @18% p.a. will be charged if payment is not made within the due date.\n3. Subject to local jurisdiction.',
      footer: 'Thank you for your business!',
      signatory: 'Authorised Signatory',
    },
    numbering: {
      sale: { prefix: 'INV-', next: 1, pad: 4 },
      purchase: { prefix: 'PUR-', next: 1, pad: 4 },
      quotation: { prefix: 'QT-', next: 1, pad: 4 },
      receipt: { prefix: 'RCT-', next: 1, pad: 4 },
      voucher: { prefix: 'PAY-', next: 1, pad: 4 },
    },
    billing: {
      gstEnabled: true,
      inclusive: false,
      defaultGst: 18,
      chargesGst: 0,
      roundOff: true,
      qtyDecimals: 2,
      defaultPaymentMethod: 'Cash',
      defaultUnit: 'PCS',
      currencySymbol: '₹',
      currencyName: 'Rupees',
      currencySubunit: 'Paise',
      grouping: 'indian',
      dateFormat: 'DD-MM-YYYY',
      allowNegativeStock: true,
      updatePurchasePrice: true,
      invoiceCopies: 'ORIGINAL FOR RECIPIENT',
      showHsnSummary: true,
      showProductImage: false,
      paperSize: 'a4',
      dueDays: 0,
    },
    ui: {
      theme: 'system', // light | dark | system
      fullscreen: false,
      dashboardCards: DASHBOARD_CARDS.map(([k]) => k),
      navTabs: ['dashboard', 'sales', 'purchases', 'inventory', 'payments'],
      dashboardRange: 'today',
    },
    security: {
      enabled: false,
      pinHash: '',
      pinSalt: '',
      pinIterations: 0,
      biometric: false,
      lockOnStart: true,
      autoLockMinutes: 5, // lock when app was in background longer than this
      inactivityMinutes: 0, // 0 = off
      secureScreen: false, // hide content in recent apps / block screenshots
    },
    notifications: {
      enabled: false,
      lowStock: true,
      outstanding: true,
      paymentDue: true,
      overdue: true,
      backupReminder: true,
      backupReminderDays: 7,
      updates: true,
      fullScreen: false, // full-screen alerts for due/overdue payments (user opt-in)
      fullScreenLowStock: false,
      sound: true,
      vibration: true,
      time: '09:00', // time of day for scheduled reminders
      reminderOffsets: [0, 1, 3], // days before due date
      snoozeMinutes: 60,
      permissionAsked: false,
    },
    backup: {
      auto: false,
      frequency: 'daily', // daily | weekly
      keep: 7,
      lastBackupAt: '',
      lastAutoBackupAt: '',
    },
    update: {
      autoCheck: true, // downloads release metadata only; no business data is sent
      url: 'https://github.com/arifmemon916-creator/bb-mfg/releases/latest/download/update.json',
      dismissedVersionCode: 0,
      lastCheckedAt: '',
    },
  };
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function mergeSettings(stored) {
  return deepMerge(defaultSettings(), stored || {});
}

export function formatDocNumber(cfg) {
  return (cfg.prefix || '') + String(cfg.next).padStart(cfg.pad || 1, '0');
}
