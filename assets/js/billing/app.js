import {
  createBill, addItem, updateItem, removeItem, setDiscount, computeTotals, validateBillForSave,
  validateItemFields, findItemsByName, convertQuantity, itemAmount, formatMoney, formatQty, unitLabel, round3,
} from './bill.js';
import { parseCommand } from './voice-parser.js';
import { normaliseDigits } from './numbers.js';
import { speechSupport, listenOnce } from './speech.js';
import { LocalBillStore, DEFAULT_SETTINGS } from './storage.js';
import { buildReceipt, renderReceiptHtml } from './receipt.js';
import { getPrinter, bluetoothPrinter } from './printers.js';

const $ = (id) => document.getElementById(id);
const money = (n) => `₹${formatMoney(n)}`;
const qtyText = (it) => `${formatQty(it.qty)}${it.unit ? ` ${unitLabel(it.unit)}` : ''}`;

const state = {
  bill: createBill(),
  saved: null, // the stored record once the current bill has been saved
  editingId: null,
  undo: null, // { bill, label }
  settings: { ...DEFAULT_SETTINGS },
  listener: null,
  saving: false,
};

let store = null;

// ---------------------------------------------------------------- helpers

function showBanner(message) {
  const b = $('banner');
  b.textContent = message;
  b.hidden = !message;
}

/** Parse a number typed by the user. Returns NaN for anything that is not a plain number. */
function parseInputNumber(value) {
  const s = normaliseDigits(String(value)).trim().replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  return parseFloat(s);
}

function showFeedback(kind, text, actions = []) {
  const box = $('feedback');
  box.replaceChildren();
  box.className = `feedback ${kind}`;
  const p = document.createElement('div');
  p.textContent = text;
  box.append(p);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'fb-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-small${a.primary ? ' btn-primary' : ''}`;
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick, { once: true });
      row.append(btn);
    }
    box.append(row);
  }
  box.hidden = false;
}

function hideFeedback() {
  $('feedback').hidden = true;
}

function undoAction() {
  return state.undo ? [{ label: 'Undo', onClick: doUndo }] : [];
}

function doUndo() {
  if (!state.undo || state.saved) return;
  state.bill = state.undo.bill;
  state.undo = null;
  persistDraft();
  render();
  showFeedback('ok', 'Undone.');
}

function confirmDialog(text, yesLabel = 'Yes') {
  const dlg = $('dlg-confirm');
  $('confirm-text').textContent = text;
  $('confirm-yes').textContent = yesLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

async function persistDraft() {
  if (!store || state.saved) return;
  try {
    await store.saveDraft(state.bill);
  } catch (e) {
    showBanner(`Warning: the bill in progress could not be stored on this device (${e.message}). Save the bill before closing the page.`);
  }
}

/** Replace the current bill, remembering the previous one for Undo. */
function commit(nextBill, undoLabel) {
  state.undo = { bill: state.bill, label: undoLabel };
  state.bill = nextBill;
  persistDraft();
  render();
}

function describeItem(it) {
  return `${qtyText(it)} ${it.name} × ${money(it.rate)} = ${money(itemAmount(it))}`;
}

// ------------------------------------------------------------- operations

function tryAdd(fields, { allowDuplicate = false } = {}) {
  const result = addItem(state.bill, fields, { allowDuplicate });
  if (result.ok) {
    commit(result.bill, 'add');
    flashRow(result.item.id);
    return result;
  }
  if (result.code === 'duplicate') {
    const ex = result.existing;
    showFeedback('ask',
      `${ex.name} is already on the bill (${describeItem(ex)}). To change it, edit that row or say “change ${ex.name} quantity to …”. Add it again as a separate line?`,
      [
        { label: 'Add as new line', primary: true, onClick: () => { const r = tryAdd(fields, { allowDuplicate: true }); if (r.ok) showFeedback('ok', `Added ${describeItem(r.item)}`, undoAction()); } },
        { label: 'Cancel', onClick: () => showFeedback('ok', 'Not added.') },
      ]);
  } else {
    showFeedback('error', result.errors.join(' '));
  }
  return result;
}

/** Find exactly one item for a spoken name, or explain the problem. */
function resolveItem(target) {
  const matches = findItemsByName(state.bill, target);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    showFeedback('ask', `I could not find “${target}” on the bill. Please say the item name as shown in the bill.`);
  } else {
    showFeedback('ask', `More than one item matches “${target}”: ${matches.map((m) => m.name).join(', ')}. Please say the full name.`);
  }
  return null;
}

