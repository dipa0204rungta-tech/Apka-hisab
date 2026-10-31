// Optional browser test: dictating a real 18-line shop slip (page 42) the way
// it is written, amount first, and checking every line and the total.
// Run `npm start` first, then: node tests/e2e/slip.e2e.cjs
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

  await page.selectOption('#voice-lang', 'hi-IN');
  await page.click('#btn-mic');
  await page.evaluate(() => window.__speechQueue.push(
    'चना 5 किलो 325 बेसन 10 किलो 840',
    'घी 1 1430',
    'बासमती चावल 20 किलो 2100',
    'चना दाल 6 किलो 450',
    'राजमा 2 किलो 270',
    'मूंग 2 किलो 210',
    'उड़द 2 किलो 270',
    'सरसों तेल 3 इनटू 26 3900',
    'चीनी 30 किलो 3225',
    'मसूर 3 किलो 270',
    'चना दाल 5 किलो 325',
    'आटा 10 किलो 340',
    'फॉर्च्यून 3 टिन 7290',
    'गोल्ड 2 टिन 5340',
    'मूंगफली 4 किलो 520',
    'साबूदाना 1 किलो 150',
    'कलौंजी 10 किलो 600',
  ));
  await page.waitForFunction(() => window.__speechQueue.length === 0);
  await page.waitForTimeout(200);
  await page.click('#btn-mic');

  assert.equal(await page.locator('#bill-rows tr').count(), 18);
  assert.equal(await page.locator('#heard-log .heard-entry.check').count(), 0, 'nothing to check');
  assert.equal(await page.textContent('#t-total'), '₹27,855.00');
  const bill = await page.textContent('#bill-rows');
  for (const s of ['6 kg', '₹75.00', '5 kg', '₹65.00', '3 टिन', '₹2,430.00', '2 टिन', '₹2,670.00', 'सरसों तेल (26 kg)']) {
    assert.ok(bill.includes(s), `bill missing ${s}`);
  }
  await page.click('#btn-save');
  assert.match(await page.textContent('#review-content'), /Grand total₹27,855\.00/);
  await page.screenshot({ path: path.join(OUT, 'slip-review.png'), fullPage: true });

  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('SLIP E2E PASSED');
})().catch((e) => { console.error('SLIP E2E FAILED:', e); process.exit(1); });
