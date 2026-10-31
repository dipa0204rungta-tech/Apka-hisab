// Pure bill model: items, totals, validation. No DOM, no storage, so it can
// be unit-tested and reused by any UI or by a server.

export const MAX_QUANTITY = 100000;
export const MAX_RATE = 10000000;
export const MAX_ITEMS = 200;

/** Canonical unit codes and how they convert to each other. */
export const UNITS = {
  kg: { label: 'kg', base: 'g', factor: 1000 },
  g: { label: 'g', base: 'g', factor: 1 },
  l: { label: 'L', base: 'ml', factor: 1000 },
  ml: { label: 'ml', base: 'ml', factor: 1 },
  pcs: { label: 'pcs', base: 'pcs', factor: 1 },
  dozen: { label: 'dozen', base: 'pcs', factor: 12 },
  packet: { label: 'packet', base: 'packet', factor: 1 },
  bottle: { label: 'bottle', base: 'bottle', factor: 1 },
  box: { label: 'box', base: 'box', factor: 1 },
  bag: { label: 'बोरा', base: 'bag', factor: 1 }, // sack; its size goes in the item name
};

/** Round to paise without the usual floating point surprises (1.005 -> 1.01). */
export function round2(n) {
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

/** Round quantities to 3 decimals (grams for kg, ml for litres). */
export function round3(n) {
  return Math.round(Number((n * 1000).toPrecision(12))) / 1000;
}

/**
 * Convert a quantity from one unit to another. Returns null when the units
 * are not compatible (kg -> litre) so callers never guess.
 */
export function convertQuantity(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return qty;
  const from = UNITS[fromUnit];
  const to = UNITS[toUnit];
  if (!from || !to || from.base !== to.base) return null;
  return round3((qty * from.factor) / to.factor);
}

export function unitLabel(unit) {
  return unit ? (UNITS[unit]?.label ?? unit) : '';
}

// Words that mean the same product. Used only for matching ("remove chawal"
// finds "Rice"); the name the user gave is what is displayed and printed.
const ALIAS_GROUPS = [
  ['rice', 'chawal', 'chaawal', 'chaval', 'चावल'],
  ['oil', 'tel', 'तेल'],
  ['sugar', 'cheeni', 'chini', 'shakkar', 'चीनी', 'शक्कर'],
  ['salt', 'namak', 'नमक'],
  ['flour', 'atta', 'aata', 'आटा'],
  ['wheat', 'gehu', 'gehun', 'गेहूं', 'गेहूँ'],
  ['dal', 'daal', 'lentils', 'lentil', 'दाल'],
  ['milk', 'doodh', 'dudh', 'दूध'],
  ['tea', 'chai', 'चाय', 'चायपत्ती'],
  ['onion', 'onions', 'pyaz', 'pyaaz', 'प्याज', 'प्याज़'],
  ['potato', 'potatoes', 'aloo', 'alu', 'आलू'],
  ['tomato', 'tomatoes', 'tamatar', 'टमाटर'],
  ['ghee', 'घी'],
  ['egg', 'eggs', 'anda', 'ande', 'अंडा', 'अंडे'],
  ['soap', 'sabun', 'साबुन'],
  ['bread', 'ब्रेड'],
  ['butter', 'makhan', 'मक्खन'],
  ['curd', 'dahi', 'दही'],
  ['biscuit', 'biscuits', 'बिस्कुट'],
];
const ALIASES = new Map();
for (const group of ALIAS_GROUPS) for (const word of group) ALIASES.set(word.normalize('NFC'), group[0]);

/** Matching key for an item name: lower case, aliases folded, plurals ignored. */
export function nameKey(name) {
  return String(name)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ALIASES.get(w) ?? w)
    .join(' ');
}

/** Title case Latin words, leave Devanagari alone. */
export function displayName(name) {
  const clean = String(name).trim().replace(/\s+/g, ' ');
  // Title-case the name but leave a bracketed detail such as "(30 kg)" as it is.
  const cut = clean.indexOf(' (');
  const main = cut === -1 ? clean : clean.slice(0, cut);
  const rest = cut === -1 ? '' : clean.slice(cut);
  return main.replace(/(^|\s)([a-z])/g, (_, sp, c) => sp + c.toUpperCase()) + rest;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createBill({ customerName = '' } = {}) {
  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    customerName,
    items: [],
    discount: { type: 'flat', value: 0 },
  };
}

/** Validate a quantity/rate pair. Returns a list of human-readable problems. */
export function validateItemFields({ name, qty, rate }) {
  const errors = [];
  if (!name || !String(name).trim()) errors.push('Item name is missing.');
  if (qty === null || qty === undefined || qty === '') errors.push('Quantity is missing.');
  else if (!Number.isFinite(qty) || qty <= 0) errors.push('Quantity must be more than 0.');
  else if (qty > MAX_QUANTITY) errors.push(`Quantity cannot be more than ${MAX_QUANTITY}.`);
  else if (round3(qty) !== qty) errors.push('Quantity can have at most 3 decimal places.');
  if (rate === null || rate === undefined || rate === '') errors.push('Rate is missing.');
  else if (!Number.isFinite(rate) || rate <= 0) errors.push('Rate must be more than ₹0.');
  else if (rate > MAX_RATE) errors.push('Rate is too large.');
  return errors;
}