function applyCommand(cmd) {
  switch (cmd.type) {
    case 'error':
      showFeedback('ask', `${cmd.message}${cmd.partial ? ' You can fill in the missing value in the form below.' : ''}`);
      if (cmd.partial) prefillForm(cmd.partial, cmd.reason);
      return;

    case 'add': {
      const fields = { name: cmd.name, qty: round3(cmd.qty), unit: cmd.unit, rate: cmd.rate };
      const problems = validateItemFields(fields);
      if (problems.length) { showFeedback('ask', problems.join(' ')); prefillForm(fields); return; }
      const r = tryAdd(fields);
      if (r.ok) {
        const note = cmd.priceMode === 'total' ? ` (₹${formatMoney(cmd.total)} total)` : '';
        showFeedback('ok', `Added ${describeItem(r.item)}${note}`, undoAction());
      }
      return;
    }

    case 'change': {
      const item = resolveItem(cmd.target);
      if (!item) return;
      const changes = {};
      if (cmd.field === 'qty') {
        let qty = cmd.qty;
        if (cmd.unit && item.unit && cmd.unit !== item.unit) {
          qty = convertQuantity(cmd.qty, cmd.unit, item.unit);
          if (qty === null) { showFeedback('ask', `${item.name} is sold in ${unitLabel(item.unit)}, not ${unitLabel(cmd.unit)}. Please check the quantity.`); return; }
        } else if (cmd.unit && !item.unit) {
          changes.unit = cmd.unit;
        }
        changes.qty = round3(qty);
      } else {
        changes.rate = cmd.rate;
        if (cmd.rateUnit && item.unit && cmd.rateUnit !== item.unit) {
          const qty = convertQuantity(item.qty, item.unit, cmd.rateUnit);
          if (qty === null) { showFeedback('ask', `${item.name} is in ${unitLabel(item.unit)} but the rate was per ${unitLabel(cmd.rateUnit)}. Please check.`); return; }
          changes.qty = qty;
          changes.unit = cmd.rateUnit;
        }
      }
      const r = updateItem(state.bill, item.id, changes);
      if (!r.ok) { showFeedback('error', r.errors.join(' ')); return; }
      commit(r.bill, 'change');
      flashRow(item.id);
      showFeedback('ok', `Changed: ${describeItem(r.item)}`, undoAction());
      return;
    }

    case 'remove': {
      const item = cmd.last ? state.bill.items[state.bill.items.length - 1] : resolveItem(cmd.target);
      if (!item) { if (cmd.last) showFeedback('ask', 'The bill has no items to remove.'); return; }
      const r = removeItem(state.bill, item.id);
      commit(r.bill, 'remove');
      showFeedback('ok', `Removed ${item.name}.`, undoAction());
      return;
    }

    case 'discount': {
      const r = setDiscount(state.bill, { type: cmd.discountType, value: cmd.value });
      if (!r.ok) { showFeedback('ask', r.errors.join(' ')); return; }
      commit(r.bill, 'discount');
      const t = computeTotals(state.bill);
      showFeedback('ok', cmd.value === 0 ? 'Discount removed.' : `Discount ${money(t.discount)} applied. Total ${money(t.grandTotal)}.`, undoAction());
      return;
    }
    case 'finish':
      openReview({ spoken: true }); // never prints by itself: the shopkeeper taps Print Bill
      return;

    default:
      showFeedback('ask', 'Sorry, I did not understand. Please try again.');
  }
}

function processText(text) {
  const cmd = parseCommand(text);
  if (state.saving) {
    showFeedback('ask', 'Please wait, this bill is being saved.');
    return;
  }
  if (state.saved) {
    if (cmd.type === 'finish') { openPrintPreview(state.saved); return; }
    // The last bill is already saved, so nothing is lost: a new item starts the next bill.
    if (cmd.type !== 'add') {
      showFeedback('ask', 'This bill is already saved. Say a new item to start the next bill, or tap “New Bill”.');
      return;
    }
    startFreshBill();
  }
  applyCommand(cmd);
}

