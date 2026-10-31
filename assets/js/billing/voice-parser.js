// Turns a recognised sentence (English, Hindi or Hinglish) into a structured
// billing command. It never fills in a missing quantity or price: when the
// sentence is incomplete or ambiguous it returns { type: 'error' } with the
// parts it did understand, so the UI can ask the user to correct it.

import { normaliseDigits, wordsToNumbers } from './numbers.js';
import { convertQuantity, unitLabel } from './bill.js';

const nfcSet = (words) => new Set(words.map((w) => w.normalize('NFC')));
const nfcMap = (pairs) => new Map(pairs.map(([k, v]) => [k.normalize('NFC'), v]));

const RUPEE_WORDS = nfcSet([
  'rs', 'rupees', 'rupee', 'inr', 'rupaye', 'rupaiye', 'rupay', 'rupye', 'rupiya', 'rupaya', 'rupaye',
  'रुपये', 'रुपए', 'रुपया', 'रूपये', 'रूपए', 'रुपयों', 'रुपैया', 'रु',
]);

const UNIT_WORDS = {
  kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes', 'किलो', 'किलोग्राम', 'केजी'],
  g: ['g', 'gm', 'gms', 'gram', 'grams', 'gramme', 'grammes', 'ग्राम'],
  l: ['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters', 'लीटर', 'लिटर'],
  ml: ['ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'एमएल', 'मिलीलीटर'],
  pcs: ['pc', 'pcs', 'piece', 'pieces', 'nos', 'nag', 'नग', 'पीस'],
  dozen: ['dozen', 'dozens', 'darjan', 'दर्जन'],
  packet: ['packet', 'packets', 'pack', 'packs', 'pkt', 'pkts', 'पैकेट', 'पैकिट'],
  bottle: ['bottle', 'bottles', 'बोतल'],
  box: ['box', 'boxes', 'dibba', 'डिब्बा', 'डिब्बे'],
};
const UNIT_LOOKUP = new Map();
for (const [code, words] of Object.entries(UNIT_WORDS)) for (const w of words) UNIT_LOOKUP.set(w.normalize('NFC'), code);

const PER_WORDS = nfcSet(['per', 'each', 'प्रति', 'har', 'हर', 'a', 'an', 'every']);
const EACH_WORDS = nfcSet(['each', 'every']);
const RATE_MARKERS = nfcSet(['at', '@', 'rate', 'bhav', 'bhaav', 'भाव', 'दाम', 'daam', 'रेट', 'price', 'कीमत', 'keemat', 'kimat']);
const TOTAL_MARKERS_BEFORE = nfcSet(['for', 'total', 'worth', 'in', 'टोटल']);
const TOTAL_MARKERS_AFTER = nfcSet(['ka', 'ki', 'ke', 'का', 'की', 'के', 'में', 'mein', 'me', 'main', 'total', 'worth']);

const DISCOUNT_WORDS = nfcSet(['discount', 'discounts', 'डिस्काउंट', 'छूट', 'chhoot', 'chhut', 'choot', 'chut', 'off']);
const ADD_WORDS = nfcSet(['add', 'jodo', 'एड', 'ऐड', 'plus', 'insert']);
const REMOVE_WORDS = nfcSet(['remove', 'delete', 'hatao', 'रिमूव', 'डिलीट', 'cancel', 'कैंसल', 'erase']);
const CHANGE_WORDS = nfcSet(['change', 'update', 'set', 'edit', 'correct', 'make', 'karo', 'badlo', 'बदलो', 'बदल', 'चेंज', 'अपडेट', 'should', 'instead']);
const QTY_FIELD_WORDS = nfcSet(['quantity', 'qty', 'quantities', 'मात्रा', 'matra', 'maatra', 'वजन', 'वज़न', 'weight', 'क्वांटिटी', 'quantity.']);
const RATE_FIELD_WORDS = nfcSet(['rate', 'price', 'दाम', 'भाव', 'रेट', 'कीमत', 'keemat', 'kimat', 'daam', 'bhav', 'bhaav', 'cost']);
const PERCENT_WORDS = nfcSet(['percent', 'percentage', 'pc.', 'प्रतिशत', 'pratishat', 'परसेंट', 'फीसदी']);
const LAST_WORDS = nfcSet(['last', 'previous', 'pichla', 'pichhla', 'पिछला', 'आखिरी', 'aakhri', 'akhri', 'लास्ट']);
const FINISH_WORDS = nfcSet(['print', 'printout', 'save', 'प्रिंट', 'सेव', 'checkout', 'प्रिंटआउट']);

const STOPWORDS = nfcSet([
  'please', 'plz', 'pls', 'of', 'the', 'a', 'an', 'and', 'at', 'for', 'with', 'to', 'per', 'each', 'every',
  'total', 'worth', 'in', 'ka', 'ki', 'ke', 'का', 'की', 'के', 'में', 'mein', 'me', 'main', 'se', 'से',
  'wala', 'wali', 'wale', 'वाला', 'वाली', 'वाले', 'bill', 'item', 'items', 'on', 'into', 'from', 'also',
  'aur', 'और', 'bhi', 'भी', 'is', 'ko', 'को', 'it', 'its', 'my', 'this', 'that', 'be', 'should', 'make',
  'set', 'karo', 'kar', 'कर', 'करो', 'hai', 'है', 'प्रति', 'har', 'हर', 'line', 'entry', 'lagao', 'jodo',
  'hatao', 'ji', 'जी', 'now', 'abhi', 'अभी', 'then', 'by', 'off', 'apply', 'give', 'want', 'i', 'we',
  '@', 'rate', 'price', 'rs', 'cost', 'only', 'sirf', 'सिर्फ',
]);

// Multi-word Hindi verb phrases, normalised before tokenising so the "दो"
// in "कर दो" (= "do it") is not read as the number two.
const PHRASES = [
  [/(छूट|डिस्काउंट|discount|chhoot|chhut|choot)\s+(दे\s+दो|दो|दीजिए|दीजिये|दें|de\s+do|do|dijiye|dijie|de)(?=\s|$)/g, (_, w) => ` ${w} `],
  [/(कर|हटा|जोड़|जोड|डाल|लगा|निकाल|लिख|दे|बदल)\s+(दो|दीजिए|दीजिये|दें|देना)/g, (_, v) => ` ${v}ो `],
  [/\b(kar|hata|jod|daal|dal|laga|nikal|likh|de|badal)\s+(do|dijiye|dijie|dena|den)\b/g, (_, v) => ` ${v}o `],
  [/\b(kardo|kar\s*dijiye)\b/g, ' karo '],
];
const VERB_ALIASES = nfcMap([
  ['करो', 'karo'], ['कीजिए', 'karo'], ['कीजिये', 'karo'], ['कर', 'karo'], ['karo', 'karo'], ['kro', 'karo'],
  ['हटाओ', 'hatao'], ['हटाो', 'hatao'], ['निकालो', 'hatao'], ['निकालो', 'hatao'], ['hatao', 'hatao'], ['hatado', 'hatao'],
  ['hatho', 'hatao'], ['hatao', 'hatao'], ['nikalo', 'hatao'], ['hatai', 'hatao'],
  ['जोड़ो', 'jodo'], ['जोड़ो', 'jodo'], ['जोडो', 'jodo'], ['डालो', 'jodo'], ['डालो', 'jodo'], ['लिखो', 'jodo'],
  ['jodo', 'jodo'], ['joddo', 'jodo'], ['daalo', 'jodo'], ['dalo', 'jodo'], ['likho', 'jodo'],
  ['लगाओ', 'lagao'], ['लगाो', 'lagao'], ['देो', 'lagao'], ['lagao', 'lagao'], ['deo', 'lagao'], ['lagado', 'lagao'],
  ['बदलो', 'badlo'], ['बदलो', 'badlo'], ['badalo', 'badlo'], ['badlo', 'badlo'],
]);

function tokenise(text) {
  let s = normaliseDigits(String(text).normalize('NFC')).toLowerCase();
  s = s.replace(/₹\s*/g, ' rs ');
  s = s.replace(/\b(rs|inr)\.\s*/g, ' rs ');
  s = s.replace(/(\d)\s*\/-/g, '$1 rs ');
  s = s.replace(/(\d)\s*\/\s*(?=[a-zऀ-ॿ])/g, '$1 per ');
  s = s.replace(/(\d),(?=\d{2,3}\b)/g, '$1');
  s = s.replace(/(\d)\s*%/g, '$1 percent ');
  s = s.replace(/@/g, ' @ ');
  // Separate numbers glued to words: "2kg" -> "2 kg", "rs60" -> "rs 60"
  s = s.replace(/(\d)(?=[a-zऀ-ॿ])/g, '$1 ').replace(/([a-zऀ-ॿ])(?=\d)/g, '$1 ');
  // Keep decimal points between digits, drop other punctuation.
  s = s.replace(/(\d)\.(\d)/g, '$1\u0000$2').replace(/[.,!?;:"'()\[\]{}।|]+/g, ' ').replace(/\u0000/g, '.');
  for (const [re, rep] of PHRASES) s = s.replace(new RegExp(re.source.normalize('NFC'), re.flags), rep);
  const words = s.split(/\s+/).filter(Boolean).map((w) => VERB_ALIASES.get(w) ?? w);
  return wordsToNumbers(words).map((t) => {
    if (/^\d+(\.\d+)?$/.test(t)) return { t, kind: 'num', value: parseFloat(t) };
    if (RUPEE_WORDS.has(t)) return { t, kind: 'rs' };
    if (UNIT_LOOKUP.has(t)) return { t, kind: 'unit', unit: UNIT_LOOKUP.get(t) };
    return { t, kind: 'word' };
  });
}

const has = (tokens, set) => tokens.some((tok) => set.has(tok.t));

function err(message, extra = {}) {
  return { type: 'error', message, ...extra };
}

/** Find a price expression. Returns { price, mode: 'rate'|'total'|'unknown', rateUnit, used:Set } or null. */
function findPrices(tokens) {
  const found = [];
  tokens.forEach((tok, i) => {
    if (tok.kind !== 'num') return;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    let j = i + 1;
    let hasRs = false;
    if (next?.kind === 'rs') { hasRs = true; j = i + 2; }
    // "rs 60" spoken with the currency first
    if (!hasRs && prev?.kind === 'rs') hasRs = true;
    const after = tokens[j];
    const after2 = tokens[j + 1];
    const used = new Set([i]);
    if (next?.kind === 'rs') used.add(i + 1);
    if (prev?.kind === 'rs') used.add(i - 1);

    // "60 per kilo", "60 rupees a kilo", "60 each", "60 प्रति किलो"
    if (after && PER_WORDS.has(after.t) && (after2?.kind === 'unit' || EACH_WORDS.has(after.t))) {
      if ((after.t === 'a' || after.t === 'an') && !hasRs) return; // "2 a kilo" is not a price
      used.add(j);
      let rateUnit = null;
      if (after2?.kind === 'unit') { rateUnit = after2.unit; used.add(j + 1); }
      found.push({ price: tok.value, mode: 'rate', rateUnit, each: EACH_WORDS.has(after.t), used, index: i });
      return;
    }
    // "60 रुपये किलो" / "60 rupees kilo"
    if (hasRs && after?.kind === 'unit') {
      used.add(j);
      found.push({ price: tok.value, mode: 'rate', rateUnit: after.unit, used, index: i });
      return;
    }
    const before = prev?.kind === 'rs' ? tokens[i - 2] : prev;
    if (before && RATE_MARKERS.has(before.t) && (hasRs || next?.kind !== 'unit')) {
      found.push({ price: tok.value, mode: 'rate', rateUnit: null, used, index: i });
      return;
    }
    if (before && TOTAL_MARKERS_BEFORE.has(before.t) && (hasRs || next?.kind !== 'unit')) {
      found.push({ price: tok.value, mode: 'total', rateUnit: null, used, index: i });
      return;
    }
    if (hasRs) {
      if (after && TOTAL_MARKERS_AFTER.has(after.t)) {
        found.push({ price: tok.value, mode: 'total', rateUnit: null, used, index: i });
      } else {
        found.push({ price: tok.value, mode: 'unknown', rateUnit: null, used, index: i });
      }
    }
  });
  return found;
}

/** Find quantities among the tokens not used by the price. */
function findQuantities(tokens, usedByPrice) {
  const found = [];
  tokens.forEach((tok, i) => {
    if (usedByPrice.has(i)) return;
    if (tok.kind === 'num') {
      let j = i + 1;
      if (tokens[j] && (tokens[j].t === 'a' || tokens[j].t === 'an') && tokens[j + 1]?.kind === 'unit') j++; // "half a kilo"
      if (tokens[j]?.kind === 'unit' && !usedByPrice.has(j)) {
        found.push({ qty: tok.value, unit: tokens[j].unit, used: new Set([i, j]) });
      } else {
        found.push({ qty: tok.value, unit: '', used: new Set([i]) });
      }
    } else if (tok.kind === 'unit' && !usedByPrice.has(i)) {
      const prev = tokens[i - 1];
      if (prev && (prev.t === 'a' || prev.t === 'an') && !usedByPrice.has(i - 1) && tokens[i - 2]?.kind !== 'num') {
        found.push({ qty: 1, unit: tok.unit, used: new Set([i - 1, i]) }); // "a kilo of rice"
      }
    }
  });
  return found;
}

function nameFrom(tokens, used, extraStop = new Set()) {
  return tokens
    .filter((tok, i) => !used.has(i) && tok.kind === 'word' && !STOPWORDS.has(tok.t) && !extraStop.has(tok.t))
    .map((tok) => tok.t)
    .join(' ')
    .trim();
}

const ADD_STOP = nfcSet([...ADD_WORDS, ...RATE_MARKERS, ...TOTAL_MARKERS_BEFORE, ...TOTAL_MARKERS_AFTER]);

function parseAdd(tokens) {
  const prices = findPrices(tokens);
  if (prices.length > 1) {
    return err('I heard more than one price. Please say one item with one price.', { reason: 'ambiguous' });
  }
  const price = prices[0] ?? null;
  const priceUsed = price ? price.used : new Set();
  const quantities = findQuantities(tokens, priceUsed);
  const used = new Set(priceUsed);
  for (const q of quantities) for (const i of q.used) used.add(i);
  // Unit words that were not part of a quantity or price ("kilo chawal") are not part of the name.
  tokens.forEach((tok, i) => { if (tok.kind === 'unit' || tok.kind === 'rs') used.add(i); });

  const name = nameFrom(tokens, used, ADD_STOP);
  const partial = { name, qty: null, unit: '', rate: null };

  if (quantities.length > 1) {
    return err('I heard more than one quantity. Please say the quantity once.', { reason: 'ambiguous', partial });
  }
  const q = quantities[0];
  if (q) { partial.qty = q.qty; partial.unit = q.unit; }
  if (price?.mode === 'rate') {
    partial.rate = price.price;
    if (!partial.unit && price.rateUnit) partial.unit = price.rateUnit;
  }

  if (!name) return err('I did not catch the item name.', { reason: 'missing_name', partial });
  if (!q) return err(`How much ${name}? The quantity is missing.`, { reason: 'missing_qty', partial });
  if (!price) return err(`What is the price of ${name}? The rate is missing.`, { reason: 'missing_rate', partial });
  if (price.price <= 0) return err('The price must be more than ₹0.', { reason: 'invalid', partial });
  if (q.qty <= 0) return err('The quantity must be more than 0.', { reason: 'invalid', partial });

  let qty = q.qty;
  let unit = q.unit;
  let rate;
  let mode = price.mode;
  if (mode === 'unknown') {
    if (qty === 1) mode = 'rate';
    else {
      partial.rate = null;
      return err(`Is ₹${price.price} the rate per ${unitLabel(unit) || 'unit'} or the total for ${qty} ${unitLabel(unit)}? Say "at ${price.price} per ${unitLabel(unit) || 'piece'}" or "for ${price.price} rupees".`, { reason: 'ambiguous_price', partial, price: price.price });
    }
  }
  if (mode === 'rate') {
    rate = price.price;
    if (price.each && unit === 'dozen') {
      qty = convertQuantity(qty, 'dozen', 'pcs'); // "2 dozen eggs at 6 rupees each"
      unit = 'pcs';
    }
    if (price.rateUnit) {
      if (!unit) unit = price.rateUnit;
      else if (unit !== price.rateUnit) {
        const converted = convertQuantity(qty, unit, price.rateUnit);
        if (converted === null) {
          return err(`The quantity is in ${unitLabel(unit)} but the rate is per ${unitLabel(price.rateUnit)}. Please check.`, { reason: 'unit_mismatch', partial });
        }
        qty = converted;
        unit = price.rateUnit;
      }
    }
  } else {
    rate = price.price / qty;
  }
  return { type: 'add', name, qty, unit, rate, priceMode: mode, total: mode === 'total' ? price.price : null };
}

function parseRemove(tokens) {
  if (has(tokens, LAST_WORDS)) return { type: 'remove', last: true };
  const used = new Set();
  tokens.forEach((tok, i) => { if (tok.kind !== 'word') used.add(i); });
  const name = nameFrom(tokens, used, new Set([...REMOVE_WORDS, ...LAST_WORDS]));
  if (!name) return err('Which item should I remove? Please say its name.', { reason: 'missing_name' });
  return { type: 'remove', target: name };
}

function parseChange(tokens) {
  let field = null;
  if (has(tokens, QTY_FIELD_WORDS)) field = 'qty';
  else if (has(tokens, RATE_FIELD_WORDS)) field = 'rate';

  const nums = tokens.map((t, i) => (t.kind === 'num' ? i : -1)).filter((i) => i >= 0);
  const used = new Set();
  tokens.forEach((tok, i) => { if (tok.kind !== 'word') used.add(i); });
  const name = nameFrom(tokens, used, new Set([...CHANGE_WORDS, ...QTY_FIELD_WORDS, ...RATE_FIELD_WORDS, ...PER_WORDS]));

  if (!name) return err('Which item should I change? Please say its name.', { reason: 'missing_name' });
  if (nums.length === 0) return err(`What should the new ${field === 'rate' ? 'rate' : 'quantity'} of ${name} be?`, { reason: field === 'rate' ? 'missing_rate' : 'missing_qty', target: name });
  if (nums.length > 1) return err('I heard more than one number. Please say only the new value.', { reason: 'ambiguous', target: name });

  const i = nums[0];
  const value = tokens[i].value;
  let next = tokens[i + 1];
  if (next && (next.t === 'a' || next.t === 'an') && tokens[i + 2]?.kind === 'unit') next = tokens[i + 2];
  const unitAfter = next?.kind === 'unit' ? next.unit : '';
  const rupeesNear = next?.kind === 'rs' || tokens[i - 1]?.kind === 'rs';
  let rateUnit = null;
  if (rupeesNear || field === 'rate') {
    const after = next?.kind === 'rs' ? tokens[i + 2] : next;
    const after2 = next?.kind === 'rs' ? tokens[i + 3] : tokens[i + 2];
    if (after?.kind === 'unit') rateUnit = after.unit;
    else if (after && PER_WORDS.has(after.t) && after2?.kind === 'unit') rateUnit = after2.unit;
  }

  if (!field) {
    if (rupeesNear) field = 'rate';
    else if (unitAfter) field = 'qty';
    else return err(`Should ${value} be the new quantity or the new rate of ${name}? Say "quantity" or "rate".`, { reason: 'ambiguous', target: name });
  }
  if (value <= 0) return err(`The new ${field === 'rate' ? 'rate' : 'quantity'} must be more than 0.`, { reason: 'invalid', target: name });
  if (field === 'qty') return { type: 'change', target: name, field, qty: value, unit: unitAfter };
  return { type: 'change', target: name, field, rate: value, rateUnit };
}

function parseDiscount(tokens) {
  const nums = tokens.filter((t) => t.kind === 'num');
  const removing = has(tokens, REMOVE_WORDS) || tokens.some((t) => ['no', 'zero', 'nahi', 'नहीं', 'बिना'].includes(t.t));
  if (nums.length === 0) {
    if (removing) return { type: 'discount', discountType: 'flat', value: 0 };
    return err('How much discount? Say for example "discount 10 rupees" or "discount 5 percent".', { reason: 'missing_value' });
  }
  if (nums.length > 1) return err('I heard more than one discount amount. Please say it again.', { reason: 'ambiguous' });
  const percent = has(tokens, PERCENT_WORDS);
  return { type: 'discount', discountType: percent ? 'percent' : 'flat', value: nums[0].value };
}

/**
 * Parse a spoken command.
 * @returns {{type:'add'|'change'|'remove'|'discount'|'finish'|'error', ...}}
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return err('I did not hear anything. Please try again.', { reason: 'empty' });
  const tokens = tokenise(raw);
  if (!tokens.length) return err('I did not hear anything. Please try again.', { reason: 'empty' });

  // "print the bill" / "बिल प्रिंट करो": open the bill for review. Printing
  // itself always needs a tap on Print Bill.
  if (has(tokens, FINISH_WORDS)) return { type: 'finish' };
  if (has(tokens, DISCOUNT_WORDS)) return parseDiscount(tokens);
  if (has(tokens, ADD_WORDS)) return parseAdd(tokens);
  if (has(tokens, REMOVE_WORDS)) return parseRemove(tokens);
  if (has(tokens, CHANGE_WORDS) || has(tokens, QTY_FIELD_WORDS)) return parseChange(tokens);
  const result = parseAdd(tokens);
  // "rice rate 65" with no quantity is a rate correction, not a new item.
  if (result.type === 'error' && result.reason === 'missing_qty' && has(tokens, RATE_FIELD_WORDS)) return parseChange(tokens);
  return result;
}

// Exposed for tests.
export const _internal = { tokenise };
