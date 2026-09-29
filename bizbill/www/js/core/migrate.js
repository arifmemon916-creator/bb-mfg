// Data-shape migrations, applied both to the live database (on app upgrade)
// and to older backup files (on restore). Each step takes the full data
// object {storeName: records[]} for version N-1 and returns version N.
//
// Rules: never delete a step, never change a released step, always keep old
// records readable. Test every new step in tests/migrate.test.mjs.

export const DATA_VERSION = 2;

const STEPS = {
  // 1: initial format. Normalises records created by pre-release builds
  //    (missing arrays / statuses) so later code can rely on them.
  1: (data) => {
    for (const d of data.documents || []) {
      d.items = Array.isArray(d.items) ? d.items : [];
      d.status = d.status || 'active';
      d.transport = d.transport || {};
    }
    for (const p of data.payments || []) {
      p.allocations = Array.isArray(p.allocations) ? p.allocations : [];
      p.status = p.status || 'active';
    }
    for (const e of data.expenses || []) e.status = e.status || 'active';
    for (const p of data.products || []) if (p.trackStock == null) p.trackStock = true;
    return data;
  },
  // 2: notification center, product images, payment attachments.
  2: (data) => {
    for (const p of data.products || []) if (p.lowStockAlert == null) p.lowStockAlert = true;
    for (const p of data.payments || []) p.attachments = Array.isArray(p.attachments) ? p.attachments : [];
    data.notifications = Array.isArray(data.notifications) ? data.notifications : [];
    for (const s of data.settings || []) {
      if (s.key !== 'app' || !s.ui || !Array.isArray(s.ui.dashboardCards)) continue;
      for (const k of ['duetoday', 'overdue', 'paidtoday']) if (!s.ui.dashboardCards.includes(k)) s.ui.dashboardCards.push(k);
    }
    return data;
  },
};

export function migrateData(data, fromVersion) {
  let out = data;
  for (let v = (fromVersion || 0) + 1; v <= DATA_VERSION; v++) {
    const step = STEPS[v];
    if (step) out = step(out);
  }
  return out;
}
