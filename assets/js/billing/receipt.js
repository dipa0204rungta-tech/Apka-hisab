// Builds a printer-independent receipt model from a saved bill, and renders
// it as HTML (browser printing) or fixed-width text (future ESC/POS thermal
// printers: 32 columns on 58 mm paper, 48 columns on 80 mm).

import { formatMoney, formatQty, unitLabel } from './bill.js';

export const PAPER = {
  58: { widthMm: 58, printableMm: 48, columns: 32 },
  80: { widthMm: 80, printableMm: 72, columns: 48 },
};

export function buildReceipt(record) {
  const saved = new Date(record.savedAt || record.createdAt);
  const shop = record.shop || {};
  const totals = record.totals;
  const d = record.discount || { type: 'flat', value: 0 };
  return {
    shopName: shop.shopName || '',
    address: shop.address || '',
    phone: shop.phone || '',
    gstin: shop.gstin || '',
    footer: shop.footer || '',
    billNumber: record.billNumber,
    date: saved.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: saved.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
    customerName: record.customerName || '',
    lines: record.items.map((it) => ({
      name: it.name,
      qty: `${formatQty(it.qty)}${it.unit ? ` ${unitLabel(it.unit)}` : ''}`,
      rate: formatMoney(it.rate),
      amount: formatMoney(totals.lines.find((l) => l.id === it.id)?.amount ?? it.qty * it.rate),
    })),
    subtotal: formatMoney(totals.subtotal),
    discount: totals.discount > 0 ? formatMoney(totals.discount) : '',
    discountLabel: d.type === 'percent' && totals.discount > 0 ? `Discount (${d.value}%)` : 'Discount',
    total: formatMoney(totals.grandTotal),
    itemCount: record.items.length,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderReceiptHtml(r, { paperWidth = '58' } = {}) {
  const paper = PAPER[paperWidth] || PAPER[58];
  const rows = r.lines.map((l) => `
      <tr class="r-name"><td colspan="3">${esc(l.name)}</td></tr>
      <tr class="r-nums"><td>${esc(l.qty)}</td><td>${esc(l.rate)}</td><td>${esc(l.amount)}</td></tr>`).join('');
  return `
  <div class="receipt receipt-${paper.widthMm}" style="width:${paper.printableMm}mm">
    <div class="r-center r-shop">${esc(r.shopName)}</div>
    ${r.address ? `<div class="r-center">${esc(r.address)}</div>` : ''}
    ${r.phone ? `<div class="r-center">Ph: ${esc(r.phone)}</div>` : ''}
    ${r.gstin ? `<div class="r-center">GSTIN: ${esc(r.gstin)}</div>` : ''}
    <div class="r-rule"></div>
    <div class="r-row"><span>Bill: ${esc(r.billNumber)}</span></div>
    <div class="r-row"><span>${esc(r.date)}</span><span>${esc(r.time)}</span></div>
    ${r.customerName ? `<div class="r-row"><span>Customer: ${esc(r.customerName)}</span></div>` : ''}
    <div class="r-rule"></div>
    <table class="r-items">
      <thead><tr><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="r-rule"></div>
    <div class="r-row"><span>Subtotal</span><span>${esc(r.subtotal)}</span></div>
    ${r.discount ? `<div class="r-row"><span>${esc(r.discountLabel)}</span><span>-${esc(r.discount)}</span></div>` : ''}
    <div class="r-row r-total"><span>TOTAL ₹</span><span>${esc(r.total)}</span></div>
    <div class="r-rule"></div>
    <div class="r-center">Items: ${r.itemCount}</div>
    ${r.footer ? `<div class="r-center">${esc(r.footer)}</div>` : ''}
  </div>`;
}

function pad(text, width, align = 'left') {
  const s = String(text);
  if (s.length >= width) return s.slice(0, width);
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}
const center = (s, w) => pad(' '.repeat(Math.max(0, Math.floor((w - String(s).length) / 2))) + s, w);
const twoCol = (l, r, w) => pad(l, w - String(r).length - 1) + ' ' + r;

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.flatMap((l) => (l.length > width ? l.match(new RegExp(`.{1,${width}}`, 'g')) : [l]));
}

/** Plain text receipt for ESC/POS printers. Returns an array of lines. */
export function renderReceiptText(r, { paperWidth = '58' } = {}) {
  const w = (PAPER[paperWidth] || PAPER[58]).columns;
  const rule = '-'.repeat(w);
  const amtW = Math.floor(w * 0.34);
  const rateW = Math.floor(w * 0.3);
  const qtyW = w - amtW - rateW;
  const lines = [];
  for (const l of wrap(r.shopName, w)) lines.push(center(l, w));
  for (const l of r.address ? wrap(r.address, w) : []) lines.push(center(l, w));
  if (r.phone) lines.push(center(`Ph: ${r.phone}`, w));
  if (r.gstin) lines.push(center(`GSTIN: ${r.gstin}`, w));
  lines.push(rule);
  lines.push(`Bill: ${r.billNumber}`);
  lines.push(twoCol(r.date, r.time, w));
  if (r.customerName) lines.push(...wrap(`Customer: ${r.customerName}`, w));
  lines.push(rule);
  lines.push(pad('Qty', qtyW) + pad('Rate', rateW, 'right') + pad('Amount', amtW, 'right'));
  lines.push(rule);
  for (const l of r.lines) {
    lines.push(...wrap(l.name, w));
    lines.push(pad(l.qty, qtyW) + pad(l.rate, rateW, 'right') + pad(l.amount, amtW, 'right'));
  }
  lines.push(rule);
  lines.push(twoCol('Subtotal', r.subtotal, w));
  if (r.discount) lines.push(twoCol(r.discountLabel, `-${r.discount}`, w));
  lines.push(twoCol('TOTAL Rs', r.total, w));
  lines.push(rule);
  lines.push(center(`Items: ${r.itemCount}`, w));
  for (const l of r.footer ? wrap(r.footer, w) : []) lines.push(center(l, w));
  return lines;
}
