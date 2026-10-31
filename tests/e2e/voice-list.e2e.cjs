// Optional browser test: speaking a long list of items in one go, checking
// the "What I heard" list, fixing a problem item, then review and print.
// Run `npm start` first, then: node tests/e2e/voice-list.e2e.cjs
const { chromium } = require('playwright');
const assert = require('assert');
const path = require('path');
const OUT = process.env.E2E_OUT || require('os').tmpdir();
const URL = process.env.E2E_URL || 'http://localhost:8080/';

const mocks = () => {
  window.__speechQueue = [];
  window.__printed = [];
  window.print = () => { window.__printed.push(document.getElementById('print-root').innerHTML); };
  class FakeRecognition {
    start() {
      window.__starts = (window.__starts || 0) + 1;
      const next = window.__speechQueue.shift();
      // Silence: a real browser ends the session after a while, then the app restarts it.
      if (next === undefined) { this.idle = true; this.timer = setTimeout(() => { this.idle = false; this.onend?.(); }, 400); return; }
      setTimeout(() => {
        const res = Object.assign([{ transcript: next }], { isFinal: true });
        this.onresult?.({ results: [res] });
        this.onend?.();
      }, 30);
    }
    stop() { if (this.idle) { clearTimeout(this.timer); setTimeout(() => this.onend?.(), 10); } }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
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

  const listening = () => page.evaluate(() => document.getElementById('btn-mic').classList.contains('listening'));
  const rows = () => page.locator('#bill-rows tr').count();
  const entries = (cls) => page.locator(`#heard-log .heard-entry${cls ? `.${cls}` : ''}`).count();

  await page.selectOption('#voice-lang', 'hi-IN');
  await page.click('#btn-mic');
  assert.ok(await listening());

  // One long breath with several items, then separate phrases with pauses.
  await page.evaluate(() => window.__speechQueue.push(
    'चावल 5 किलो 40 रुपये किलो दाल 30 किलो का बोरा 2000 रुपये प्रति बोरा 3 करके और गुड़ 10 किलो 45 रुपये प्रति किलो करके',
    'मिर्ची 500 ग्राम 200 रुपये किलो',
    'चीनी 25 किलो का बोरा 4 बोरा 1200 रेट',
    'हल्दी 2 किलो',
    'चावल 5 किलो 40 रुपये किलो',
    'आटा 10 किलो 32 रुपये किलो फिर तेल 2 लीटर 150 रुपये लीटर फिर नमक 2 पैकेट 25 रुपये पैकेट',
  ));
  await page.waitForFunction(() => window.__speechQueue.length === 0);
  await page.waitForTimeout(150);
  assert.ok(await listening(), 'mic must keep listening between phrases');
  assert.ok(await page.evaluate(() => window.__starts) >= 7, 'mic restarts after each pause');

  assert.equal(await rows(), 8);
  assert.equal(await entries('ok'), 8);
  assert.equal(await entries('check'), 2); // हल्दी without price, चावल said twice
  assert.equal(await page.textContent('#heard-summary'), '2 to check');
  const billText = await page.textContent('#bill-rows');
  for (const s of ['चावल', 'दाल (30 kg)', '3 बोरा', 'गुड़', 'मिर्ची', '0.5 kg', 'चीनी (25 kg)', '4 बोरा', 'आटा', 'तेल', 'नमक']) {
    assert.ok(billText.includes(s), `bill missing ${s}`);
  }
  // 200 + 6000 + 450 + 100 + 4800 + 320 + 300 + 50
  assert.equal(await page.textContent('#t-total'), '₹12,220.00');

  // Duplicate: skip it. Missing price: fix it in the form.
  const dup = page.locator('#heard-log .heard-entry.check', { hasText: 'already on the bill' });
  await dup.locator('button', { hasText: 'Skip' }).click();
  const missing = page.locator('#heard-log .heard-entry.check', { hasText: 'हल्दी' });
  await missing.locator('button', { hasText: 'Fix' }).click();
  assert.equal(await page.inputValue('#f-name'), 'हल्दी');
  assert.equal(await page.inputValue('#f-qty'), '2');
  await page.fill('#f-rate', '160');
  await page.click('#btn-add-item');
  assert.equal(await entries('check'), 0);
  assert.equal(await page.textContent('#heard-summary'), '');
  assert.equal(await rows(), 9);
  assert.equal(await page.textContent('#t-total'), '₹12,540.00');

  // Remove one from the list, then a discount and "print the bill" by voice.
  await page.locator('#heard-log .heard-entry.ok', { hasText: 'नमक' }).locator('button', { hasText: 'Remove' }).click();
  assert.equal(await rows(), 8);
  await page.screenshot({ path: path.join(OUT, 'voice-list.png'), fullPage: true });

  if (!(await listening())) await page.click('#btn-mic');
  await page.evaluate(() => window.__speechQueue.push('40 रुपये छूट दो', 'बिल प्रिंट करो'));
  await page.waitForFunction(() => document.getElementById('dlg-review').open);
  assert.ok(!(await listening()), '"print the bill" stops listening');
  const review = await page.textContent('#review-content');
  assert.match(review, /Discount−₹40\.00/);
  assert.match(review, /Grand total₹12,450\.00/);
  assert.equal((await page.evaluate(() => window.__printed)).length, 0, 'nothing prints before Print Bill');
  await page.screenshot({ path: path.join(OUT, 'voice-list-review.png') });
  await page.click('#btn-print-bill');
  await page.waitForFunction(() => document.getElementById('bill-status').textContent.includes('Saved'));
  await page.waitForTimeout(1200);
  const printed = await page.evaluate(() => window.__printed);
  assert.equal(printed.length, 1);
  for (const s of ['चावल', 'दाल (30 kg)', 'चीनी (25 kg)', 'हल्दी', '12,450.00']) assert.ok(printed[0].includes(s) || printed[0].includes(s.replace(',', '')), `receipt missing ${s}`);

  // Speaking the next list starts a new bill and a fresh "What I heard" list.
  await page.click('#btn-mic');
  await page.evaluate(() => window.__speechQueue.push('चावल 2 किलो 40 रुपये किलो दाल 1 किलो 100 रुपये किलो'));
  await page.waitForFunction(() => window.__speechQueue.length === 0);
  await page.waitForTimeout(150);
  await page.click('#btn-mic');
  assert.equal(await page.textContent('#bill-status'), 'Draft bill (not saved yet)');
  assert.equal(await rows(), 2);
  assert.equal(await entries(), 2);

  // A typed/pasted list works the same way.
  await page.fill('#heard-text', 'सूजी 1 किलो 45 रुपये किलो\nबेसन 2 किलो 90 रुपये किलो');
  await page.click('#heard-form button');
  assert.equal(await rows(), 4);

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll on mobile');
  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('VOICE LIST E2E PASSED');
})().catch((e) => { console.error('VOICE LIST E2E FAILED:', e); process.exit(1); });
