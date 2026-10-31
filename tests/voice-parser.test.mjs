import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../assets/js/billing/voice-parser.js';

const add = (text) => {
  const r = parseCommand(text);
  assert.equal(r.type, 'add', `${text} -> ${JSON.stringify(r)}`);
  return r;
};
const error = (text, reason) => {
  const r = parseCommand(text);
  assert.equal(r.type, 'error', `${text} -> ${JSON.stringify(r)}`);
  if (reason) assert.equal(r.reason, reason, `${text} -> ${JSON.stringify(r)}`);
  return r;
};

test('example commands from the spec', () => {
  assert.deepEqual(
    { ...add('Add two kilos of rice at 60 rupees per kilo.') },
    { type: 'add', name: 'rice', qty: 2, unit: 'kg', rate: 60, priceMode: 'rate', total: null },
  );
  const oil = add('Add one litre of oil for 150 rupees.');
  assert.equal(oil.qty, 1); assert.equal(oil.unit, 'l'); assert.equal(oil.rate, 150); assert.equal(oil.priceMode, 'total');
  assert.deepEqual(parseCommand('Change the rice quantity to three kilos.'), { type: 'change', target: 'rice', field: 'qty', qty: 3, unit: 'kg' });
  assert.deepEqual(parseCommand('Remove the oil.'), { type: 'remove', target: 'oil' });
  assert.deepEqual(parseCommand('Apply a discount of 10 rupees.'), { type: 'discount', discountType: 'flat', value: 10 });
});

test('english variations', () => {
  assert.equal(add('add 2 kg rice @ 60/kg').rate, 60);
  assert.equal(add('add 2kg rice at rs.60 per kg').qty, 2);
  assert.equal(add('add ₹60 per kilo rice 2 kilo').rate, 60);
  const sugar = add('add 1.5 kg sugar at 42.50 rupees per kg');
  assert.equal(sugar.qty, 1.5); assert.equal(sugar.rate, 42.5);
  assert.equal(add('add two point five kilo atta at 40 per kilo').qty, 2.5);
  assert.equal(add('add one and a half kilo dal at 120 rupees per kilo').qty, 1.5);
  assert.equal(add('add half a kilo of ghee at 600 rupees per kilo').qty, 0.5);
  assert.equal(add('add a kilo of salt at 25 rupees').qty, 1);
  assert.equal(add('add 3 soap at 40 rupees each').rate, 40);
  const total = add('add 3 soap for 100 rupees');
  assert.equal(total.priceMode, 'total');
  assert.ok(Math.abs(total.rate * 3 - 100) < 1e-9);
  assert.equal(add('add one hundred twenty five grams tea at 2 rupees per gram').qty, 125);
});

test('unit conversion between quantity and rate units', () => {
  const r = add('add 500 grams sugar at 40 rupees per kilo');
  assert.equal(r.qty, 0.5); assert.equal(r.unit, 'kg'); assert.equal(r.rate, 40);
  const ml = add('add 250 ml oil at 160 per litre');
  assert.equal(ml.qty, 0.25); assert.equal(ml.unit, 'l');
  const eggs = add('add 2 dozen eggs at 6 rupees each');
  assert.equal(eggs.qty, 24); assert.equal(eggs.unit, 'pcs');
  error('add 2 litre rice at 60 per kg', 'unit_mismatch');
});

test('hindi (devanagari) commands', () => {
  const rice = add('दो किलो चावल साठ रुपये किलो');
  assert.equal(rice.name, 'चावल'); assert.equal(rice.qty, 2); assert.equal(rice.rate, 60);
  const oil = add('एक लीटर तेल 150 रुपये में');
  assert.equal(oil.priceMode, 'total'); assert.equal(oil.rate, 150);
  assert.equal(add('डेढ़ किलो चीनी 45 रुपये किलो जोड़ो').qty, 1.5);
  assert.equal(add('ढाई किलो आटा 40 रुपये प्रति किलो').qty, 2.5);
  assert.equal(add('साढ़े तीन किलो आलू 30 रुपये किलो').qty, 3.5);
  assert.equal(add('आधा किलो घी 600 रुपये किलो').qty, 0.5);
  assert.equal(add('२ किलो दाल १२० रुपये किलो').rate, 120);
  assert.equal(add('एक पैकेट बिस्कुट डेढ़ सौ रुपये का').rate, 150);
  assert.deepEqual(parseCommand('चावल की मात्रा तीन किलो कर दो'), { type: 'change', target: 'चावल', field: 'qty', qty: 3, unit: 'kg' });
  assert.deepEqual(parseCommand('तेल हटा दो'), { type: 'remove', target: 'तेल' });
  assert.deepEqual(parseCommand('तेल हटाओ'), { type: 'remove', target: 'तेल' });
  assert.deepEqual(parseCommand('10 रुपये छूट दो'), { type: 'discount', discountType: 'flat', value: 10 });
  assert.deepEqual(parseCommand('पांच प्रतिशत डिस्काउंट'), { type: 'discount', discountType: 'percent', value: 5 });
  assert.equal(parseCommand('चावल का रेट 65 कर दो').rate, 65);
});

