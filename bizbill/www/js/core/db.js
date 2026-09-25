// Thin IndexedDB layer. BizBill keeps ONE database for all business data.
//
// Writes are always expressed as a list of operations committed in a single
// IndexedDB transaction, so a business action (e.g. "save invoice" = document
// + stock movements + payment + audit entry) is applied atomically: either
// everything is stored or nothing is.

export const DB_NAME = 'bizbill';
export const DB_VERSION = 1;

// Business data stores (included in backups).
export const DATA_STORES = [
  'settings', 'parties', 'products', 'documents', 'payments',
  'expenses', 'stockMoves', 'audit', 'attachments', 'meta',
];
// Local-only stores (never included in backups).
export const LOCAL_STORES = ['snapshots'];

function upgrade(db, oldVersion, tx) {
  // Version 1: initial schema. Future schema changes add `if (oldVersion < N)`
  // blocks below; never modify an existing block.
  if (oldVersion < 1) {
    db.createObjectStore('meta', { keyPath: 'key' });
    db.createObjectStore('settings', { keyPath: 'key' });
    const parties = db.createObjectStore('parties', { keyPath: 'id' });
    parties.createIndex('type', 'type');
    db.createObjectStore('products', { keyPath: 'id' });
    const docs = db.createObjectStore('documents', { keyPath: 'id' });
    docs.createIndex('kind', 'kind');
    docs.createIndex('partyId', 'partyId');
    const pay = db.createObjectStore('payments', { keyPath: 'id' });
    pay.createIndex('partyId', 'partyId');
    db.createObjectStore('expenses', { keyPath: 'id' });
    const mv = db.createObjectStore('stockMoves', { keyPath: 'id' });
    mv.createIndex('productId', 'productId');
    mv.createIndex('refId', 'refId');
    db.createObjectStore('audit', { keyPath: 'id' });
    db.createObjectStore('attachments', { keyPath: 'id' });
    db.createObjectStore('snapshots', { keyPath: 'id' });
  }
  void tx;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class Database {
  constructor(name = DB_NAME, factory = globalThis.indexedDB) {
    this.name = name;
    this.factory = factory;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!this.factory) throw new Error('IndexedDB is not available on this device');
    this.db = await new Promise((resolve, reject) => {
      const r = this.factory.open(this.name, DB_VERSION);
      r.onupgradeneeded = (e) => upgrade(r.result, e.oldVersion, r.transaction);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Database upgrade blocked by another open tab'));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  async getAll(store) {
    const db = await this.open();
    return req(db.transaction(store).objectStore(store).getAll());
  }

  async get(store, key) {
    const db = await this.open();
    return req(db.transaction(store).objectStore(store).get(key));
  }

  async count(store) {
    const db = await this.open();
    return req(db.transaction(store).objectStore(store).count());
  }

  /**
   * Atomically apply operations:
   *   {store, op: 'put', value} | {store, op: 'delete', key} | {store, op: 'clear'}
   */
  async write(ops) {
    if (!ops.length) return;
    const db = await this.open();
    const stores = [...new Set(ops.map((o) => o.store))];
    await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      try {
        for (const o of ops) {
          const s = tx.objectStore(o.store);
          if (o.op === 'put') s.put(o.value);
          else if (o.op === 'delete') s.delete(o.key);
          else if (o.op === 'clear') s.clear();
          else throw new Error('Unknown op ' + o.op);
        }
      } catch (e) {
        try { tx.abort(); } catch { /* already aborted */ }
        reject(e);
      }
    });
  }
}

let seq = 0;
/** Sortable, collision resistant id. */
export function newId(prefix = '') {
  seq = (seq + 1) % 1296;
  const rand = globalThis.crypto && globalThis.crypto.getRandomValues
    ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2, 14);
  return prefix + Date.now().toString(36) + seq.toString(36).padStart(2, '0') + rand;
}