// ------------------------------------------------------------- printing

function speak(text) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = $('voice-lang').value;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* reading aloud is optional */ }
}

async function printOnBluetooth(record, successMessage) {
  showFeedback('ok', `Printing ${record.billNumber}…`);
  try {
    await bluetoothPrinter.print(buildReceipt(record), { paperWidth: state.settings.paperWidth || '58' });
    showFeedback('ok', successMessage);
  } catch (e) {
    showFeedback('error', `${record.billNumber} is saved but did not print: ${e.message}`, [
      { label: 'Print again', primary: true, onClick: () => printOnBluetooth(record, successMessage) },
      { label: 'Use phone print', onClick: () => openPrintPreview(record) },
    ]);
  }
}

// ---------------------------------------------------------------- printer

function renderPrinter() {
  const bt = bluetoothPrinter;
  const status = $('printer-status');
  const connected = bt.isConnected();
  status.classList.toggle('connected', connected);
  if (!bt.isAvailable()) {
    status.textContent = 'This browser cannot connect to Bluetooth printers. Use Chrome on Android (or Bluefy on iPhone). Receipts use the phone\'s print option.';
  } else if (connected) {
    status.textContent = `Connected: ${bt.deviceName()} (${state.settings.paperWidth || '58'} mm paper)`;
  } else if (bt.device) {
    status.textContent = `${bt.deviceName()} is not connected. Switch it on; it reconnects when you print.`;
  } else {
    status.textContent = 'No Bluetooth printer connected. Receipts use the phone\'s print option.';
  }
  $('btn-connect-printer').disabled = !bt.isAvailable();
  $('btn-connect-printer').textContent = bt.device ? 'Change printer' : 'Connect Bluetooth printer';
  $('btn-test-print').disabled = !bt.device;
}

async function connectPrinter() {
  try {
    await bluetoothPrinter.connect();
    showFeedback('ok', `Printer connected: ${bluetoothPrinter.deviceName()}. Tap “Test print” to check it.`);
  } catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'AbortError') return; // closed the chooser
    showFeedback('error', `Could not connect the printer: ${e.message}`);
  } finally {
    renderPrinter();
  }
}

function testPrint() {
  const sample = {
    id: 'test',
    billNumber: 'TEST',
    savedAt: new Date().toISOString(),
    customerName: '',
    items: [{ id: 't1', name: 'Test print / चावल', qty: 1, unit: 'kg', rate: 60 }],
    discount: { type: 'flat', value: 0 },
    shop: state.settings,
  };
  sample.totals = computeTotals(sample);
  printOnBluetooth(sample, 'Test receipt sent. If nothing printed, check paper and that the printer is on.');
}

/** Prefer the top alternative; fall back to another one only if the top one cannot be understood. */
function pickAlternative(alternatives) {
  if (!alternatives.length) return '';
  if (parseCommand(alternatives[0]).type !== 'error') return alternatives[0];
  return alternatives.slice(1).find((a) => parseCommand(a).type !== 'error') ?? alternatives[0];
}

// ------------------------------------------------------------- voice input

function setupVoice() {
  const mic = $('btn-mic');
  const support = speechSupport();
  if (!support.supported) {
    mic.disabled = true;
    $('mic-label').textContent = 'Voice unavailable';
    $('voice-hint').textContent = `${support.reason} You can also type a command in the box below.`;
    return;
  }
  mic.addEventListener('click', () => {
    if (state.listener) { state.listener.stop(); return; }
    hideFeedback();
    $('heard-text').value = '';
    mic.classList.add('listening');
    mic.setAttribute('aria-pressed', 'true');
    $('mic-label').textContent = 'Listening… tap to stop';
    state.listener = listenOnce($('voice-lang').value, {
      onInterim: (text) => { $('heard-text').value = text; },
      onResult: (alternatives) => {
        const chosen = pickAlternative(alternatives);
        $('heard-text').value = chosen;
        if (chosen) processText(chosen);
        else showFeedback('ask', 'I did not hear anything. Please try again.');
      },
      onError: (message) => showFeedback('error', message),
      onEnd: () => {
        state.listener = null;
        mic.classList.remove('listening');
        mic.setAttribute('aria-pressed', 'false');
        $('mic-label').textContent = 'Tap to speak';
      },
    });
  });
}

