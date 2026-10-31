// Optional browser test: the app asks for a missing rate and the shopkeeper
// answers in the next phrase, in different ways. Each answer must complete
// the same item, not start a new question.
// Run `npm start` first, then: node tests/e2e/voice-answer.e2e.cjs
const { chromium } = require('playwright');
const assert = require('assert');
const URL = process.env.E2E_URL || 'http://localhost:8080/';

const mocks = () => {
  window.__speechQueue = [];
  class FakeRecognition {
    start() {
      const next = window.__speechQueue.shift();
      if (next === undefined) { this.idle = true; this.timer = setTimeout(() => { this.idle = false; this.onend?.(); }, 400); return; }
      setTimeout(() => {
        this.onresult?.({ results: [Object.assign([{ transcript: next }], { isFinal: true })] });
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
    'चावल 2 किलो', '60',                     // bare number = the rate asked for
    'चीनी 5 किलो', 'चीनी 45 रुपये किलो',      // name said again with the rate
    'दाल 1 किलो', 'दाल का रेट 120',           // "का रेट"
    'आटा 10 किलो', '40 का किलो',
    'तेल', '2 लीटर', '150 वाला',              // three parts
  ));
  await page.waitForFunction(() => window.__speechQueue.length === 0);
  await page.waitForTimeout(300);
  await page.click('#btn-mic');

  const bill = await page.textContent('#bill-rows');
  assert.equal(await page.locator('#bill-rows tr').count(), 5, bill);
  // 120 + 225 + 120 + 400 + 300
  assert.equal(await page.textContent('#t-total'), '₹1,165.00', bill);
  assert.equal(await page.locator('#heard-log .heard-entry.check').count(), 0, await page.textContent('#heard-log'));
  assert.deepEqual(errors, [], 'console errors');
  await browser.close();
  console.log('VOICE ANSWER E2E PASSED');
})().catch((e) => { console.error('VOICE ANSWER E2E FAILED:', e); process.exit(1); });
