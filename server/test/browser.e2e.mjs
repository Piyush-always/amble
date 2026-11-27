// Browser end-to-end test of the website against the local order API with a fake Razorpay.
// 1. serve the site:        python -m http.server 8080      (from the repo root)
// 2. start the API:         node test/dev-server.mjs        (from /server)
// 3. run:                   node test/browser.e2e.mjs       (CHROME_PATH=... if Chrome is elsewhere)
// The page's config.js is swapped for one pointing at the local API, and Razorpay's checkout.js for a stub
// that "pays" through the dev server, so no keys and no real money are involved.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const SITE = process.env.SITE || 'http://localhost:8080', API = process.env.API || 'http://localhost:8787';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.OUT || os.tmpdir();
const FAKE_RZP = `
window.Razorpay = function (opts) { this.opts = opts; this.handlers = {}; window.__rzpOpts = opts; };
Razorpay.prototype.on = function (evt, fn) { this.handlers[evt] = fn; };
Razorpay.prototype.open = async function () {
  var o = this.opts, self = this, mode = window.__rzpMode || 'success';
  window.__rzpOpened = (window.__rzpOpened || 0) + 1;
  function reg(extra) { return fetch('${API}/__test/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ orderId: o.order_id }, extra || {})) }).then(function (r) { return r.json(); }); }
  await new Promise(function (r) { setTimeout(r, 250); });
  if (mode === 'success') { o.handler(await reg()); }
  else if (mode === 'fail-then-dismiss') { self.handlers['payment.failed']({ error: { description: 'Your bank declined this payment.' } }); o.modal.ondismiss(); }
  else if (mode === 'tampered') { var r = await reg(); r.razorpay_signature = 'a'.repeat(64); o.handler(r); }
  else if (mode === 'late-upi') { await reg({ webhook: true }); o.modal.ondismiss(); }
};`;

const state = async () => (await fetch(API + '/__test/state')).json();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const results = [];
async function scenario(name, fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|apple-touch|status of 4(00|22)/.test(m.text())) errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.endsWith('/assets/config.js')) return r.respond({ contentType: 'text/javascript', body: `window.AMBLE_CONFIG={apiBase:'${API}',whatsapp:'918511149747',phone:'+91 85111 49747'};` });
    if (u.startsWith('https://checkout.razorpay.com/')) return r.respond({ contentType: 'text/javascript', body: FAKE_RZP });
    if (u.includes('youtube') || u.includes('ytimg')) return r.respond({ status: 204, body: '' });
    r.continue();
  });
  await page.setViewport({ width: 1280, height: 900 });
  // The site scrolls smoothly; a test clicking mid-animation hits the wrong spot, so jump instead.
  await page.evaluateOnNewDocument(() => { document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = 'html{scroll-behavior:auto!important}'; document.head.appendChild(st); }); });
  try {
    await fn(page);
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    await page.screenshot({ path: path.join(OUT, `fail-${name.replace(/\W+/g, '-')}.png`), fullPage: true });
  }
  await page.close();
}
async function fill(page, d = {}) {
  const v = { name: 'Asha Patel', organisation: 'Little Steps Preschool', email: 'asha@example.com', phone: '98765 43210', line1: '12 MG Road', city: 'Ahmedabad', pincode: '380009', ...d };
  for (const [k, val] of Object.entries(v)) { await page.$eval('#' + k, el => { el.value = ''; }); await page.type('#' + k, val); }
  await page.select('#state', d.state || 'Gujarat');
}
const text = (page, sel) => page.$eval(sel, el => el.innerText);
const confirmed = page => page.waitForFunction(() => /confirmed/.test(document.getElementById('title').textContent), { timeout: 15000 });

await scenario('home -> buy -> pay -> verified confirmation', async page => {
  await page.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await Promise.all([page.waitForNavigation(), page.click('.mdl-ctas .btn-primary')]);
  assert.match(page.url(), /checkout\.html$/);
  await page.waitForFunction(() => document.getElementById('total').textContent.includes('46,200'));
  assert.equal(await text(page, '#mrp'), '₹50,000');
  await page.click('#qtyPlus');
  assert.equal(await text(page, '#total'), '₹92,400');
  await fill(page);
  await page.evaluate(() => { window.__rzpMode = 'success'; });
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#payBtn')]);
  assert.match(page.url(), /order\.html\?ref=AMB-/);
  await confirmed(page);
  const body = await text(page, '#status');
  assert.match(body, /Thank you, Asha/);
  assert.match(body, /₹92,400/);
  const s = await state(), o = s.orders.at(-1);
  assert.equal(o.status, 'paid'); assert.equal(o.amount, 9240000); assert.equal(o.quantity, 2);
  assert.equal(s.emails.filter(e => e.includes(o.ref)).length, 1);
});

