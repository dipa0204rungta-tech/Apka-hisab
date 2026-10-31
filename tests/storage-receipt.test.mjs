import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBill, addItem, setDiscount } from '../assets/js/billing/bill.js';
import { LocalBillStore, StorageError, STORAGE_KEYS, DEFAULT_SETTINGS } from '../assets/js/billing/storage.js';
import { buildReceipt, renderReceiptText, renderReceiptHtml, PAPER } from '../assets/js/billing/receipt.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

function sampleBill() {
  let bill = createBill({ customerName: 'Ramesh' });
  bill = addItem(bill, { name: 'rice', qty: 2, unit: 'kg', rate: 60 }).bill;
  bill = addItem(bill, { name: 'oil', qty: 1, unit: 'l', rate: 150 }).bill;
  bill = addItem(bill, { name: 'Basmati Rice Premium Long Grain Extra', qty: 0.75, unit: 'kg', rate: 132.4 }).bill;
  return setDiscount(bill, { type: 'flat', value: 10 }).bill;
}

test('saves bills with unique sequential numbers', async () => {
  const mem = new MemoryStorage();
  const store = new LocalBillStore(mem);
  const a = await store.saveBill(sampleBill(), DEFAULT_SETTINGS);
  const b = await store.saveBill(sampleBill(), DEFAULT_SETTINGS);
  assert.equal(a.bill.billNumber, 'AH-00001');
  assert.equal(b.bill.billNumber, 'AH-00002');
  assert.equal(a.bill.totals.grandTotal, 359.3);

  // Survives a "page refresh": a new store over the same storage.
  const reopened = new LocalBillStore(mem);
  const list = await reopened.listBills();
  assert.deepEqual(list.map((x) => x.billNumber), ['AH-00002', 'AH-00001']);
  const c = await reopened.saveBill(sampleBill(), DEFAULT_SETTINGS);
  assert.equal(c.bill.billNumber, 'AH-00003');
});

test('saving the same bill twice does not create a duplicate transaction', async () => {
  const mem = new MemoryStorage();
  const store = new LocalBillStore(mem);
  const bill = sampleBill();
  // Simultaneous double tap...
  const [x, y] = await Promise.all([store.saveBill(bill), store.saveBill(bill)]);
  assert.equal(x.bill.billNumber, y.bill.billNumber);
  // ...and a later retry.
  const z = await store.saveBill(bill);
  assert.equal(z.duplicate, true);
  assert.equal((await store.listBills()).length, 1);
});

test('bill numbers are never reused even if the counter is behind', async () => {
  const mem = new MemoryStorage();
  const store = new LocalBillStore(mem);
  await store.saveBill(sampleBill());
  await store.saveBill(sampleBill());
  mem.setItem(STORAGE_KEYS.counter, '0');
  const r = await store.saveBill(sampleBill());
  assert.equal(r.bill.seq, 3);
});

test('storage failures are reported, not silently ignored', async () => {
  const full = new MemoryStorage();
  full.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  const store = new LocalBillStore(full);
  await assert.rejects(store.saveBill(sampleBill()), StorageError);

  const damaged = new MemoryStorage();
  damaged.setItem(STORAGE_KEYS.bills, '{not json');
  await assert.rejects(new LocalBillStore(damaged).saveBill(sampleBill()), /damaged/);
  assert.equal(damaged.getItem(STORAGE_KEYS.bills), '{not json'); // left untouched
  assert.throws(() => new LocalBillStore(null), StorageError);
});

test('draft and settings persist', async () => {
  const mem = new MemoryStorage();
  const store = new LocalBillStore(mem);
  const bill = sampleBill();
  await store.saveDraft(bill);
  assert.deepEqual(await new LocalBillStore(mem).loadDraft(), bill);
  await store.clearDraft();
  assert.equal(await store.loadDraft(), null);
  await store.saveSettings({ shopName: 'Gupta Kirana', billPrefix: 'GK/' });
  const s = await new LocalBillStore(mem).getSettings();
  assert.equal(s.shopName, 'Gupta Kirana');
  assert.equal(s.paperWidth, '58');
  const r = await store.saveBill(sampleBill(), s);
  assert.equal(r.bill.billNumber, 'GK/00001');
  assert.equal(r.bill.shop.shopName, 'Gupta Kirana');
});

test('receipt contains all required fields and fits the paper', async () => {
  const store = new LocalBillStore(new MemoryStorage());
  const settings = { ...DEFAULT_SETTINGS, shopName: 'Gupta Kirana Store', phone: '98765 43210', address: '12 Main Bazaar, Jaipur' };
  const { bill } = await store.saveBill(sampleBill(), settings);
  const receipt = buildReceipt(bill);
  for (const width of ['58', '80']) {
    const lines = renderReceiptText(receipt, { paperWidth: width });
    const text = lines.join('\n');
    for (const needle of ['Gupta Kirana Store', '98765 43210', 'AH-00001', 'Rice', 'Oil', '2 kg', '60.00', '120.00', '150.00', 'Subtotal', '369.30', 'Discount', '-10.00', 'TOTAL', '359.30', 'Ramesh']) {
      assert.ok(text.includes(needle), `${width}mm receipt missing ${needle}\n${text}`);
    }
    assert.ok(lines.every((l) => l.length <= PAPER[width].columns), `${width}mm line too long`);
    assert.ok(text.includes(receipt.date) && text.includes(receipt.time));
  }
  const html = renderReceiptHtml(receipt, { paperWidth: '80' });
  assert.match(html, /receipt-80/);
  assert.match(html, /359\.30/);
});

test('receipt HTML escapes user text', () => {
  const receipt = buildReceipt({
    billNumber: 'AH-1', savedAt: new Date().toISOString(), customerName: '<img src=x onerror=alert(1)>',
    items: [{ id: 'a', name: '<b>x</b>', qty: 1, unit: '', rate: 1 }], discount: { type: 'flat', value: 0 },
    totals: { lines: [{ id: 'a', amount: 1 }], subtotal: 1, discount: 0, grandTotal: 1 }, shop: { shopName: 'A & B' },
  });
  const html = renderReceiptHtml(receipt);
  assert.ok(!html.includes('<img') && !html.includes('<b>'));
  assert.ok(html.includes('A &amp; B'));
});
