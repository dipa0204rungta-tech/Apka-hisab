// Optional browser test of review-then-print with a simulated Bluetooth LE
// printer. Run `npm start` first, then: node tests/e2e/printer.e2e.cjs
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const OUT = process.env.E2E_OUT || require('os').tmpdir();
const URL = process.env.E2E_URL || 'http://localhost:8080/';

const mocks = () => {
  window.__speechQueue = [];
  window.__btBytes = [];
  window.__btFail = false;
  // Behaves like the browser: each start() hears the next queued phrase (or
  // stays quiet), then ends; the app restarts it until the mic is tapped off.
  class FakeRecognition {
    start() {
      const next = window.__speechQueue.shift();
      if (next === undefined) { this.idle = true; return; }
      setTimeout(() => {
        if (next && next.error) { this.onerror?.({ error: next.error }); this.onend?.(); return; }
        const text = Array.isArray(next) ? next[0] : next;
        this.onresult?.({ results: [Object.assign([{ transcript: text.slice(0, 5) }], { isFinal: false })] });
        const res = Object.assign([{ transcript: text }], { isFinal: true });
        this.onresult?.({ results: [res] });
        this.onresult?.({ results: [res] }); // duplicate final event, must be ignored
        this.onend?.();
      }, 30);
    }
    stop() { if (this.idle) setTimeout(() => this.onend?.(), 10); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const characteristic = {
    properties: { writeWithoutResponse: true, write: true },
    async writeValueWithoutResponse(v) {
      if (window.__btFail) throw new Error('GATT operation failed');
      if (v.length > 180) throw new Error('packet too big');
      window.__btBytes.push(...v);
    },
  };
  const device = {
    name: 'PT-210_BLE',
    gatt: {
      connected: false,
      async connect() { this.connected = true; return { async getPrimaryServices() { return [{ async getCharacteristics() { return [characteristic]; } }]; } }; },
      disconnect() { this.connected = false; },
    },
    addEventListener() {},
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { async requestDevice() { return device; } } });
};

// Turn the ESC/POS raster bytes back into an image (what the paper would show).
const decodeToPng = (bytes) => {
  let i = 2, rows = [], width = 0;
  while (i < bytes.length && bytes[i] === 0x1d && bytes[i + 1] === 0x76) {
    const xb = bytes[i + 4] + bytes[i + 5] * 256, h = bytes[i + 6] + bytes[i + 7] * 256;
    width = xb * 8; i += 8;
    for (let r = 0; r < h; r++) { rows.push(bytes.slice(i, i + xb)); i += xb; }
  }
  const c = document.createElement('canvas'); c.width = width; c.height = rows.length;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(width, rows.length);
  rows.forEach((row, y) => { for (let x = 0; x < width; x++) { const on = row[x >> 3] & (0x80 >> (x & 7)); const k = (y * width + x) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = on ? 0 : 255; img.data[k + 3] = 255; } });
  ctx.putImageData(img, 0, 0);
  return { png: c.toDataURL('image/png'), width, height: rows.length, tail: bytes.slice(-7) };
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(mocks);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // Tap the mic, speak the phrases (with pauses between them), tap the mic off.
  const say = async (...phrases) => {
    await page.evaluate((a) => window.__speechQueue.push(...a), phrases);
    if (!(await page.evaluate(() => document.getElementById('btn-mic').classList.contains('listening')))) await page.click('#btn-mic');
    await page.waitForFunction(() => window.__speechQueue.length === 0);
    await page.waitForTimeout(120);
    if (await page.evaluate(() => document.getElementById('btn-mic').classList.contains('listening'))) await page.click('#btn-mic');
    await page.waitForFunction(() => !document.getElementById('btn-mic').classList.contains('listening'));
  };
  const fb = () => page.textContent('#feedback');
  const bytes = () => page.evaluate(() => window.__btBytes.length);

  await page.click('#btn-settings');
  await page.fill('[name=shopName]', 'Gupta Kirana Store');
  await page.fill('[name=phone]', '98765 43210');
  await page.click('#dlg-settings button[value=save]');

  await say('Add two kilos of rice at 60 rupees per kilo');
  await say('दो किलो चीनी 45 रुपये किलो');
  await say('Add one litre of oil for 150 rupees');

  // "print the bill" opens the review; nothing prints until Print Bill is tapped
  await page.click('#btn-connect-printer');
  await page.waitForFunction(() => document.getElementById('printer-status').textContent.startsWith('Connected'));
  assert.equal(await page.textContent('#printer-status'), 'Connected: PT-210_BLE (58 mm paper)');

  await page.click('#btn-test-print');
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('Test receipt sent'));
  assert.ok((await bytes()) > 1000);
  await page.evaluate(() => { window.__btBytes = []; });

  await say('Apply a discount of 10 rupees');
  await say('bill print kar do');
  assert.ok(await page.isVisible('#dlg-review'));
  assert.match(await page.textContent('#review-content'), /Grand total₹350\.00/);
  assert.match(await page.textContent('#review-printer'), /Prints on PT-210_BLE/);
  await page.waitForTimeout(3000);
  assert.equal(await bytes(), 0, 'printed without a tap');
  assert.equal(await page.textContent('#bill-status'), 'Draft bill (not saved yet)');

  // Shopkeeper goes back, fixes something, reviews again and taps Print Bill
  await page.click('#dlg-review button[value=cancel]');
  await page.click('#btn-save');
  await page.screenshot({ path: path.join(OUT, 'review-dialog.png') });
  await page.click('#btn-print-bill');
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('saved and printed'), null, { timeout: 10000 });
  assert.equal(await page.textContent('#bill-status'), 'Saved bill AH-00001');
  const decoded = await page.evaluate(decodeToPng, await page.evaluate(() => window.__btBytes));
  assert.equal(decoded.width, 384);
  assert.deepEqual(decoded.tail, [0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0]);
  fs.writeFileSync(path.join(OUT, 'bluetooth-receipt-58.png'), Buffer.from(decoded.png.split(',')[1], 'base64'));

  // Speaking the next item starts the next bill automatically
  await say('add 1 kg salt at 25 rupees');
  assert.equal(await page.textContent('#bill-status'), 'Draft bill (not saved yet)');
  assert.equal(await page.locator('#bill-rows tr').count(), 1);
  assert.match(await page.textContent('#history-list'), /AH-00001 · ₹350\.00/);

  // Printer failure: bill is still saved, user can retry
  await page.evaluate(() => { window.__btFail = true; window.__btBytes = []; });
  await say('print the bill');
  await page.click('#btn-print-bill');
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('did not print'), null, { timeout: 10000 });
  assert.equal(await page.textContent('#bill-status'), 'Saved bill AH-00002');
  await page.evaluate(() => { window.__btFail = false; });
  await page.click('#feedback button:has-text("Print again")');
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('saved and printed'));
  assert.ok((await bytes()) > 1000);

  // 80 mm paper from settings
  await page.click('#btn-settings');
  await page.selectOption('[name=paperWidth]', '80');
  await page.click('#dlg-settings button[value=save]');
  await page.evaluate(() => { window.__btBytes = []; });
  await page.click('#history-list li:first-child button');
  assert.match(await page.textContent('#print-via'), /Prints on PT-210_BLE/);
  await page.click('#btn-do-print');
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('printed'));
  const wide = await page.evaluate(decodeToPng, await page.evaluate(() => window.__btBytes));
  assert.equal(wide.width, 576);
  fs.writeFileSync(path.join(OUT, 'bluetooth-receipt-80.png'), Buffer.from(wide.png.split(',')[1], 'base64'));

  await page.screenshot({ path: path.join(OUT, 'printer-section.png'), fullPage: true });
  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('PRINTER E2E PASSED');
})().catch((e) => { console.error('PRINTER E2E FAILED:', e); process.exit(1); });