test('romanised hindi (hinglish) commands', () => {
  const r = add('do kilo aloo 30 rupaye kilo add karo');
  assert.equal(r.qty, 2); assert.equal(r.name, 'aloo'); assert.equal(r.rate, 30);
  assert.equal(add('dedh kilo cheeni 45 rupaye kilo').qty, 1.5);
  assert.deepEqual(parseCommand('tel hata do'), { type: 'remove', target: 'tel' });
  assert.equal(parseCommand('chawal ki quantity teen kilo kar do').qty, 3);
});

test('never invents missing quantities or prices', () => {
  const noQty = error('add rice at 60 per kilo', 'missing_qty');
  assert.equal(noQty.partial.name, 'rice');
  assert.equal(noQty.partial.rate, 60); // what was heard is kept for the form
  const noRate = error('add two kilos of rice', 'missing_rate');
  assert.equal(noRate.partial.qty, 2);
  error('add at 60 rupees per kilo 2 kilo', 'missing_name');
  error('दो किलो चावल', 'missing_rate');
});

test('an amount without a rate word is the total for the line, as on shop slips', () => {
  const r = add('add 2 kg rice 60 rupees');
  assert.equal(r.priceMode, 'total');
  assert.equal(r.rate, 30);
  // With quantity 1 the rate and the total are the same.
  assert.equal(add('add 1 kg rice 60 rupees').rate, 60);
  // A rate is still a rate when said with "per", "किलो", "रेट".
  assert.equal(add('add 2 kg rice 60 rupees per kg').rate, 60);
  // Two prices or two quantities are still asked, not guessed.
  error('add 2 kg rice at 60 rupees per kg for 120 rupees', 'ambiguous');
  error('add 2 kg 3 kg rice at 60 per kg', 'ambiguous');
});

test('change commands', () => {
  assert.deepEqual(parseCommand('change rice rate to 65 rupees'), { type: 'change', target: 'rice', field: 'rate', rate: 65, rateUnit: null });
  assert.deepEqual(parseCommand('rice rate 65'), { type: 'change', target: 'rice', field: 'rate', rate: 65, rateUnit: null });
  assert.equal(parseCommand('change rice price to 65 per kg').rateUnit, 'kg');
  assert.deepEqual(parseCommand('make sugar 1.5 kilo'), { type: 'change', target: 'sugar', field: 'qty', qty: 1.5, unit: 'kg' });
  error('change rice to 3', 'ambiguous');
  error('change the quantity to 3 kilo', 'missing_name');
  error('change rice quantity', 'missing_qty');
});

test('remove and discount commands', () => {
  assert.deepEqual(parseCommand('remove last item'), { type: 'remove', last: true });
  assert.deepEqual(parseCommand('delete mustard oil'), { type: 'remove', target: 'mustard oil' });
  assert.deepEqual(parseCommand('10 percent discount'), { type: 'discount', discountType: 'percent', value: 10 });
  assert.deepEqual(parseCommand('discount 5%'), { type: 'discount', discountType: 'percent', value: 5 });
  assert.deepEqual(parseCommand('remove discount'), { type: 'discount', discountType: 'flat', value: 0 });
  error('give discount', 'missing_value');
  error('remove', 'missing_name');
});

test('speech errors', () => {
  error('', 'empty');
  error('   ', 'empty');
  error('uh hmm', 'missing_qty');
});

test('finish commands are recognised but never add items', () => {
  for (const t of ['print the bill', 'save bill', 'save and print', 'बिल प्रिंट करो', 'bill print kar do']) {
    assert.deepEqual(parseCommand(t), { type: 'finish' }, t);
  }
});
