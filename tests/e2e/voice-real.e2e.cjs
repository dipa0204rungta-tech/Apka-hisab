// Optional browser test replaying a real shop session: items spoken in parts
// with pauses, misheard names, and conversation picked up by the mic.
// Run `npm start` first, then: node tests/e2e/voice-real.e2e.cjs
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
  const rows = () => page.locator('#bill-rows tr').count();
  const entries = (cls) => page.locator(`#heard-log .heard-entry${cls ? `.${cls}` : ''}`).count();

  await page.selectOption('#voice-lang', 'hi-IN');
  await page.click('#btn-mic');
  await page.evaluate(() => window.__speechQueue.push(
    'मिर्ची 500 ग्राम rs 2000 किलो',
    'जरा 200 ग्राम',                       // जीरा misheard, rate comes after a pause
    '400 रुपये किलो',
    'कंजू',                                 // काजू misheard, said in three parts
    'आधा किलो',
    '800 रुपये किलो',
    'हीरा में क्या करें लग गया रे',          // conversation near the phone
    'बार्बी',                               // stray word
    '25 kg चावल का 4 बोरा ₹2,000 करके',      // size + count + rate
    'लगा नहीं चाहिए दीदी को बता दिया',
  ));
  await page.waitForFunction(() => window.__speechQueue.length === 0);
  await page.waitForTimeout(200);
  await page.click('#btn-mic');

  const bill = await page.textContent('#bill-rows');
  assert.equal(await rows(), 4, bill);
  for (const s of ['मिर्ची', 'जीरा', '0.2 kg', 'काजू', '0.5 kg', 'चावल (25 kg)', '4 बोरा']) assert.ok(bill.includes(s), `bill missing ${s}: ${bill}`);
  // 1000 + 80 + 400 + 8000
  assert.equal(await page.textContent('#t-total'), '₹9,480.00');
  assert.equal(await entries('check'), 0, 'nothing left to check');
  assert.equal(await page.textContent('#heard-summary'), '');
  assert.equal(await entries('ok'), 4);
  const log = await page.textContent('#heard-log');
  assert.match(log, /heard “जरा”/);
  assert.match(log, /heard “कंजू”/);
  assert.equal((log.match(/Not an item, ignored/g) || []).length, 2);
  assert.match(log, /Only the name “बार्बी” was heard/);
  assert.equal(await page.inputValue('#f-name'), '', 'form stays empty while speaking');
  await page.screenshot({ path: path.join(OUT, 'voice-real.png'), fullPage: true });

  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('VOICE REAL-SESSION E2E PASSED');
})().catch((e) => { console.error('VOICE REAL-SESSION E2E FAILED:', e); process.exit(1); });
