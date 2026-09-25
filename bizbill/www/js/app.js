// BizBill application shell: boot, routing, navigation, theme, app lock,
// lifecycle (auto backup, reminders) and Android back-button handling.

import { BizStore } from './core/store.js';
import { h, icon, clear, append } from './ui/dom.js';
import { toast, errorToast, closeTopSheet, confirmDialog } from './ui/components.js';
import { NAV_TABS } from './core/settings.js';
import * as bridge from './platform/bridge.js';
import { showLock, isLocked } from './views/lock.js';
import { runHousekeeping } from './services/housekeeping.js';

// Route table: pattern -> lazily imported view module + export name.
const ROUTES = [
  ['dashboard', () => import('./views/dashboard.js'), 'dashboard'],
  ['sales', () => import('./views/documents.js'), 'saleList'],
  ['purchases', () => import('./views/documents.js'), 'purchaseList'],
  ['quotations', () => import('./views/documents.js'), 'quotationList'],
  ['doc/new/:kind', () => import('./views/documents.js'), 'docForm'],
  ['doc/:id/edit', () => import('./views/documents.js'), 'docForm'],
  ['doc/:id', () => import('./views/documents.js'), 'docView'],
  ['customers', () => import('./views/parties.js'), 'customerList'],
  ['suppliers', () => import('./views/parties.js'), 'supplierList'],
  ['party/new/:type', () => import('./views/parties.js'), 'partyForm'],
  ['party/:id/edit', () => import('./views/parties.js'), 'partyForm'],
  ['party/:id/ledger', () => import('./views/parties.js'), 'partyLedger'],
  ['party/:id', () => import('./views/parties.js'), 'partyView'],
  ['ledger', () => import('./views/parties.js'), 'ledgerHub'],
  ['products', () => import('./views/products.js'), 'productList'],
  ['product/new', () => import('./views/products.js'), 'productForm'],
  ['product/:id/edit', () => import('./views/products.js'), 'productForm'],
  ['product/:id', () => import('./views/products.js'), 'productView'],
  ['inventory', () => import('./views/products.js'), 'inventory'],
  ['payments', () => import('./views/payments.js'), 'paymentList'],
  ['payment/new/:dir', () => import('./views/payments.js'), 'paymentForm'],
  ['payment/:id/edit', () => import('./views/payments.js'), 'paymentForm'],
  ['payment/:id', () => import('./views/payments.js'), 'paymentView'],
  ['receivables', () => import('./views/payments.js'), 'receivables'],
  ['payables', () => import('./views/payments.js'), 'payables'],
  ['expenses', () => import('./views/expenses.js'), 'expenseList'],
  ['expense/new', () => import('./views/expenses.js'), 'expenseForm'],
  ['expense/:id', () => import('./views/expenses.js'), 'expenseForm'],
  ['reports', () => import('./views/reports.js'), 'reportHub'],
  ['report/:id', () => import('./views/reports.js'), 'reportView'],
  ['gst', () => import('./views/reports.js'), 'gstView'],
  ['pl', () => import('./views/reports.js'), 'plView'],
  ['more', () => import('./views/more.js'), 'more'],
  ['search', () => import('./views/more.js'), 'search'],
  ['settings', () => import('./views/settings.js'), 'settingsHub'],
  ['settings/company', () => import('./views/settings.js'), 'companySettings'],
  ['settings/billing', () => import('./views/settings.js'), 'billingSettings'],
  ['settings/appearance', () => import('./views/settings.js'), 'appearanceSettings'],
  ['settings/security', () => import('./views/settings.js'), 'securitySettings'],
  ['settings/notifications', () => import('./views/settings.js'), 'notificationSettings'],
  ['backup', () => import('./views/data.js'), 'backupView'],
  ['import', () => import('./views/data.js'), 'importExport'],
  ['audit', () => import('./views/data.js'), 'auditView'],
  ['recycle', () => import('./views/data.js'), 'recycleBin'],
  ['update', () => import('./views/more.js'), 'updateCenter'],
  ['about', () => import('./views/more.js'), 'about'],
];