// ------------------------------------------------------------ manual form

function readForm() {
  return {
    name: $('f-name').value.trim(),
    qty: $('f-qty').value.trim() === '' ? null : parseInputNumber($('f-qty').value),
    unit: $('f-unit').value,
    rate: $('f-rate').value.trim() === '' ? null : parseInputNumber($('f-rate').value),
  };
}

function updateAmountPreview() {
  const { qty, rate } = readForm();
  const ok = Number.isFinite(qty) && Number.isFinite(rate);
  $('f-amount').textContent = ok ? money(itemAmount({ qty, rate })) : '₹0.00';
}

function clearForm() {
  for (const id of ['f-name', 'f-qty', 'f-rate']) { $(id).value = ''; $(id).classList.remove('invalid'); }
  $('f-unit').value = '';
  $('form-errors').hidden = true;
  state.editingId = null;
  $('btn-add-item').textContent = 'Add item';
  $('btn-cancel-edit').hidden = true;
  updateAmountPreview();
}

function prefillForm(partial, reason) {
  if (state.editingId) clearForm();
  $('f-name').value = partial.name ? partial.name : '';
  $('f-qty').value = partial.qty ?? '';
  $('f-unit').value = partial.unit || '';
  $('f-rate').value = partial.rate != null ? String(Math.round(partial.rate * 100) / 100) : '';
  updateAmountPreview();
  const missing = { missing_name: 'f-name', missing_qty: 'f-qty', missing_rate: 'f-rate', ambiguous_price: 'f-rate' }[reason]
    || (!partial.name ? 'f-name' : partial.qty == null ? 'f-qty' : 'f-rate');
  for (const id of ['f-name', 'f-qty', 'f-rate']) $(id).classList.toggle('invalid', id === missing);
  $(missing).focus({ preventScroll: true });
}

function onFormSubmit(event) {
  event.preventDefault();
  if (state.saved) return;
  const fields = readForm();
  const errors = [];
  if (Number.isNaN(fields.qty)) errors.push('Quantity must be a number, e.g. 1.5');
  if (Number.isNaN(fields.rate)) errors.push('Rate must be a number, e.g. 60');
  if (!errors.length) errors.push(...validateItemFields(fields));
  $('f-name').classList.toggle('invalid', !fields.name);
  $('f-qty').classList.toggle('invalid', !(fields.qty > 0));
  $('f-rate').classList.toggle('invalid', !(fields.rate > 0));
  if (errors.length) {
    $('form-errors').textContent = errors.join(' ');
    $('form-errors').hidden = false;
    return;
  }
  $('form-errors').hidden = true;

  if (state.editingId) {
    const r = updateItem(state.bill, state.editingId, fields);
    if (!r.ok) { $('form-errors').textContent = r.errors.join(' '); $('form-errors').hidden = false; return; }
    const id = state.editingId;
    commit(r.bill, 'edit');
    clearForm();
    flashRow(id);
    showFeedback('ok', `Updated ${describeItem(r.item)}`, undoAction());
    return;
  }
  const r = tryAdd(fields);
  if (r.ok) {
    clearForm();
    showFeedback('ok', `Added ${describeItem(r.item)}`, undoAction());
    $('f-name').focus();
  }
}