export function itemAmount(item) {
  return round2(item.qty * item.rate);
}

export function findItemsByName(bill, name) {
  const key = nameKey(name);
  if (!key) return [];
  const exact = bill.items.filter((it) => nameKey(it.name) === key);
  if (exact.length) return exact;
  // Partial: "oil" matches "Mustard Oil", "mustard oil" matches "Oil".
  const words = key.split(' ');
  return bill.items.filter((it) => {
    const itemWords = nameKey(it.name).split(' ');
    return words.every((w) => itemWords.includes(w)) || itemWords.every((w) => words.includes(w));
  });
}

/**
 * Add an item. Returns { ok, bill, item } or { ok: false, code, errors }.
 * `code: 'duplicate'` means an item with the same name already exists and
 * the caller must ask before adding it again.
 */
export function addItem(bill, fields, { allowDuplicate = false } = {}) {
  const errors = validateItemFields(fields);
  if (errors.length) return { ok: false, code: 'invalid', errors };
  if (bill.items.length >= MAX_ITEMS) return { ok: false, code: 'invalid', errors: [`A bill can have at most ${MAX_ITEMS} items.`] };
  const key = nameKey(fields.name);
  const existing = bill.items.find((it) => nameKey(it.name) === key);
  if (existing && !allowDuplicate) {
    return { ok: false, code: 'duplicate', existing, errors: [`${existing.name} is already on the bill.`] };
  }
  const item = {
    id: newId(),
    name: displayName(fields.name),
    qty: fields.qty,
    unit: fields.unit || '',
    rate: Math.round(fields.rate * 10000) / 10000,
  };
  return { ok: true, bill: { ...bill, items: [...bill.items, item] }, item };
}

/** Update an item's name/qty/unit/rate. Same validation as adding. */
export function updateItem(bill, itemId, changes) {
  const current = bill.items.find((it) => it.id === itemId);
  if (!current) return { ok: false, code: 'not_found', errors: ['That item is no longer on the bill.'] };
  const next = { ...current, ...changes };
  const errors = validateItemFields(next);
  if (errors.length) return { ok: false, code: 'invalid', errors };
  if (changes.name !== undefined) {
    const clash = bill.items.find((it) => it.id !== itemId && nameKey(it.name) === nameKey(next.name));
    if (clash) return { ok: false, code: 'duplicate', existing: clash, errors: [`${clash.name} is already on the bill.`] };
    next.name = displayName(next.name);
  }
  next.rate = Math.round(next.rate * 10000) / 10000;
  return { ok: true, bill: { ...bill, items: bill.items.map((it) => (it.id === itemId ? next : it)) }, item: next };
}

export function removeItem(bill, itemId) {
  const item = bill.items.find((it) => it.id === itemId);
  if (!item) return { ok: false, code: 'not_found', errors: ['That item is no longer on the bill.'] };
  return { ok: true, bill: { ...bill, items: bill.items.filter((it) => it.id !== itemId) }, item };
}

export function setDiscount(bill, discount) {
  const { type, value } = discount;
  if (type !== 'flat' && type !== 'percent') return { ok: false, errors: ['Unknown discount type.'] };
  if (!Number.isFinite(value) || value < 0) return { ok: false, errors: ['Discount cannot be negative.'] };
  if (type === 'percent' && value > 100) return { ok: false, errors: ['Discount cannot be more than 100%.'] };
  const subtotal = computeTotals(bill).subtotal;
  const amount = type === 'percent' ? round2((subtotal * value) / 100) : round2(value);
  if (amount > subtotal) return { ok: false, errors: [`Discount ₹${amount.toFixed(2)} is more than the subtotal ₹${subtotal.toFixed(2)}.`] };
  return { ok: true, bill: { ...bill, discount: { type, value: round2(value) } } };
}

export function computeTotals(bill) {
  // Sum in paise to avoid floating point drift across many items.
  const lines = bill.items.map((it) => ({ id: it.id, amount: itemAmount(it) }));
  const subtotalPaise = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0);
  const subtotal = subtotalPaise / 100;
  const d = bill.discount || { type: 'flat', value: 0 };
  const discount = d.type === 'percent' ? round2((subtotal * d.value) / 100) : round2(d.value || 0);
  const grandTotal = round2(Math.max(0, subtotal - discount));
  return { lines, subtotal, discount, grandTotal, itemCount: bill.items.length };
}

/** Problems that must be fixed before a bill can be saved. */
export function validateBillForSave(bill) {
  const errors = [];
  if (!bill.items.length) errors.push('Add at least one item before saving.');
  for (const it of bill.items) {
    const problems = validateItemFields(it);
    if (problems.length) errors.push(`${it.name || 'Item'}: ${problems.join(' ')}`);
  }
  const t = computeTotals(bill);
  if (t.discount > t.subtotal) errors.push('Discount is more than the subtotal. Change the discount.');
  if (t.discount < 0) errors.push('Discount cannot be negative.');
  return errors;
}

export function formatMoney(n) {
  return round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatQty(n) {
  return String(round3(n));
}
