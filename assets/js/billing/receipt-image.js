// Draws a receipt (from buildReceipt) onto a canvas at the printer's exact
// dot width, ready to be packed into an ESC/POS raster image.

import { PRINTER_DOTS, packBitmap } from './escpos.js';

const FONT = '"Noto Sans", "Noto Sans Devanagari", Roboto, Arial, sans-serif';

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Returns a canvas with the receipt drawn in black on white. */
export function drawReceipt(receipt, { paperWidth = '58' } = {}) {
  const W = PRINTER_DOTS[paperWidth] || PRINTER_DOTS[58];
  const base = paperWidth === '80' ? 26 : 22;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 6000;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  let y = 4;

  const font = (size, bold = false) => { ctx.font = `${bold ? '700' : '400'} ${size}px ${FONT}`; };
  const text = (s, align = 'left', x) => {
    ctx.textAlign = align;
    ctx.fillText(s, x ?? (align === 'center' ? W / 2 : align === 'right' ? W : 0), y);
  };
  const line = (size) => { y += Math.round(size * 1.3); };
  const centered = (s, size, bold) => {
    font(size, bold);
    for (const l of wrapText(ctx, s, W)) { text(l, 'center'); line(size); }
  };
  const rule = () => {
    y += 4;
    for (let x = 0; x < W; x += 10) ctx.fillRect(x, y, 6, 2);
    y += 8;
  };
  const pair = (left, right, size, bold) => {
    font(size, bold);
    text(left, 'left');
    text(right, 'right');
    line(size);
  };

  centered(receipt.shopName, Math.round(base * 1.35), true);
  if (receipt.address) centered(receipt.address, base);
  if (receipt.phone) centered(`Ph: ${receipt.phone}`, base);
  if (receipt.gstin) centered(`GSTIN: ${receipt.gstin}`, base);
  rule();
  font(base); text(`Bill: ${receipt.billNumber}`); line(base);
  pair(receipt.date, receipt.time, base);
  if (receipt.customerName) {
    font(base);
    for (const l of wrapText(ctx, `Customer: ${receipt.customerName}`, W)) { text(l); line(base); }
  }
  rule();

  const rateRight = Math.round(W * 0.66);
  font(base, true);
  text('Qty'); text('Rate', 'right', rateRight); text('Amount', 'right'); line(base);
  rule();
  for (const l of receipt.lines) {
    font(base, true);
    for (const n of wrapText(ctx, l.name, W)) { text(n); line(base); }
    font(base);
    text(l.qty); text(l.rate, 'right', rateRight); text(l.amount, 'right'); line(base);
    y += 2;
  }
  rule();
  pair('Subtotal', receipt.subtotal, base);
  if (receipt.discount) pair(receipt.discountLabel, `-${receipt.discount}`, base);
  pair('TOTAL ₹', receipt.total, Math.round(base * 1.35), true);
  rule();
  centered(`Items: ${receipt.itemCount}`, base);
  if (receipt.footer) centered(receipt.footer, base);
  y += 8;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = Math.min(y, canvas.height);
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

/** Receipt -> 1-bit bitmap for encodeRaster(). */
export function receiptBitmap(receipt, options) {
  const canvas = drawReceipt(receipt, options);
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
  }
  return packBitmap(gray, width, height);
}
