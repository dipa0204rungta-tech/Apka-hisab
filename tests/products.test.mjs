import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../assets/js/billing/products.js';

test('corrects small mishearings of known items and says what was heard', () => {
  const c = createCatalog();
  assert.deepEqual(c.correct('जरा'), { name: 'जीरा', heard: 'जरा' });
  assert.deepEqual(c.correct('कंजू'), { name: 'काजू', heard: 'कंजू' });
  assert.deepEqual(c.correct('कंजू (25 kg)'), { name: 'काजू (25 kg)', heard: 'कंजू' });
  assert.deepEqual(c.correct('बदाम'), { name: 'बादाम', heard: 'बदाम' });
});

test('leaves known, English and unrelated names alone', () => {
  const c = createCatalog();
  for (const w of ['चावल', 'दाल', 'मिर्ची', 'तेल', 'चना', 'मूंग', 'rice', 'बासमती चावल', 'नया सामान']) {
    assert.deepEqual(c.correct(w), { name: w, heard: null }, w);
  }
});

test('learns item names from saved bills', () => {
  const c = createCatalog(['बार्ली (25 kg)']);
  assert.deepEqual(c.correct('बार्बी'), { name: 'बार्ली', heard: 'बार्बी' });
  c.add('रागी');
  assert.ok(c.has('रागी'));
});