await scenario('double-clicking Pay creates one order', async page => {
  const before = (await state()).razorpayOrders;
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await fill(page, { email: 'twice@example.com' });
  await page.evaluate(() => { window.__rzpMode = 'dismiss-never'; });
  await page.evaluate(() => { const b = document.getElementById('payBtn'); b.click(); b.click(); b.click(); });
  await page.waitForFunction(() => window.__rzpOpened === 1, { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));
  assert.equal((await state()).razorpayOrders - before, 1);
  assert.equal(await page.evaluate(() => window.__rzpOpened), 1);
});

await scenario('failed payment explains why, then a retry pays the same order', async page => {
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await fill(page, { email: 'retry@example.com' });
  await page.evaluate(() => { window.__rzpMode = 'fail-then-dismiss'; });
  await page.click('#payBtn');
  await page.waitForSelector('#notice:not([hidden])', { timeout: 10000 });
  const msg = await text(page, '#notice');
  assert.match(msg, /bank declined/); assert.match(msg, /do not pay again/i);
  assert.equal(await page.$eval('#payBtn', b => b.disabled), false);
  const ordersBefore = (await state()).razorpayOrders;
  await page.evaluate(() => { window.__rzpMode = 'success'; });
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#payBtn')]);
  assert.equal((await state()).razorpayOrders, ordersBefore, 'retry reuses the order');
  await confirmed(page);
});

await scenario('UPI completing after the window closes is picked up from the webhook', async page => {
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await fill(page, { email: 'upi@example.com' });
  await page.evaluate(() => { window.__rzpMode = 'late-upi'; });
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#payBtn')]);
  await confirmed(page);
});

await scenario('a forged payment response is never shown as paid', async page => {
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await fill(page, { email: 'forged@example.com' });
  await page.evaluate(() => { window.__rzpMode = 'tampered'; });
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#payBtn')]);
  await page.waitForFunction(() => /could not confirm/.test(document.getElementById('title').textContent), { timeout: 45000 });
  assert.match(await text(page, '#lead'), /Do not pay again/);
  const o = (await state()).orders.find(x => x.ref === new URL(page.url()).searchParams.get('ref'));
  assert.equal(o.status, 'created'); assert.match(o.last_error, /signature_mismatch/);
});

await scenario('invalid details are caught before any order is created', async page => {
  const before = (await state()).razorpayOrders;
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await fill(page, { phone: '12345', pincode: '01234', email: 'not-an-email' });
  await page.click('#payBtn');
  await new Promise(r => setTimeout(r, 500));
  const errs = await page.$$eval('.err-msg', els => els.map(e => e.textContent).filter(Boolean));
  assert.ok(errs.some(e => /mobile/.test(e)) && errs.some(e => /PIN/.test(e)) && errs.some(e => /email/.test(e)), errs.join(';'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'email');
  assert.equal((await state()).razorpayOrders, before);
});

await scenario('coupon AMBLE30 brings the total to ₹32,340 and the order is charged that amount', async page => {
  await page.goto(SITE + '/checkout.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.getElementById('total').textContent.includes('46,200'));
  await page.type('#couponCode', 'nope99');
  await page.click('#couponApply');
  await page.waitForFunction(() => /not valid/.test(document.getElementById('couponMsg').textContent), { timeout: 10000 });
  assert.equal(await text(page, '#total'), '₹46,200');
  await page.$eval('#couponCode', el => { el.value = ''; });
  await page.type('#couponCode', 'amble30');
  await page.click('#couponApply');
  await page.waitForFunction(() => /AMBLE30 applied/.test(document.getElementById('couponMsg').textContent), { timeout: 10000 });
  assert.equal(await text(page, '#total'), '₹32,340');
  assert.match(await text(page, '#discountRow'), /AMBLE30 \(30% off\)\s*−₹13,860/);
  assert.equal(await text(page, '#payBtn'), 'Pay ₹32,340');
  await page.screenshot({ path: path.join(OUT, 'e2e-coupon.png') });
  await fill(page, { email: 'coupon@example.com' });
  await page.evaluate(() => { window.__rzpMode = 'success'; });
  await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('#payBtn')]);
  await confirmed(page);
  const body = await text(page, '#status');
  assert.match(body, /₹32,340/); assert.match(body, /AMBLE30, ₹13,860 off/);
  const o = (await state()).orders.at(-1);
  assert.equal(o.amount, 3234000); assert.equal(o.status, 'paid');
});

