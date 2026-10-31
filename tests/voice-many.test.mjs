import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMany } from '../assets/js/billing/voice-parser.js';

const adds = (text) => parseMany(text).map(({ cmd }) => {
  assert.equal(cmd.type, 'add', `${text} -> ${JSON.stringify(cmd)}`);
  return [cmd.name, cmd.qty, cmd.unit, cmd.rate];
});

test('the shopkeeper examples', () => {
  assert.deepEqual(adds('चीनी 25 किलो का बोरा 4 बोरा 1200 रेट'), [['चीनी (25 kg)', 4, 'bag', 1200]]);
  assert.deepEqual(adds('मिर्ची 500 ग्राम 200 रुपये किलो'), [['मिर्ची', 0.5, 'kg', 200]]);
  assert.deepEqual(adds('गुड़ 10 किलो 45 रुपये प्रति किलो करके'), [['गुड़', 10, 'kg', 45]]);
  assert.deepEqual(adds('चावल 5 किलो 40 रुपये किलो'), [['चावल', 5, 'kg', 40]]);
  assert.deepEqual(adds('दाल 30 किलो का बोरा 2000 रुपये प्रति बोरा 3 करके'), [['दाल (30 kg)', 3, 'bag', 2000]]);
  assert.deepEqual(adds('चीनी 25 किलो का बोरा 1200 रेट 4 करके'), [['चीनी (25 kg)', 4, 'bag', 1200]]);
});

test('sacks: size before or after the count, rate per sack or per kilo', () => {
  assert.deepEqual(adds('चावल 2 बोरा 25 किलो का 40 रुपये किलो'), [['चावल (25 kg)', 50, 'kg', 40]]);
  assert.deepEqual(adds('atta 2 bags of 10 kg 400 rupees per bag'), [['atta (10 kg)', 2, 'bag', 400]]);
  assert.deepEqual(adds('चीनी 50 किलो 25 किलो का बोरा 1000 रुपये बोरा'), [['चीनी (25 kg)', 2, 'bag', 1000]]);
});

test('fifteen items said in one breath become fifteen lines', () => {
  const spoken = [
    'चावल 5 किलो 40 रुपये किलो',
    'दाल 2 किलो 100 रुपये किलो',
    'गुड़ 3 किलो 50 रुपये किलो',
    'मिर्ची 250 ग्राम 200 रुपये किलो',
    'हल्दी 500 ग्राम 160 रुपये किलो',
    'चीनी 25 किलो का बोरा 2 बोरा 1100 रेट',
    'आटा 10 किलो 32 रुपये किलो',
    'तेल 2 लीटर 150 रुपये लीटर',
    'नमक 2 पैकेट 25 रुपये पैकेट',
    'साबुन 6 पीस 30 रुपये पीस',
    'चायपत्ती 1 किलो 400 रुपये किलो',
    'बेसन 2 किलो 90 रुपये किलो',
    'सूजी 1 किलो 45 रुपये किलो',
    'मूंगफली 2 किलो 140 रुपये किलो',
    'घी 1 किलो 600 रुपये किलो',
  ];
  const items = adds(spoken.join(' और '));
  assert.equal(items.length, 15);
  assert.deepEqual(items.map((i) => i[0]), ['चावल', 'दाल', 'गुड़', 'मिर्ची', 'हल्दी', 'चीनी (25 kg)', 'आटा', 'तेल', 'नमक', 'साबुन', 'चायपत्ती', 'बेसन', 'सूजी', 'मूंगफली', 'घी']);
  assert.deepEqual(items[3], ['मिर्ची', 0.25, 'kg', 200]);
  assert.deepEqual(items[5], ['चीनी (25 kg)', 2, 'bag', 1100]);
  // Without "और" between them, and with "फिर", the split is the same.
  assert.equal(adds(spoken.join(' ')).length, 15);
  assert.equal(adds(spoken.join(' फिर ')).length, 15);
});

test('english and hinglish lists', () => {
  assert.deepEqual(adds('add 2 kg rice at 60 per kg add 1 litre oil for 150 rupees 3 kg sugar at 42 per kg'), [
    ['rice', 2, 'kg', 60], ['oil', 1, 'l', 150], ['sugar', 3, 'kg', 42],
  ]);
  assert.equal(adds('do kilo aloo 30 rupaye kilo phir ek kilo pyaz 40 rupaye kilo').length, 2);
});