const NAV_ICONS = {
  dashboard: 'home', sales: 'sales', purchases: 'purchase', inventory: 'box', payments: 'wallet', reports: 'chart',
  customers: 'users', products: 'tag', expenses: 'expense', quotations: 'quote',
};

function matchRoute(path) {
  const parts = path.split('/').filter(Boolean);
  for (const [pattern, loader, name] of ROUTES) {
    const pp = pattern.split('/');
    if (pp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { loader, name, params, pattern };
  }
  return null;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

class App {
  constructor() {
    this.root = document.getElementById('app');
    this.current = null;
    this.lastHash = '';
    this.ignoreHash = false;
    this.renderSeq = 0;
  }

  async boot() {
    try {
      this.store = await new BizStore().init();
    } catch (e) {
      console.error(e);
      replaceRoot(this.root, h('div', { class: 'boot' }, h('div', { class: 'boot-logo' }, '!'),
        h('p', null, 'BizBill could not open its database.'), h('p', { class: 'small' }, String(e.message || e))));
      return;
    }
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    bridge.setFullscreen(this.store.settings.ui.fullscreen);
    bridge.setSecureScreen(this.store.settings.security.enabled && this.store.settings.security.secureScreen);

    window.addEventListener('hashchange', () => this.onHashChange());
    window.BizBillBridge.onBack = () => this.handleBack();
    window.BizBillBridge.onLifecycle = (state) => this.onLifecycle(state);
    document.addEventListener('visibilitychange', () => this.onLifecycle(document.hidden ? 'pause' : 'resume'));
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { this.lastActivity = Date.now(); }, { passive: true }));
    this.lastActivity = Date.now();
    setInterval(() => this.checkInactivity(), 15000);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopSheet();
    });

    const sec = this.store.settings.security;
    if (sec.enabled && sec.lockOnStart) await showLock(this.store);
    await this.render();
    setTimeout(() => runHousekeeping(this.store, 'start').catch((e) => console.warn(e)), 1500);
    this.registerServiceWorker();
  }

  registerServiceWorker() {
    if (bridge.isAndroidApp || !('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }

  applyTheme() {
    const pref = this.store.settings.ui.theme;
    const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    bridge.setSystemBars(dark ? '#182028' : '#1f4e79', dark);
  }

  // ------------------------------------------------------------ lifecycle

  onLifecycle(state) {
    if (state === 'pause') {
      this.pausedAt = Date.now();
    } else if (state === 'resume') {
      const sec = this.store.settings.security;
      if (sec.enabled && this.pausedAt && !isLocked()) {
        const away = (Date.now() - this.pausedAt) / 60000;
        if (away >= (sec.autoLockMinutes || 0)) showLock(this.store);
      }
      this.pausedAt = 0;
      runHousekeeping(this.store, 'resume').catch((e) => console.warn(e));
    }
  }

  checkInactivity() {
    const sec = this.store.settings.security;
    if (!sec.enabled || !sec.inactivityMinutes || isLocked()) return;
    if (Date.now() - this.lastActivity > sec.inactivityMinutes * 60000) showLock(this.store);
  }

  // ------------------------------------------------------------ navigation

  navigate(hash, { replace = false } = {}) {
    if (!hash.startsWith('#')) hash = '#/' + hash.replace(/^\//, '');
    if (replace) {
      history.replaceState(null, '', hash);
      this.render();
    } else if (location.hash === hash) {
      this.render();
    } else {
      location.hash = hash;
    }
  }

  async back() {
    if (!(await this.confirmLeave())) return;
    this.skipGuardOnce = true;
    if (history.length > 1 && this.lastHash) history.back();
    else this.navigate('#/dashboard', { replace: true });
  }

  async confirmLeave() {
    if (this.current && this.current.dirty && this.current.dirty()) {
      return confirmDialog({ title: 'Discard changes?', message: 'You have unsaved changes on this screen.', confirmText: 'Discard', danger: true });
    }
    return true;
  }

  async onHashChange() {
    if (this.ignoreHash) { this.ignoreHash = false; return; }
    if (!this.skipGuardOnce && this.current && this.current.dirty && this.current.dirty()) {
      const target = location.hash;
      const leave = await this.confirmLeave();
      if (!leave) {
        this.ignoreHash = true;
        history.replaceState(null, '', this.lastHash);
        return;
      }
      if (location.hash !== target) return;
    }
    this.skipGuardOnce = false;
    this.render();
  }

  /** Android hardware back. Return true when handled inside the app. */
  handleBack() {
    if (isLocked()) return false;
    if (closeTopSheet()) return true;
    const { path } = parseHash();
    const tabs = this.store.settings.ui.navTabs;
    if (path === 'dashboard') return false; // let Android move the app to background
    if (tabs.includes(path) || path === 'more') {
      this.navigate('#/dashboard');
      return true;
    }
    this.back();
    return true;
  }

  refresh() {
    return this.render({ keepScroll: true });
  }

  async render({ keepScroll = false } = {}) {
    const seq = ++this.renderSeq;
    const { path, query } = parseHash();
    const route = matchRoute(path);
    const scroll = keepScroll ? window.scrollY : 0;
    if (!route) { this.navigate('#/dashboard', { replace: true }); return; }
    let view;
    try {
      const mod = await route.loader();
      if (seq !== this.renderSeq) return;
      view = await mod[route.name]({ store: this.store, app: this }, route.params, query);
    } catch (e) {
      errorToast(e);
      view = { title: 'Error', content: h('div', { class: 'card' }, h('p', null, 'This screen could not be opened.'), h('p', { class: 'small muted' }, String(e.message || e))), back: true };
    }
    if (seq !== this.renderSeq) return;
    if (this.current && this.current.onLeave) try { this.current.onLeave(); } catch { /* ignore */ }
    this.current = view;
    this.lastHash = location.hash || '#/dashboard';
    this.paint(view, path);
    window.scrollTo(0, scroll);
  }

  paint(view, path) {
    const showNav = view.nav !== false && !view.back;
    const bar = h('header', { class: 'appbar' },
      view.back
        ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => (typeof view.back === 'string' ? this.navigate(view.back) : this.back()) }, icon('back'))
        : h('div', { style: { width: '8px' } }),
      h('h1', null, view.title || 'BizBill'),
      ...(view.actions || []).map((a) => h('button', { class: 'icon-btn', 'aria-label': a.label, title: a.label, onclick: a.onClick }, icon(a.icon))),
      !view.hideSearch ? h('button', { class: 'icon-btn', 'aria-label': 'Search', onclick: () => this.navigate('#/search') }, icon('search')) : null);
    const content = h('main', { class: 'content' + (showNav ? '' : ' no-nav') }, view.content);
    const shell = h('div', { class: 'shell' }, bar, content);
    if (showNav) shell.appendChild(this.bottomNav(path));
    if (view.fab) {
      shell.appendChild(h('a', { class: 'fab' + (showNav ? '' : ' low'), href: view.fab.href || '#', onclick: view.fab.onClick, 'aria-label': view.fab.label },
        icon(view.fab.icon || 'plus'), view.fab.text ? view.fab.text : null));
    }
    if (view.footer) shell.appendChild(view.footer);
    document.title = (view.title ? view.title + ' · ' : '') + 'BizBill';
    replaceRoot(this.root, shell);
  }

  bottomNav(path) {
    const labels = Object.fromEntries(NAV_TABS);
    const tabs = (this.store.settings.ui.navTabs || []).filter((t) => labels[t]).slice(0, 5);
    const base = path.split('/')[0];
    const items = tabs.map((t) => h('a', { href: '#/' + t, class: base === t ? 'active' : '', 'aria-current': base === t ? 'page' : null },
      h('span', { class: 'ico-wrap' }, icon(NAV_ICONS[t] || 'grid')), labels[t]));
    const onMore = !tabs.includes(base);
    items.push(h('a', { href: '#/more', class: onMore ? 'active' : '' }, h('span', { class: 'ico-wrap' }, icon('menu')), 'More'));
    return h('nav', { class: 'bottomnav', 'aria-label': 'Main' }, items);
  }
}

function replaceRoot(root, el) {
  clear(root);
  append(root, [el]);
}

const app = new App();
window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(String((e.reason && e.reason.message) || e.reason), 'bad'); });
app.boot();
export default app;
