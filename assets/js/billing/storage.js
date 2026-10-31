// Persistence for bills, the in-progress draft and shop settings.
//
// The API is async on purpose: today it is backed by localStorage, but the
// same interface can be implemented against a server/database
// (e.g. fetch('/api/bills')) without changing the UI code.

import { computeTotals } from './bill.js';

const PREFIX = 'apkaHisab.billing.v1.';
const KEYS = {
  bills: `${PREFIX}bills`,
  counter: `${PREFIX}billCounter`,
  draft: `${PREFIX}draft`,
  settings: `${PREFIX}settings`,
};

export const DEFAULT_SETTINGS = {
  shopName: 'My Shop',
  address: '',
  phone: '',
  gstin: '',
  footer: 'Thank you! Visit again.',
  billPrefix: 'AH-',
  paperWidth: '58',
  voiceLang: 'en-IN',
};

export class StorageError extends Error {}

export class LocalBillStore {
  /** @param {Storage} storage any object with getItem/setItem/removeItem */
  constructor(storage = globalThis.localStorage) {
    if (!storage) throw new StorageError('Browser storage is not available. Bills cannot be saved on this device.');
    this.storage = storage;
    this.pending = new Map(); // bill id -> in-flight save promise
  }

  readJson(key, fallback) {
    const raw = this.storage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      throw new StorageError(`Saved data (${key}) is damaged and could not be read. It has not been changed.`);
    }
  }

  writeJson(key, value) {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw new StorageError(`Could not save: ${e?.name === 'QuotaExceededError' ? 'device storage is full' : e?.message || e}.`);
    }
  }

  async listBills() {
    const bills = this.readJson(KEYS.bills, []);
    return [...bills].sort((a, b) => b.seq - a.seq);
  }

  async getBill(id) {
    return this.readJson(KEYS.bills, []).find((b) => b.id === id) ?? null;
  }

  /**
   * Save a completed bill exactly once. Calling it again with the same bill
   * id (double tap, retry, second tab) returns the stored record instead of
   * creating a second transaction.
   * @returns {Promise<{ bill: object, duplicate: boolean }>}
   */
  saveBill(bill, settings = DEFAULT_SETTINGS) {
    if (this.pending.has(bill.id)) return this.pending.get(bill.id);
    const p = Promise.resolve().then(() => this.saveBillNow(bill, settings));
    this.pending.set(bill.id, p);
    p.finally(() => this.pending.delete(bill.id)).catch(() => {});
    return p;
  }

  saveBillNow(bill, settings) {
    const bills = this.readJson(KEYS.bills, []);
    const existing = bills.find((b) => b.id === bill.id);
    if (existing) return { bill: existing, duplicate: true };

    const counter = Number(this.readJson(KEYS.counter, 0)) || 0;
    const maxSeq = bills.reduce((m, b) => Math.max(m, b.seq || 0), 0);
    const seq = Math.max(counter, maxSeq) + 1;
    const prefix = settings.billPrefix ?? DEFAULT_SETTINGS.billPrefix;
    const record = {
      ...bill,
      items: bill.items.map((it) => ({ ...it })),
      seq,
      billNumber: `${prefix}${String(seq).padStart(5, '0')}`,
      savedAt: new Date().toISOString(),
      totals: computeTotals(bill),
      // Snapshot so reprints show the shop details as they were at the sale.
      shop: {
        shopName: settings.shopName,
        address: settings.address,
        phone: settings.phone,
        gstin: settings.gstin,
        footer: settings.footer,
      },
    };

    // Counter first: if the bill write then fails, a number is skipped
    // rather than reused.
    this.writeJson(KEYS.counter, seq);
    this.writeJson(KEYS.bills, [...bills, record]);

    const check = this.readJson(KEYS.bills, []).find((b) => b.id === bill.id);
    if (!check) throw new StorageError('The bill could not be verified after saving. Please try again.');
    return { bill: check, duplicate: false };
  }

  async loadDraft() {
    try {
      return this.readJson(KEYS.draft, null);
    } catch {
      return null; // A damaged draft should never block billing.
    }
  }

  async saveDraft(bill) {
    this.writeJson(KEYS.draft, bill);
  }

  async clearDraft() {
    this.storage.removeItem(KEYS.draft);
  }

  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.readJson(KEYS.settings, {}) };
  }

  async saveSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    this.writeJson(KEYS.settings, merged);
    return merged;
  }
}

export const STORAGE_KEYS = KEYS;