await scenario('a coupon link fills in the code and applies it, and follows the quantity', async page => {
  await page.goto(SITE + '/checkout.html?coupon=AMBLE20', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => /AMBLE20 applied/.test(document.getElementById('couponMsg').textContent), { timeout: 10000 });
  assert.equal(await text(page, '#total'), '₹36,960');
  await page.click('#qtyPlus');
  await page.waitForFunction(() => document.getElementById('total').textContent === '₹73,920', { timeout: 10000 });
});

await scenario('demo request form reaches the API', async page => {
  await page.goto(SITE + '/index.html#contact', { waitUntil: 'networkidle2' });
  await page.type('#contact input[name=name]', 'Ravi Mehta');
  await page.type('#contact input[name=organisation]', 'Sunrise School');
  await page.type('#contact input[name=phone]', '+91 98250 12345');
  await page.select('#contact select[name=interest]', 'Quotation');
  await page.click('#contact button[type=submit]');
  await page.waitForFunction(() => /Thank you/.test(document.querySelector('#contact .form-status').textContent), { timeout: 10000 });
  const lead = (await state()).leads.at(-1);
  assert.equal(lead.organisation, 'Sunrise School'); assert.equal(lead.interest, 'Quotation'); assert.equal(lead.source, 'school');
});

await scenario('international enquiry opens in place and reaches the API', async page => {
  await page.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  assert.equal(await page.$eval('#intlForm', f => f.hidden), true);
  await page.click('#intlToggle');
  assert.equal(await page.$eval('#intlForm', f => f.hidden), false);
  await page.type('#intlForm input[name=name]', 'Sara Ahmed');
  await page.type('#intlForm input[name=country]', 'United Arab Emirates');
  await page.type('#intlForm input[name=email]', 'sara@example.ae');
  await page.type('#intlForm textarea[name=message]', 'Two play centres in Dubai');
  await page.click('#intlForm button[type=submit]');
  await page.waitForFunction(() => /reply to sara@example.ae/.test(document.querySelector('#intlForm .form-status').textContent), { timeout: 10000 });
  const lead = (await state()).leads.at(-1);
  assert.equal(lead.source, 'international'); assert.equal(lead.name, 'Sara Ahmed');
});

await scenario('health page enquiry reaches the API', async page => {
  await page.goto(SITE + '/health.html#contact', { waitUntil: 'networkidle2' });
  await page.type('#contact input[name=name]', 'Dr Meera Shah');
  await page.type('#contact input[name=organisation]', 'Stride Physio');
  await page.type('#contact input[name=phone]', '9898012345');
  await page.select('#contact select[name=org_type]', 'Hospital');
  await page.click('#contact button[type=submit]');
  await page.waitForFunction(() => /Thank you/.test(document.querySelector('#contact .form-status').textContent), { timeout: 10000 });
  assert.equal((await state()).leads.at(-1).source, 'health');
});

await scenario('video loads only on click; activity areas filter the library', async page => {
  await page.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  assert.equal(await page.$$eval('#demo iframe', f => f.length), 0);
  await page.click('#demo .yt');
  assert.match(await page.$eval('#demo iframe', f => f.src), /youtube-nocookie\.com\/embed\/S3ptdInK8F4\?autoplay=1/);
  await page.evaluate(() => document.querySelector('.pp-card[data-open-cat="memory"]').click());
  assert.equal(await page.$eval('#catGrid [data-cat="memory"]', b => b.getAttribute('aria-pressed')), 'true');
  await page.click('#catGrid [data-cat="all"]');
  assert.equal(await page.$$eval('#activityGrid .activity-card', c => c.length), 9);
  await page.click('#showAll');
  assert.equal(await page.$$eval('#activityGrid .activity-card', c => c.length), 76);
});

await browser.close();
for (const r of results) console.log(r[0], '-', r[1], r[2] ? '(' + r[2] + ')' : '');
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
