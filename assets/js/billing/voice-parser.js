// Turns a recognised sentence (English, Hindi or Hinglish) into a structured
// billing command. It never fills in a missing quantity or price: when the
// sentence is incomplete or ambiguous it returns { type: 'error' } with the
// parts it did understand, so the UI can ask the user to correct it.

import { normaliseDigits, wordsToNumbers } from './numbers.js';
import { convertQuantity, unitLabel, formatQty } from './bill.js';

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
  tin: ['tin', 'tins', 'teen', 'टिन', 'टीन', 'टिनें', 'पीपा', 'पीपे', 'peepa'],
  bag: ['bag', 'bags', 'sack', 'sacks', 'bora', 'bore', 'bori', 'boriya', 'katta', 'katte', 'बोरा', 'बोरे', 'बोरी', 'बोरिया', 'बोरियां', 'कट्टा', 'कट्टे'],
};
const UNIT_LOOKUP = new Map();
for (const [code, words] of Object.entries(UNIT_WORDS)) for (const w of words) UNIT_LOOKUP.set(w.normalize('NFC'), code);

const PER_WORDS = nfcSet(['per', 'each', 'प्रति', 'पर', 'पे', 'har', 'हर', 'a', 'an', 'every']);
const EACH_WORDS = nfcSet(['each', 'every']);
// "1200 rate" / "1200 रुपये रेट": the rate word after the number
const RATE_AFTER = nfcSet(['rate', 'रेट', 'भाव', 'bhav', 'bhaav', 'दाम', 'daam', 'price', 'कीमत']);
// "₹2000 करके" / "2000 रुपये के हिसाब से": that price is the rate for each one
const EACH_AFTER_PRICE = nfcSet(['करके', 'karke', 'हिसाब', 'hisab', 'hisaab', 'each', 'प्रत्येक']);
const WEIGHT_UNITS = new Set(['kg', 'g', 'l', 'ml']);
const COUNT_UNITS = new Set(['bag', 'pcs', 'packet', 'box', 'bottle', 'dozen']);
// "30 किलो का बोरा": words between a sack's size and the sack
const BAG_LINK = nfcSet(['ka', 'ki', 'ke', 'का', 'की', 'के', 'of', 'wala', 'wali', 'wale', 'वाला', 'वाली', 'वाले']);
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
  '@', 'rate', 'price', 'rs', 'cost', 'only', 'sirf', 'सिर्फ', 'करके', 'karke', 'करके', 'कर', 'पर', 'पे', 'वो', 'ये', 'यह',
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
  s = s.replace(/(\d)\.(\d)/g, '$1\u0000$2').replace(/[.,!?;:"'()\[\]{}।|–—-]+/g, ' ').replace(/\u0000/g, '.');
  for (const [re, rep] of PHRASES) s = s.replace(new RegExp(re.source.normalize('NFC'), re.flags), rep);
  const words = s.split(/\s+/).filter(Boolean).map((w) => VERB_ALIASES.get(w) ?? w);
  const tokens = wordsToNumbers(words).map((t) => {
    if (/^\d+(\.\d+)?$/.test(t)) return { t, kind: 'num', value: parseFloat(t) };
    if (RUPEE_WORDS.has(t)) return { t, kind: 'rs' };
    if (UNIT_LOOKUP.has(t)) return { t, kind: 'unit', unit: UNIT_LOOKUP.get(t) };
    return { t, kind: 'word' };
  });
  return expandTimes(tokens);
}

// "6 इनटू 25", "6 x 25", "2 गुणा 30": how many × size of each, as written on
// shop slips ("Chini - 2x30"). Rewritten as "6 बोरा 25 kg" so the pack-size
// rules below apply. Big packs (10 kg and more) count as sacks, small as pieces.
const TIMES_WORDS = nfcSet(['x', '×', '*', 'into', 'इनटू', 'इंटू', 'इन्टू', 'इनतू', 'गुणा', 'गुणे', 'गुना', 'गुने', 'guna', 'gune', 'cross']);
function expandTimes(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const [count, times, size, unit] = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if (count.kind === 'num' && times && TIMES_WORDS.has(times.t) && size?.kind === 'num') {
      const sizeUnit = unit?.kind === 'unit' && WEIGHT_UNITS.has(unit.unit) ? unit.unit : 'kg';
      const big = convertQuantity(size.value, sizeUnit, sizeUnit === 'g' || sizeUnit === 'kg' ? 'kg' : 'l') >= 10;
      out.push(count, { t: big ? 'बोरा' : 'pcs', kind: 'unit', unit: big ? 'bag' : 'pcs' }, size, { t: sizeUnit, kind: 'unit', unit: sizeUnit });
      i += unit?.kind === 'unit' && WEIGHT_UNITS.has(unit.unit) ? 3 : 2;
      continue;
    }
    out.push(count);
  }
  return out;
}

