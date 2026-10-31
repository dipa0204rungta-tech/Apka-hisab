const { chromium } = require('playwright');
const assert = require('assert');
// Optional browser test. Needs Playwright with Chromium and the dev server:
//   npm start   (in another terminal)
//   node tests/e2e/billing.e2e.cjs
const OUT = process.env.E2E_OUT || require('os').tmpdir();
const URL = process.env.E2E_URL || 'http://localhost:8080/';

const mockSpeech = () => {
  window.__speechQueue = [];
  window.__printed = [];
  window.print = () => { window.__printed.push(document.getElementById('print-root').innerHTML); };
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
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(mockSpeech);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);

  // Tap the mic, speak the phrases (with pauses between them), tap the mic off.
  const say = async (...phrases) => {
    await page.evaluate((a) => window.__speechQueue.push(...a), phrases);
    if (!(await page.evaluate(() => document.getElementById('btn-mic').classList.contains('listening')))) await page.click('#btn-mic');
    await page.waitForFunction(() => window.__speechQueue.length === 0);
    await page.waitForTimeout(120);
    if (await page.evaluate(() => document.getElementById('btn-mic').classList.contains('listening'))) await page.click('#btn-mic');
    await page.waitForFunction(() => !document.getElementById('btn-mic').classList.contains('listening'));
  };
  const total = () => page.textContent('#t-total');
  const rows = () => page.locator('#bill-rows tr').count();
  const fb = () => page.textContent('#feedback');

  // Shop settings
  await page.click('#btn-settings');
  await page.fill('[name=shopName]', 'Gupta Kirana Store');
  await page.fill('[name=phone]', '98765 43210');
  await page.fill('[name=address]', '12 Main Bazaar, Jaipur');
  await page.click('#dlg-settings button[value=save]');

  await say('Add two kilos of rice at 60 rupees per kilo.');
  assert.equal(await page.inputValue('#heard-text'), 'Add two kilos of rice at 60 rupees per kilo.');
  assert.equal(await rows(), 1, 'duplicate final event added twice');
  assert.equal(await total(), '₹120.00');

  await say('Add one litre of oil for 150 rupees.');
  assert.equal(await total(), '₹270.00');

  await say('add 2 kg chawal at 60 per kg');
  assert.match(await fb(), /already on the bill/);
  assert.equal(await rows(), 2);

  await say('Change the rice quantity to three kilos.');
  assert.equal(await total(), '₹330.00');

  // Ambiguous price -> asks, prefills the form, nothing added
  // Price left out: nothing is guessed; Fix fills the form with what was heard
  await say('add 2 kg sugar');
  assert.match(await fb(), /price of sugar/);
  assert.equal(await rows(), 2);
  await page.locator('#heard-log .heard-entry.check', { hasText: 'sugar' }).locator('button', { hasText: 'Fix' }).click();
  assert.equal(await page.inputValue('#f-name'), 'sugar');
  assert.equal(await page.inputValue('#f-qty'), '2');
  assert.equal(await page.inputValue('#f-rate'), '');
  await page.fill('#f-rate', '40');
  await page.click('#btn-add-item');
  assert.equal(await total(), '₹410.00');

  // Missing price via voice, alternatives: second alt is complete
  await say('add half kilo tea');
  assert.match(await fb(), /What is the price of tea/);
  await say('add half kilo tea at 480 per kilo');
  assert.equal(await page.inputValue('#heard-text'), 'add half kilo tea at 480 per kilo');
  assert.equal(await total(), '₹650.00');
  await page.click('#btn-cancel-edit').catch(() => {});
  await page.evaluate(() => { for (const id of ['f-name', 'f-qty', 'f-rate']) document.getElementById(id).value = ''; });

  // Manual decimal entry + validation
  await page.fill('#f-name', 'Ghee');
  await page.fill('#f-qty', '0.75');
  await page.selectOption('#f-unit', 'kg');
  await page.fill('#f-rate', 'abc');
  await page.click('#btn-add-item');
  assert.ok(await page.isVisible('#form-errors'));
  await page.fill('#f-rate', '600.50');
  assert.equal(await page.textContent('#f-amount'), '₹450.38');
  await page.click('#btn-add-item');
  assert.equal(await total(), '₹1,100.38');

  // Remove + undo, Hindi remove
  await say('Remove the oil.');
  assert.equal(await total(), '₹950.38');
  await page.click('#feedback button:has-text("Undo")');
  assert.equal(await total(), '₹1,100.38');
  await say('तेल हटा दो');
  assert.equal(await total(), '₹950.38');

  // Edit via row button
  await page.click('#bill-rows tr:first-child button:has-text("Edit")');
  await page.fill('#f-qty', '2.5');
  await page.click('#btn-add-item');
  assert.equal(await total(), '₹920.38');

  await say('Apply a discount of 10 rupees.');
  assert.equal(await total(), '₹910.38');
  await say('discount 5000 rupees');
  assert.match(await fb(), /more than the subtotal/);
  assert.equal(await total(), '₹910.38');

  // Speech errors
  await page.evaluate(() => window.__speechQueue.push({ error: 'not-allowed' }));
  await page.click('#btn-mic');
  await page.waitForFunction(() => !document.getElementById('btn-mic').classList.contains('listening'));
  assert.match(await fb(), /Microphone permission was denied/);
  // Saying "print the bill" only opens the review; nothing prints or saves
  await say('print the bill');
  assert.ok(await page.isVisible('#dlg-review'));
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(() => window.__printed)).length, 0, 'printed without user action');
  await page.click('#dlg-review button[value=cancel]');
  assert.equal(await page.textContent('#bill-status'), 'Draft bill (not saved yet)');

  await page.fill('#customer-name', 'Ramesh');
  await page.screenshot({ path: `${OUT}/mobile-draft.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll on mobile');

  // Refresh keeps the draft
  await page.reload();
  assert.equal(await rows(), 4);
  assert.equal(await total(), '₹910.38');
  assert.equal(await page.inputValue('#customer-name'), 'Ramesh');

  // Review, then the shopkeeper taps Print Bill: saved once and printed once
  assert.ok(await page.isHidden('#btn-print'));
  await page.click('#btn-save');
  assert.ok(await page.isVisible('#dlg-review'));
  assert.match(await page.textContent('#review-content'), /Grand total₹910\.38/);
  assert.equal((await page.evaluate(() => window.__printed)).length, 0, 'printed before Print Bill was tapped');
  await page.screenshot({ path: `${OUT}/review.png` });
  // double tap must not create two bills or two prints
  await page.dblclick('#btn-print-bill');
  await page.waitForFunction(() => document.getElementById('bill-status').textContent.includes('Saved'));
  await page.waitForTimeout(1200);
  assert.equal(await page.textContent('#bill-status'), 'Saved bill AH-00001');
  assert.ok(!(await page.isDisabled('#btn-mic')), 'mic stays usable to start the next bill');
  assert.ok(await page.isHidden('#btn-save'));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('apkaHisab.billing.v1.bills')).length), 1);
  assert.equal((await page.evaluate(() => window.__printed)).length, 1, 'Print Bill should print exactly once');

  // Print Again: preview then print on 80 mm
  await page.click('#btn-print');
  assert.ok(await page.isVisible('#dlg-print'));
  await page.screenshot({ path: `${OUT}/print-preview-58.png` });
  await page.selectOption('#paper-width', '80');
  await page.click('#btn-do-print');
  const printed = await page.evaluate(() => window.__printed);
  assert.equal(printed.length, 2);
  for (const needle of ['Gupta Kirana Store', '98765 43210', 'AH-00001', 'Rice', 'Sugar', 'Tea', 'Ghee', '920.38', '-10.00', '910.38', 'Ramesh']) {
    assert.ok(printed[0].includes(needle), `receipt missing ${needle}`);
  }
  assert.match(printed[0], /receipt-58/);
  assert.match(printed[1], /receipt-80/);

  // Refresh after save: bill kept in history, new empty bill
  await page.reload();
  assert.equal(await rows(), 0);
  assert.match(await page.textContent('#history-list'), /AH-00001 · ₹910\.38/);

  // Second bill gets the next number; New Bill on unsaved bill asks first
  await say('add 1 kg salt at 25 rupees');
  await page.click('#btn-new-bill');
  assert.ok(await page.isVisible('#dlg-confirm'));
  await page.click('#dlg-confirm button[value=no]');
  assert.equal(await rows(), 1);
  await page.click('#btn-save');
  await page.click('#btn-save-only');
  await page.waitForFunction(() => document.getElementById('bill-status').textContent.includes('AH-00002'));
  await page.click('#btn-new-bill');
  assert.equal(await rows(), 0);
  assert.equal(await page.locator('#history-list li').count(), 2);

  // Real print-media rendering of the receipt (58 mm) to PDF for a visual check
  await page.evaluate((html) => { const r = document.getElementById('print-root'); r.innerHTML = html; document.body.classList.add('printing-receipt'); const s = document.createElement('style'); s.textContent = '@page { size: 58mm auto; margin: 0 }'; document.head.append(s); }, printed[0]);
  await page.emulateMedia({ media: 'print' });
  await page.screenshot({ path: `${OUT}/receipt-print-media.png`, fullPage: true });
  await page.pdf({ path: `${OUT}/receipt-58.pdf`, width: '58mm', height: '200mm', printBackground: true });

  // Browser without speech recognition: manual fallback
  const ctx2 = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  await ctx2.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(URL);
  assert.ok(await p2.isDisabled('#btn-mic'));
  assert.match(await p2.textContent('#voice-hint'), /not supported/);
  await p2.fill('#f-name', 'Bread'); await p2.fill('#f-qty', '2'); await p2.fill('#f-rate', '45');
  await p2.click('#btn-add-item');
  await p2.fill('#heard-text', 'add 1 packet biscuit for 30 rupees');
  await p2.click('#heard-form button');
  assert.equal(await p2.textContent('#t-total'), '₹120.00');
  await p2.screenshot({ path: `${OUT}/desktop-no-voice.png`, fullPage: true });

  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('E2E PASSED');
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