function startEdit(item) {
  state.editingId = item.id;
  $('f-name').value = item.name;
  $('f-qty').value = formatQty(item.qty);
  $('f-unit').value = item.unit || '';
  $('f-rate').value = String(Math.round(item.rate * 10000) / 10000);
  $('btn-add-item').textContent = 'Update item';
  $('btn-cancel-edit').hidden = false;
  $('form-errors').hidden = true;
  updateAmountPreview();
  render();
  $('f-qty').focus();
  $('item-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// -------------------------------------------------------------- rendering

function flashRow(id) {
  requestAnimationFrame(() => {
    const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  });
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render() {
  const locked = Boolean(state.saved);
  const bill = state.saved || state.bill;
  const totals = computeTotals(bill);

  const status = $('bill-status');
  status.textContent = locked ? `Saved bill ${state.saved.billNumber}` : 'Draft bill (not saved yet)';
  status.classList.toggle('saved', locked);

  const customer = $('customer-name');
  if (document.activeElement !== customer) customer.value = bill.customerName || '';
  customer.disabled = locked;

  const tbody = $('bill-rows');
  tbody.replaceChildren();
  bill.items.forEach((it, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = it.id;
    if (it.id === state.editingId) tr.className = 'editing';
    tr.append(
      cell(String(i + 1), 'c-idx'),
      cell(it.name, 'c-name'),
      cell(qtyText(it), 'c-qty'),
      cell(money(it.rate), 'c-rate num'),
      cell(money(itemAmount(it)), 'c-amount num'),
    );
    const actions = document.createElement('td');
    actions.className = 'c-actions';
    if (!locked) {
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'btn'; edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${it.name}`);
      edit.addEventListener('click', () => startEdit(it));
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn'; del.textContent = 'Remove';
      del.setAttribute('aria-label', `Remove ${it.name}`);
      del.addEventListener('click', () => {
        const r = removeItem(state.bill, it.id);
        if (!r.ok) return;
        if (state.editingId === it.id) clearForm();
        commit(r.bill, 'remove');
        showFeedback('ok', `Removed ${it.name}.`, undoAction());
      });
      wrap.append(edit, del);
      actions.append(wrap);
    }
    tr.append(actions);
    tbody.append(tr);
  });
  $('bill-empty').hidden = bill.items.length > 0;
  $('bill-table').hidden = bill.items.length === 0;

  $('t-subtotal').textContent = money(totals.subtotal);
  $('t-discount').textContent = `−${money(totals.discount)}`;
  $('t-discount').classList.toggle('invalid', totals.discount > totals.subtotal);
  $('t-total').textContent = money(totals.grandTotal);
  const dv = $('discount-value');
  if (document.activeElement !== dv) dv.value = bill.discount?.value ? String(bill.discount.value) : '';
  $('discount-type').value = bill.discount?.type || 'flat';

  for (const el of [dv, $('discount-type'), ...$('discount-form').querySelectorAll('button'),
    ...$('item-form').querySelectorAll('input, select, button')]) {
    el.disabled = locked;
  }
  const busy = state.saving;
  for (const el of $('heard-form').querySelectorAll('input, button')) el.disabled = busy;
  if (speechSupport().supported) $('btn-mic').disabled = busy;

  $('btn-save').disabled = locked || !store || busy;
  $('btn-print').hidden = !locked;
  $('btn-save').hidden = locked;
  $('actions-hint').textContent = locked
    ? 'Bill saved. Tap “Print Again” for another copy, or speak the next item to start a new bill.'
    : 'When the bill is ready, tap “Review & Print Bill” (or say “print the bill”) and check it before printing.';
}

async function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  if (!store) return;
  let bills = [];
  try {
    bills = await store.listBills();
  } catch (e) {
    showBanner(e.message);
  }
  $('history-empty').hidden = bills.length > 0;
  for (const b of bills.slice(0, 10)) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = `${b.billNumber} · ${money(b.totals.grandTotal)}`;
    const meta = document.createElement('div');
    meta.className = 'h-meta';
    meta.textContent = `${new Date(b.savedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${b.customerName ? ` · ${b.customerName}` : ''} · ${b.items.length} item${b.items.length === 1 ? '' : 's'}`;
    info.append(title, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = 'View / Print';
    btn.addEventListener('click', () => openPrintPreview(b));
    li.append(info, btn);
    list.append(li);
  }
}

// ------------------------------------------------------------ save & print

function openReview({ spoken = false } = {}) {
  if (state.saved || !store || state.saving) return;
  state.bill = { ...state.bill, customerName: $('customer-name').value.trim() };
  const errors = validateBillForSave(state.bill);
  if (errors.length) {
    showFeedback('error', errors.join(' '));
    $('feedback').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const t = computeTotals(state.bill);
  const table = document.createElement('table');
  table.className = 'review-table';
  const head = document.createElement('tr');
  for (const [h, num] of [['Item'], ['Qty'], ['Rate', 1], ['Amount', 1]]) {
    const th = document.createElement('th'); th.textContent = h; if (num) th.className = 'num'; head.append(th);
  }
  table.append(head);
  for (const it of state.bill.items) {
    const tr = document.createElement('tr');
    tr.append(cell(it.name), cell(qtyText(it)), cell(money(it.rate), 'num'), cell(money(itemAmount(it)), 'num'));
    table.append(tr);
  }
  const addTotal = (label, value, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    const td = cell(label); td.colSpan = 3;
    tr.append(td, cell(value, 'num'));
    table.append(tr);
  };
  addTotal('Subtotal', money(t.subtotal));
  if (t.discount > 0) addTotal(state.bill.discount.type === 'percent' ? `Discount (${state.bill.discount.value}%)` : 'Discount', `−${money(t.discount)}`);
  addTotal('Grand total', money(t.grandTotal), 'review-total');

  const content = $('review-content');
  content.replaceChildren();
  if (state.bill.customerName) {
    const p = document.createElement('p'); p.textContent = `Customer: ${state.bill.customerName}`; content.append(p);
  }
  content.append(table);
  $('review-printer').textContent = bluetoothPrinter.device
    ? `Prints on ${bluetoothPrinter.deviceName()}.`
    : 'Opens the phone\'s print option (no Bluetooth printer connected).';
  for (const id of ['btn-print-bill', 'btn-save-only']) $(id).disabled = false;
  $('dlg-review').showModal();
  if (spoken) speak($('voice-lang').value === 'hi-IN' ? `कुल ${formatMoney(t.grandTotal)} रुपये` : `Total ${formatMoney(t.grandTotal)} rupees`);
}

/** Save the reviewed bill, then print it when the shopkeeper chose Print Bill. */
async function confirmSave({ print }) {
  if (state.saving || state.saved) return;
  state.saving = true;
  for (const id of ['btn-print-bill', 'btn-save-only']) $(id).disabled = true;
  let record;
  try {
    const { bill, duplicate } = await store.saveBill(state.bill, state.settings);
    record = bill;
    state.saved = bill;
    state.undo = null;
    clearForm();
    await store.clearDraft().catch(() => {});
    showFeedback('ok', duplicate ? `This bill was already saved as ${bill.billNumber}.` : `Bill ${bill.billNumber} saved. Total ${money(bill.totals.grandTotal)}.`);
    renderHistory();
  } catch (e) {
    showFeedback('error', `Bill NOT saved: ${e.message}`);
  } finally {
    $('dlg-review').close();
    state.saving = false;
    render();
  }
  if (record && print) await printRecord(record);
}

async function printRecord(record, paperWidth = state.settings.paperWidth || '58') {
  const done = `Bill ${record.billNumber} saved and printed. Total ${money(record.totals.grandTotal)}. Speak the next item to start a new bill.`;
  if (bluetoothPrinter.device) {
    const previous = state.settings.paperWidth;
    state.settings.paperWidth = paperWidth;
    try { await printOnBluetooth(record, done); } finally { state.settings.paperWidth = previous; }
    return;
  }
  try {
    await getPrinter('browser').print(buildReceipt(record), { paperWidth });
  } catch (e) {
    showFeedback('error', `${record.billNumber} is saved but printing failed: ${e.message}`);
  }
}

let previewRecord = null;

function renderPreview() {
  if (!previewRecord) return;
  $('receipt-preview').innerHTML = renderReceiptHtml(buildReceipt(previewRecord), { paperWidth: $('paper-width').value });
}

function openPrintPreview(record) {
  previewRecord = record;
  $('paper-width').value = state.settings.paperWidth || '58';
  renderPreview();
  $('print-via').textContent = bluetoothPrinter.device
    ? `Prints on ${bluetoothPrinter.deviceName()}.`
    : 'Opens the phone\'s print option. Connect a Bluetooth printer in the Printer section to print directly.';
  $('dlg-print').showModal();
}

async function doPrint() {
  if (!previewRecord) return;
  const btn = $('btn-do-print');
  btn.disabled = true;
  const paperWidth = $('paper-width').value;
  $('dlg-print').close();
  try {
    await printRecord(previewRecord, paperWidth);
  } finally {
    btn.disabled = false;
  }
}

// --------------------------------------------------------- bill lifecycle

async function newBill() {
  if (state.saving) return;
  if (!state.saved && state.bill.items.length) {
    const ok = await confirmDialog('The current bill has not been saved. Discard it and start a new bill?', 'Discard & start new');
    if (!ok) return;
  }
  startFreshBill();
  hideFeedback();
  $('heard-text').value = '';
}

function startFreshBill() {
  state.bill = createBill();
  state.saved = null;
  state.undo = null;
  clearForm();
  $('customer-name').value = '';
  persistDraft();
  render();
}

function openSettings() {
  const form = $('settings-form');
  for (const [k, v] of Object.entries(state.settings)) if (form.elements[k]) form.elements[k].value = v;
  $('dlg-settings').returnValue = '';
  $('dlg-settings').showModal();
}

async function onSettingsClosed() {
  if ($('dlg-settings').returnValue !== 'save' || !store) return;
  const form = $('settings-form');
  const next = { ...state.settings };
  for (const k of ['shopName', 'address', 'phone', 'gstin', 'footer', 'billPrefix', 'paperWidth']) next[k] = form.elements[k].value.trim();
  try {
    state.settings = await store.saveSettings(next);
    renderPrinter();
    showFeedback('ok', 'Shop settings saved.');
  } catch (e) {
    showFeedback('error', e.message);
  }
}

// ------------------------------------------------------------------- init

async function init() {
  try {
    store = new LocalBillStore();
    state.settings = await store.getSettings();
    const draft = await store.loadDraft();
    if (draft && Array.isArray(draft.items) && draft.id) {
      // Never resume a draft that was already saved (e.g. closed mid-save).
      const already = await store.getBill(draft.id);
      if (already) await store.clearDraft();
      else state.bill = { ...createBill(), ...draft };
    }
  } catch (e) {
    store = null;
    showBanner(`${e.message} Bills cannot be saved until this is fixed.`);
  }

  $('voice-lang').value = state.settings.voiceLang || 'en-IN';
  $('voice-lang').addEventListener('change', async () => {
    state.settings.voiceLang = $('voice-lang').value;
    try { if (store) await store.saveSettings(state.settings); } catch { /* not critical */ }
  });

  setupVoice();
  $('heard-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('heard-text').value.trim();
    if (text) processText(text);
  });
  $('item-form').addEventListener('submit', onFormSubmit);
  $('item-form').addEventListener('input', updateAmountPreview);
  $('btn-cancel-edit').addEventListener('click', () => { clearForm(); render(); });
  $('customer-name').addEventListener('input', () => {
    if (state.saved) return;
    state.bill = { ...state.bill, customerName: $('customer-name').value };
    persistDraft();
  });
  $('discount-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('discount-value').value.trim();
    const value = raw === '' ? 0 : parseInputNumber(raw);
    if (Number.isNaN(value)) { showFeedback('error', 'Discount must be a number.'); return; }
    const r = setDiscount(state.bill, { type: $('discount-type').value, value });
    if (!r.ok) { showFeedback('error', r.errors.join(' ')); return; }
    commit(r.bill, 'discount');
    showFeedback('ok', value ? `Discount ${money(computeTotals(state.bill).discount)} applied.` : 'Discount removed.', undoAction());
  });

  $('btn-new-bill').addEventListener('click', newBill);
  $('btn-save').addEventListener('click', openReview);
  $('btn-print-bill').addEventListener('click', () => confirmSave({ print: true }));
  $('btn-save-only').addEventListener('click', () => confirmSave({ print: false }));
  $('btn-print').addEventListener('click', () => state.saved && openPrintPreview(state.saved));
  $('paper-width').addEventListener('change', renderPreview);
  $('btn-do-print').addEventListener('click', doPrint);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-connect-printer').addEventListener('click', connectPrinter);
  $('btn-test-print').addEventListener('click', testPrint);
  bluetoothPrinter.onChange(renderPrinter);
  bluetoothPrinter.reconnectKnown().catch(() => {});
  $('dlg-settings').addEventListener('close', onSettingsClosed);

  // Another tab saved a bill: refresh the list.
  window.addEventListener('storage', (e) => { if (e.key && e.key.includes('bills')) renderHistory(); });

  clearForm();
  render();
  renderPrinter();
  renderHistory();
  window.__billingReady = true;

  // Offline support and "Add to Home Screen" when served over http(s).
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && document.querySelector('link[rel=manifest]')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }
}

init();
