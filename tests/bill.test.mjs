import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBill, addItem, updateItem, removeItem, setDiscount, computeTotals, validateBillForSave,
  findItemsByName, convertQuantity, round2, nameKey,
} from '../assets/js/billing/bill.js';

function billWith(...items) {
  let bill = createBill();
  for (const it of items) {
    const r = addItem(bill, it);
    assert.ok(r.ok, JSON.stringify(r));
    bill = r.bill;
  }
  return bill;
}

test('amount = quantity × rate, totals update', () => {
  const bill = billWith(
    { name: 'rice', qty: 2, unit: 'kg', rate: 60 },
    { name: 'oil', qty: 1, unit: 'l', rate: 150 },
  );
  const t = computeTotals(bill);
  assert.deepEqual(t.lines.map((l) => l.amount), [120, 150]);
  assert.equal(t.subtotal, 270);
  assert.equal(t.grandTotal, 270);
  assert.equal(bill.items[0].name, 'Rice');
});

test('decimal quantities and rates round to paise', () => {
  const bill = billWith(
    { name: 'sugar', qty: 1.25, unit: 'kg', rate: 42.5 },
    { name: 'tea', qty: 0.125, unit: 'kg', rate: 480 },
    { name: 'a', qty: 3, rate: 0.1 },
    { name: 'b', qty: 1.005, rate: 1 },
  );
  const t = computeTotals(bill);
  assert.deepEqual(t.lines.map((l) => l.amount), [53.13, 60, 0.3, 1.01]);
  assert.equal(t.subtotal, 114.44);
  assert.equal(round2(1.005), 1.01);
});

test('total-price items keep the spoken total', () => {
  const bill = billWith({ name: 'soap', qty: 3, rate: 100 / 3 });
  assert.equal(computeTotals(bill).subtotal, 100);
});

test('validates quantity and rate', () => {
  const bill = createBill();
  for (const bad of [
    { name: 'x', qty: 0, rate: 10 },
    { name: 'x', qty: -1, rate: 10 },
    { name: 'x', qty: NaN, rate: 10 },
    { name: 'x', qty: 1.2345, rate: 10 },
    { name: 'x', qty: 1, rate: 0 },
    { name: 'x', qty: 1, rate: null },
    { name: 'x', qty: null, rate: 5 },
    { name: '', qty: 1, rate: 5 },
    { name: 'x', qty: 1e9, rate: 5 },
  ]) {
    const r = addItem(bill, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'invalid');
  }
});

test('prevents accidental duplicate items, including across languages', () => {
  const bill = billWith({ name: 'Rice', qty: 2, unit: 'kg', rate: 60 });
  for (const name of ['rice', ' RICE ', 'chawal', 'चावल']) {
    const r = addItem(bill, { name, qty: 2, unit: 'kg', rate: 60 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'duplicate');
  }
  const forced = addItem(bill, { name: 'rice', qty: 1, rate: 70 }, { allowDuplicate: true });
  assert.ok(forced.ok);
  assert.equal(forced.bill.items.length, 2);
});

test('edit and remove items', () => {
  let bill = billWith({ name: 'rice', qty: 2, unit: 'kg', rate: 60 }, { name: 'oil', qty: 1, unit: 'l', rate: 150 });
  const rice = bill.items[0];
  let r = updateItem(bill, rice.id, { qty: 3 });
  assert.ok(r.ok);
  bill = r.bill;
  assert.equal(computeTotals(bill).subtotal, 330);
  assert.equal(updateItem(bill, rice.id, { qty: 0 }).ok, false);
  assert.equal(updateItem(bill, rice.id, { name: 'oil' }).code, 'duplicate');
  r = removeItem(bill, bill.items[1].id);
  assert.ok(r.ok);
  assert.equal(computeTotals(r.bill).subtotal, 180);
  assert.equal(removeItem(r.bill, 'missing').ok, false);
});

test('discounts', () => {
  const bill = billWith({ name: 'rice', qty: 2, unit: 'kg', rate: 60 });
  let r = setDiscount(bill, { type: 'flat', value: 10 });
  assert.ok(r.ok);
  assert.deepEqual(
    (({ subtotal, discount, grandTotal }) => ({ subtotal, discount, grandTotal }))(computeTotals(r.bill)),
    { subtotal: 120, discount: 10, grandTotal: 110 },
  );
  r = setDiscount(bill, { type: 'percent', value: 12.5 });
  assert.equal(computeTotals(r.bill).discount, 15);
  assert.equal(setDiscount(bill, { type: 'flat', value: 500 }).ok, false);
  assert.equal(setDiscount(bill, { type: 'flat', value: -5 }).ok, false);
  assert.equal(setDiscount(bill, { type: 'percent', value: 101 }).ok, false);
});

test('a discount larger than a reduced subtotal blocks saving', () => {
  let bill = billWith({ name: 'rice', qty: 2, unit: 'kg', rate: 60 }, { name: 'oil', qty: 1, rate: 150 });
  bill = setDiscount(bill, { type: 'flat', value: 200 }).bill;
  bill = removeItem(bill, bill.items[1].id).bill;
  assert.equal(computeTotals(bill).grandTotal, 0);
  assert.ok(validateBillForSave(bill).some((e) => e.includes('Discount')));
  assert.ok(validateBillForSave(createBill()).length > 0);
});

test('display names keep a sack size in brackets as said', () => {
  const bill = billWith({ name: 'atta (10 kg)', qty: 2, unit: 'bag', rate: 400 });
  assert.equal(bill.items[0].name, 'Atta (10 kg)');
});

test('find items by spoken name', () => {
  const bill = billWith({ name: 'Mustard Oil', qty: 1, unit: 'l', rate: 180 }, { name: 'Rice', qty: 1, rate: 60 }, { name: 'Basmati Rice', qty: 1, rate: 120 });
  assert.equal(findItemsByName(bill, 'oil').length, 1);
  assert.equal(findItemsByName(bill, 'tel')[0].name, 'Mustard Oil');
  assert.equal(findItemsByName(bill, 'chawal')[0].name, 'Rice'); // exact alias match wins
  assert.equal(findItemsByName(bill, 'basmati').length, 1);
  assert.equal(findItemsByName(bill, 'sugar').length, 0);
  assert.equal(nameKey('चावल'), 'rice');
});

test('unit conversion', () => {
  assert.equal(convertQuantity(500, 'g', 'kg'), 0.5);
  assert.equal(convertQuantity(1.5, 'l', 'ml'), 1500);
  assert.equal(convertQuantity(2, 'dozen', 'pcs'), 24);
  assert.equal(convertQuantity(1, 'kg', 'l'), null);
});