const has = (tokens, set) => tokens.some((tok) => set.has(tok.t));

function err(message, extra = {}) {
  return { type: 'error', message, ...extra };
}

/** Find a price expression. Returns { price, mode: 'rate'|'total'|'unknown', rateUnit, used:Set } or null. */
function findPrices(tokens, skip = new Set()) {
  const found = [];
  tokens.forEach((tok, i) => {
    if (tok.kind !== 'num' || skip.has(i)) return;
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
    // "1200 rate", "1200 रुपये रेट", "40 रुपये भाव"
    if (after && RATE_AFTER.has(after.t)) {
      used.add(j);
      found.push({ price: tok.value, mode: 'rate', rateUnit: null, used, index: i });
      return;
    }
    // "₹2000 करके", "2000 रुपये के हिसाब से": the rate for each one
    if (hasRs && after && (EACH_AFTER_PRICE.has(after.t) || (TOTAL_MARKERS_AFTER.has(after.t) && EACH_AFTER_PRICE.has(after2?.t)))) {
      found.push({ price: tok.value, mode: 'rate', rateUnit: null, used, index: i });
      return;
    }
    // "60 रुपये किलो" / "60 rupees kilo"
    if (hasRs && after?.kind === 'unit') {
      used.add(j);
      found.push({ price: tok.value, mode: 'rate', rateUnit: after.unit, used, index: i });
      return;
    }
    const beforeIndex = prev?.kind === 'rs' ? i - 2 : i - 1;
    const before = tokens[beforeIndex];
    // "1200 रेट 4": रेट belongs to 1200, so 4 is not a second price
    const markerTaken = tokens[beforeIndex - 1]?.kind === 'num' || tokens[beforeIndex - 1]?.kind === 'rs';
    if (before && RATE_MARKERS.has(before.t) && !(RATE_AFTER.has(before.t) && markerTaken) && (hasRs || next?.kind !== 'unit')) {
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

/**
 * Find the size of a sack: "30 किलो का बोरा", "25 kg bag". The size describes
 * the sack; it is not the quantity being bought.
 */
function findBag(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const unit = tokens[i + 1];
    if (tok.kind !== 'num' || unit?.kind !== 'unit' || !['kg', 'g', 'l', 'ml'].includes(unit.unit)) continue;
    let j = i + 2;
    if (tokens[j] && BAG_LINK.has(tokens[j].t)) j++;
    if (tokens[j]?.kind === 'unit' && tokens[j].unit === 'bag') {
      const used = new Set();
      for (let k = i; k <= j; k++) used.add(k);
      // "4 बोरा" right after is the count of sacks, so leave the sack word for it
      // only when a separate count is not spoken ("30 किलो का बोरा 2000 रुपये बोरा 3")
      return { size: tok.value, unit: unit.unit, used };
    }
  }
  // "2 बोरा 25 किलो का" / "2 bags of 25 kg": the size follows the count
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].kind !== 'unit' || tokens[i].unit !== 'bag' || tokens[i - 1].kind !== 'num') continue;
    let j = i + 1;
    if (tokens[j] && BAG_LINK.has(tokens[j].t)) j++;
    const size = tokens[j];
    const unit = tokens[j + 1];
    if (size?.kind !== 'num' || unit?.kind !== 'unit' || !['kg', 'g', 'l', 'ml'].includes(unit.unit)) continue;
    const used = new Set([j, j + 1]);
    if (j > i + 1) used.add(i + 1);
    if (tokens[j + 2] && BAG_LINK.has(tokens[j + 2].t)) used.add(j + 2);
    return { size: size.value, unit: unit.unit, used };
  }
  return null;
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
  let bag = findBag(tokens);
  const bagUsed = bag ? bag.used : new Set();
  const prices = findPrices(tokens, bagUsed);
  if (prices.length > 1) {
    return err('I heard more than one price. Please say one item with one price.', { reason: 'ambiguous' });
  }
  let price = prices[0] ?? null;
  const priceUsed = new Set([...(price ? price.used : []), ...bagUsed]);
  let quantities = findQuantities(tokens, priceUsed);
  // Shop slips write the amount, not the rate: "चना 5 किलो 325", "Fortune 7 16660".
  // A last plain number after the quantity is the total amount for the line.
  if (!price && quantities.length >= 2) {
    const lastNum = tokens.reduce((last, t, i) => (t.kind === 'num' ? i : last), -1);
    const amount = quantities.find((q) => q.unit === '' && q.used.has(lastNum));
    const after = tokens[lastNum + 1];
    const isCount = after && EACH_AFTER_PRICE.has(after.t); // "3 करके" = 3 of them
    if (amount && !isCount && !(Number.isInteger(amount.qty) && amount.qty < 10)) {
      price = { price: amount.qty, mode: 'total', rateUnit: null, used: amount.used };
      for (const i of amount.used) priceUsed.add(i);
      quantities = quantities.filter((q) => q !== amount);
    }
  }
  // Pack size + how many: "25 kg चावल का 4 बोरा", "1 किलो वाला पैकेट 5", "चीनी 50 किलो 3 करके".
  // One weight and one count: the weight is the size of each pack, the count is how many are sold.
  if (!bag && quantities.length === 2) {
    const weight = quantities.find((q) => WEIGHT_UNITS.has(q.unit));
    const count = quantities.find((q) => q !== weight && (q.unit === '' || COUNT_UNITS.has(q.unit)));
    if (weight && count && Number.isInteger(count.qty)) {
      bag = { size: weight.qty, unit: weight.unit, used: weight.used };
      // A bare count is sacks for big packs and pieces for small ones.
      const big = convertQuantity(weight.qty, weight.unit, weight.unit === 'g' || weight.unit === 'kg' ? 'kg' : 'l') >= 10;
      quantities = [{ ...count, unit: count.unit || (big ? 'bag' : 'pcs') }];
    }
  }
  const used = new Set(priceUsed);
  for (const q of quantities) for (const i of q.used) used.add(i);
  // Unit words that were not part of a quantity or price ("kilo chawal") are not part of the name.
  tokens.forEach((tok, i) => { if (tok.kind === 'unit' || tok.kind === 'rs') used.add(i); });

  const baseName = nameFrom(tokens, used, ADD_STOP);
  // "दाल (30 kg)": the sack size stays visible on the bill and receipt
  const name = baseName && bag ? `${baseName} (${formatQty(bag.size)} ${unitLabel(bag.unit)})` : baseName;
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

  if (!baseName) return err('I did not catch the item name.', { reason: 'missing_name', partial });
  if (!q) return err(`How much ${name}? The quantity is missing.`, { reason: 'missing_qty', partial });
  if (!price) return err(`What is the price of ${name}? The rate is missing.`, { reason: 'missing_rate', partial });
  if (price.price <= 0) return err('The price must be more than ₹0.', { reason: 'invalid', partial });
  if (q.qty <= 0) return err('The quantity must be more than 0.', { reason: 'invalid', partial });

  let qty = q.qty;
  let unit = q.unit || (bag ? 'bag' : ''); // "30 किलो का बोरा ... 3" = 3 sacks
  let rate;
  let mode = price.mode;
  // "चना 5 किलो 325 रुपये": an amount without "किलो", "रेट" or "प्रति" after it
  // is the total for the line, the way it is written on shop slips. Say
  // "325 रुपये किलो" or "रेट 325" for a rate.
  if (mode === 'unknown') mode = qty === 1 ? 'rate' : 'total';
  if (mode === 'rate') {
    rate = price.price;
    if (price.each && unit === 'dozen') {
      qty = convertQuantity(qty, 'dozen', 'pcs'); // "2 dozen eggs at 6 rupees each"
      unit = 'pcs';
    }
    if (bag && price.rateUnit && WEIGHT_UNITS.has(price.rateUnit) && COUNT_UNITS.has(unit)) {
      // "2 बोरा, 25 किलो का, 40 रुपये किलो" -> 50 kg at ₹40
      const converted = convertQuantity(qty * bag.size, bag.unit, price.rateUnit);
      if (converted === null) {
        return err(`The sack is in ${unitLabel(bag.unit)} but the rate is per ${unitLabel(price.rateUnit)}. Please check.`, { reason: 'unit_mismatch', partial });
      }
      qty = converted;
      unit = price.rateUnit;
    } else if (bag && price.rateUnit === 'bag' && unit && WEIGHT_UNITS.has(unit)) {
      // "50 किलो, 25 किलो का बोरा, 1000 रुपये बोरा" -> 2 bags at ₹1000
      const inBagUnit = convertQuantity(qty, unit, bag.unit);
      if (inBagUnit === null) {
        return err(`The quantity is in ${unitLabel(unit)} but the sack is in ${unitLabel(bag.unit)}. Please check.`, { reason: 'unit_mismatch', partial });
      }
      qty = Math.round((inBagUnit / bag.size) * 1000) / 1000;
      unit = 'bag';
    } else if (price.rateUnit) {
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
    // A total for grams reads better per kilo: 500 g for ₹120 -> 0.5 kg × ₹240.
    if (unit === 'g' || unit === 'ml') {
      qty = convertQuantity(qty, unit, unit === 'g' ? 'kg' : 'l');
      unit = unit === 'g' ? 'kg' : 'l';
    }
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
// Spoken words that always separate two items.
const SEPARATORS = /(?:^|\s)(?:फिर|अगला|अगली|अगले|next|phir|fir|agla|agli)(?=\s|$)/gu;

// Words that can start a new item when the previous one is already complete.
function canStartItem(tok) {
  if (tok.kind === 'num') return true;
  return tok.kind === 'word' && !STOPWORDS.has(tok.t) && !ADD_STOP.has(tok.t) && !PER_WORDS.has(tok.t)
    && !RATE_AFTER.has(tok.t) && !BAG_LINK.has(tok.t) && !PERCENT_WORDS.has(tok.t);
}

/**
 * Split one long run of words into items. An item ends once it has a name,
 * quantity and price, and the next word starts something new: a new name, or
 * a number that would give the item a second quantity or price.
 */
function splitItems(tokens) {
  const items = [];
  let current = [];
  for (const tok of tokens) {
    if (current.length && (ADD_WORDS.has(tok.t) || canStartItem(tok))) {
      const now = parseAdd(current);
      const last = current[current.length - 1];
      let startsNew = false;
      if (now.type === 'add') {
        startsNew = ADD_WORDS.has(tok.t) || tok.kind === 'word' || parseAdd([...current, tok]).type === 'error';
      } else if (now.reason === 'missing_rate' && tok.kind === 'word' && last.kind !== 'word') {
        // "दाल 2 किलो | गुड़ ...": the price was left out, so end this item
        // here and report it instead of merging it into the next one.
        startsNew = true;
      } else if (ADD_WORDS.has(tok.t) && now.partial?.name) {
        startsNew = true;
      }
      if (startsNew) { items.push(current); current = []; }
    }
    current.push(tok);
  }
  if (current.length) items.push(current);
  return items;
}

/**
 * Parse everything said in one go: many items, each becoming its own
 * command. Returns [{ text, cmd }] in the order spoken. Anything that is not
 * a list of items (remove, change, discount, print) is parsed as one command.
 */
export function parseMany(text) {
  const chunks = normaliseDigits(String(text ?? '').normalize('NFC'))
    .replace(SEPARATORS, '\n')
    .split(/\n|।|;|(?<!\d)\.|\.(?!\d)/)
    .map((c) => c.trim())
    .filter(Boolean);
  const results = [];
  for (const chunk of chunks) {
    const single = parseCommand(chunk);
    if (single.type !== 'add' && single.type !== 'error') {
      results.push({ text: chunk, cmd: single });
      continue;
    }
    const tokens = tokenise(chunk);
    const parts = splitItems(tokens);
    if (parts.length <= 1) {
      results.push({ text: chunk, cmd: single });
      continue;
    }
    for (const part of parts) {
      // Drop linking words at the edges ("... और", "फिर ...") from the text shown.
      let a = 0;
      let b = part.length;
      while (a < b && part[a].kind === 'word' && STOPWORDS.has(part[a].t)) a++;
      while (b > a && part[b - 1].kind === 'word' && STOPWORDS.has(part[b - 1].t)) b--;
      const words = part.slice(a, b).map((t) => t.t).join(' ');
      if (!part.some((t) => canStartItem(t) && t.kind === 'word') && !part.some((t) => t.kind === 'num')) continue; // only filler words
      results.push({ text: words, cmd: parseAdd(part) });
    }
  }
  return results;
}

/** Rough shape of a phrase: how many numbers, units/₹ and item-like words it has. */
export function phraseShape(text) {
  const tokens = tokenise(String(text ?? ''));
  return {
    numbers: tokens.filter((t) => t.kind === 'num').length,
    units: tokens.filter((t) => t.kind === 'unit' || t.kind === 'rs').length,
    words: tokens.filter((t) => t.kind === 'word' && canStartItem(t)).length,
  };
}

export const _internal = { tokenise };