test('a bad item in the list is reported, the others still come through', () => {
  const r = parseMany('चावल 5 किलो 40 रुपये किलो दाल 2 किलो गुड़ 3 किलो 50 रुपये किलो');
  assert.deepEqual(r.map((x) => x.cmd.type), ['add', 'error', 'add']);
  assert.equal(r[1].cmd.reason, 'missing_rate');
  assert.equal(r[1].cmd.partial.name, 'दाल');
  // A plain amount is the line total: 500 g for ₹120 -> 0.5 kg × ₹240
  const amt = parseMany('मिर्ची 500 ग्राम 120 रुपये')[0].cmd;
  assert.deepEqual([amt.qty, amt.unit, amt.rate, amt.priceMode], [0.5, 'kg', 240, 'total']);
  const noName = parseMany('25 kg का बोरा 4 बोरा 1200 rate');
  assert.equal(noName[0].cmd.reason, 'missing_name');
  assert.equal(noName[0].cmd.partial.qty, 4);
});

test('other commands in the same breath', () => {
  const r = parseMany('चावल 5 किलो 40 रुपये किलो। 10 रुपये छूट दो। बिल प्रिंट करो');
  assert.deepEqual(r.map((x) => x.cmd.type), ['add', 'discount', 'finish']);
});

test('pack size + count + rate in any order', () => {
  assert.deepEqual(adds('25 kg चावल का 4 बोरा ₹2,000 करके'), [['चावल (25 kg)', 4, 'bag', 2000]]);
  assert.deepEqual(adds('25 किलो चावल का 4 बोरा 2000 रुपये करके'), [['चावल (25 kg)', 4, 'bag', 2000]]);
  assert.deepEqual(adds('चावल 25 किलो वाला 4 बोरा 2000 रुपये बोरा'), [['चावल (25 kg)', 4, 'bag', 2000]]);
  assert.deepEqual(adds('चीनी 50 किलो 3 करके 2100 रुपये करके'), [['चीनी (50 kg)', 3, 'bag', 2100]]);
  assert.deepEqual(adds('चावल 25 किलो वाला 4 बोरा 40 रुपये किलो'), [['चावल (25 kg)', 100, 'kg', 40]]);
  assert.deepEqual(adds('मैगी 1 किलो वाला पैकेट 5 पैकेट 120 रुपये पैकेट'), [['मैगी (1 kg)', 5, 'packet', 120]]);
  // Two weights is still unclear, so it is asked, not guessed.
  assert.equal(parseMany('2 kg 3 kg rice at 60 per kg')[0].cmd.reason, 'ambiguous');
});

test('lines from the shop slips: amount, not rate', () => {
  const rate = (text) => parseMany(text).map(({ cmd }) => {
    assert.equal(cmd.type, 'add', `${text} -> ${JSON.stringify(cmd)}`);
    return [cmd.name, cmd.qty, cmd.unit, Math.round(cmd.rate * 100) / 100];
  });
  assert.deepEqual(rate('चना 5 किलो 325'), [['चना', 5, 'kg', 65]]);
  assert.deepEqual(rate('बासमती चावल 20 किलो 2100'), [['बासमती चावल', 20, 'kg', 105]]);
  assert.deepEqual(rate('फॉर्च्यून 3 टिन 7290'), [['फॉर्च्यून', 3, 'tin', 2430]]);
  assert.deepEqual(rate('फॉर्च्यून 7 16660'), [['फॉर्च्यून', 7, '', 2380]]);
  assert.deepEqual(rate('चीनी 2 इनटू 30 4520'), [['चीनी (30 kg)', 2, 'bag', 2260]]);
  assert.deepEqual(rate('बाजरा 6 इनटू 25 4800'), [['बाजरा (25 kg)', 6, 'bag', 800]]);
  assert.deepEqual(rate('Chini - 2x30 4520'), [['chini (30 kg)', 2, 'bag', 2260]]);
  assert.deepEqual(rate('चीनी 2 गुणा 30 75 रुपये किलो'), [['चीनी (30 kg)', 60, 'kg', 75]]);
  // A whole slip said in one go
  assert.deepEqual(rate('चना 5 किलो 325 बेसन 10 किलो 840 फॉर्च्यून 3 टिन 7290 चना दाल 6 किलो 450 चना दाल 5 किलो 325').map((r) => r[3]), [65, 84, 2430, 75, 65]);
  // "3 करके" is how many, never an amount
  assert.equal(parseMany('चीनी 50 किलो 3 करके')[0].cmd.reason, 'missing_rate');
});
