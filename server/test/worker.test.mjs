import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { PRODUCT, normalisePhone, hmacHex } from '../src/worker.js';
import { setup } from './harness.mjs';

const ORIGIN = 'https://amble.invengic.in';
function req(method, path, body, headers = {}) {
  return new Request('https://api.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
}
const order = (over = {}) => ({
  idempotencyKey: 'chk-' + crypto.randomUUID(), quantity: 1,
  customer: { name: 'Asha Patel', organisation: 'Little Steps Preschool', email: 'Asha@Example.com', phone: '98765 43210', gstin: '' },
  address: { line1: '12 MG Road', line2: '', city: 'Ahmedabad', state: 'Gujarat', pincode: '380009' },
  ...over
});
async function call(t, method, path, body, headers) {
  const res = await worker.fetch(req(method, path, body, headers), t.env, t.ctx);
  await t.settle();
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const row = (t, sql, ...a) => t.db.raw.prepare(sql).get(...a);

test('creates the Razorpay order at the server price, whatever amount the browser sends', async () => {
  const t = setup();
  const r = await call(t, 'POST', '/api/orders', { ...order({ quantity: 2 }), amount: 100 });
  assert.equal(r.status, 201);
  assert.equal(r.data.amount, 2 * PRODUCT.unitPrice);
  assert.equal(r.data.keyId, 'rzp_test_KEYID');
  assert.match(r.data.ref, /^AMB-[0-9A-HJKMNP-TV-Z]{10}$/);
  const rz = t.gw.calls.find(c => c.path === '/v1/orders');
  assert.equal(rz.body.amount, 9900000);
  assert.equal(rz.body.currency, 'INR');
  assert.equal(rz.body.receipt, r.data.ref);
  assert.equal(rz.auth, 'Basic ' + btoa('rzp_test_KEYID:test_key_secret'));
  const db = row(t, 'SELECT * FROM orders WHERE ref = ?', r.data.ref);
  assert.equal(db.status, 'created');
  assert.equal(db.email, 'asha@example.com');
  assert.equal(db.phone, '+919876543210');
  assert.equal(db.rzp_order_id, r.data.razorpayOrderId);
});

test('a repeated checkout attempt returns the same order and creates no second Razorpay order', async () => {
  const t = setup();
  const o = order();
  const a = await call(t, 'POST', '/api/orders', o);
  const b = await call(t, 'POST', '/api/orders', o);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.data.ref, a.data.ref);
  assert.equal(t.gw.orders.size, 1);
  const c = await call(t, 'POST', '/api/orders', { ...o, quantity: 3 });
  assert.equal(c.status, 409, 'changing the quantity under the same key must not reuse the old amount');
});

test('rejects invalid details with a message per field', async () => {
  const t = setup();
  const r = await call(t, 'POST', '/api/orders', order({
    quantity: PRODUCT.maxQty + 1,
    customer: { name: 'A', organisation: '', email: 'nope', phone: '12345', gstin: '24ABCDE' },
    address: { line1: '', city: '', state: 'Atlantis', pincode: '012345' }
  }));
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.data.fields).sort(),
    ['city', 'email', 'gstin', 'line1', 'name', 'organisation', 'phone', 'pincode', 'quantity', 'state']);
  assert.equal(t.gw.calls.length, 0, 'nothing is sent to Razorpay for invalid input');
});

test('normalises Indian mobile numbers', () => {
  assert.equal(normalisePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalisePhone('09876543210'), '+919876543210');
  assert.equal(normalisePhone('919876543210'), '+919876543210');
  assert.equal(normalisePhone('5876543210'), '');
  assert.equal(normalisePhone('12345'), '');
});

test('only the listed origins may POST', async () => {
  const t = setup();
  assert.equal((await call(t, 'POST', '/api/orders', order(), { Origin: 'https://evil.example' })).status, 403);
  const pre = await worker.fetch(new Request('https://api.test/api/orders', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), t.env, t.ctx);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const ok = await call(t, 'GET', '/api/product');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(ok.data.unitPrice, 4950000);
});

test('verify: a genuine captured payment marks the order paid and notifies once', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret');
  const v1 = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v1.status, 200);
  assert.deepEqual(v1.data, { ref: o.data.ref, status: 'paid' });
  const db = row(t, 'SELECT * FROM orders WHERE ref = ?', o.data.ref);
  assert.equal(db.status, 'paid');
  assert.equal(db.rzp_payment_id, paid.razorpay_payment_id);
  assert.equal(db.payment_method, 'upi');
  assert.ok(db.paid_at);
  assert.equal(t.gw.emails.length, 1);
  assert.match(t.gw.emails[0].subject, /^Paid order AMB-/);
  const v2 = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v2.status, 200);
  assert.equal(t.gw.emails.length, 1, 'a second verify does not send a second email');
});

test('verify: a forged signature is refused and the order stays unpaid', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'some_other_secret');
  const v = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v.status, 400);
  assert.equal(v.data.error, 'signature_mismatch');
  const db = row(t, 'SELECT * FROM orders WHERE ref = ?', o.data.ref);
  assert.equal(db.status, 'created');
  assert.match(db.last_error, /^signature_mismatch/);
  assert.equal(t.gw.emails.length, 0);
});

test('verify: a payment for a different amount is refused', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret', { amount: 100 });
  const v = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v.status, 400);
  assert.equal(v.data.error, 'payment_mismatch');
  assert.equal(row(t, 'SELECT status FROM orders WHERE ref = ?', o.data.ref).status, 'created');
});

test('verify: an authorised but uncaptured payment is captured, then marked paid', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret', { status: 'authorized' });
  const v = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v.status, 200);
  assert.equal(v.data.status, 'paid');
  const cap = t.gw.calls.find(c => c.path.endsWith('/capture'));
  assert.deepEqual(cap.body, { amount: PRODUCT.unitPrice, currency: 'INR' });
});

test('verify: a payment Razorpay has not captured yet is reported as pending, not paid', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret', { status: 'created' });
  const v = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(v.status, 202);
  assert.equal(v.data.status, 'pending');
});

async function webhookCall(t, payload, { secret = 'test_webhook_secret', id = 'evt_' + crypto.randomUUID() } = {}) {
  const raw = JSON.stringify(payload);
  const res = await worker.fetch(new Request('https://api.test/api/razorpay/webhook', {
    method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': await hmacHex(secret, raw), 'X-Razorpay-Event-Id': id }
  }), t.env, t.ctx);
  await t.settle();
  return { status: res.status, text: await res.text() };
}

test('webhook: order.paid completes an order whose browser never came back; replays and late verifies are harmless', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret');
  const payment = t.gw.payments.get(paid.razorpay_payment_id);
  const evt = { entity: 'event', event: 'order.paid', created_at: 1762600000, payload: { payment: { entity: payment }, order: { entity: t.gw.orders.get(o.data.razorpayOrderId) } } };

  assert.equal((await webhookCall(t, evt, { secret: 'wrong' })).status, 401);
  assert.equal(row(t, 'SELECT status FROM orders WHERE ref = ?', o.data.ref).status, 'created');

  const w1 = await webhookCall(t, evt, { id: 'evt_1' });
  assert.equal(w1.status, 200);
  assert.equal(w1.text, 'ok');
  assert.equal(row(t, 'SELECT status FROM orders WHERE ref = ?', o.data.ref).status, 'paid');
  assert.equal(t.gw.emails.length, 1);

  const w2 = await webhookCall(t, evt, { id: 'evt_1' });
  assert.equal(w2.text, 'duplicate');
  const late = await call(t, 'POST', '/api/orders/verify', paid);
  assert.equal(late.data.status, 'paid');
  assert.equal(t.gw.emails.length, 1, 'still exactly one notification');
});

test('browser verify and webhook arriving at the same moment produce one paid order and one notification', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const paid = await t.gw.pay(o.data.razorpayOrderId, 'test_key_secret');
  const payment = t.gw.payments.get(paid.razorpay_payment_id);
  const evt = { event: 'payment.captured', created_at: 2, payload: { payment: { entity: payment } } };
  // Worst case: the browser's verify has read the order as unpaid and is asking Razorpay about the
  // payment when the webhook lands and marks it paid. Then the verify continues.
  let open, reached;
  const atFetch = new Promise(r => { reached = r; });
  t.gw.hold = { reached, release: new Promise(r => { open = r; }) };
  const verifying = call(t, 'POST', '/api/orders/verify', paid);
  await atFetch;
  t.gw.hold = null;
  const w = await webhookCall(t, evt);
  open();
  const v = await verifying;
  assert.equal(v.data.status, 'paid');
  assert.equal(w.status, 200);
  assert.equal(row(t, 'SELECT status FROM orders WHERE ref = ?', o.data.ref).status, 'paid');
  assert.equal(t.gw.emails.length, 1);
});

test('webhook: payment.failed records the reason and leaves the order open for a retry', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const evt = { event: 'payment.failed', created_at: 1, payload: { payment: { entity: { id: 'pay_F1', order_id: o.data.razorpayOrderId, status: 'failed', amount: PRODUCT.unitPrice, currency: 'INR', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment declined by bank' } } } };
  assert.equal((await webhookCall(t, evt)).status, 200);
  const db = row(t, 'SELECT status, last_error FROM orders WHERE ref = ?', o.data.ref);
  assert.equal(db.status, 'created');
  assert.match(db.last_error, /declined by bank/);
});

test('order status shows only what the confirmation page needs', async () => {
  const t = setup();
  const o = await call(t, 'POST', '/api/orders', order());
  const s = await call(t, 'GET', '/api/orders/' + o.data.ref);
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.data).sort(), ['amount', 'createdAt', 'currency', 'email', 'firstName', 'paidAt', 'quantity', 'ref', 'status']);
  assert.equal(s.data.firstName, 'Asha');
  assert.equal(s.data.email, 'as***@example.com');
  assert.equal((await call(t, 'GET', '/api/orders/AMB-0000000000')).status, 404);
  assert.equal((await call(t, 'GET', '/api/orders/1%20OR%201=1')).status, 404);
});

test('leads are stored and emailed; the honeypot stores nothing', async () => {
  const t = setup();
  const r = await call(t, 'POST', '/api/leads', { source: 'school', name: 'Ravi Mehta', organisation: 'Sunrise School', phone: '+91 98250 12345', interest: 'Demo', message: 'Two branches' });
  assert.equal(r.status, 201);
  assert.equal(row(t, 'SELECT COUNT(*) AS n FROM leads').n, 1);
  assert.match(t.gw.emails[0].subject, /Sunrise School \(Demo\)/);
  assert.match(t.gw.emails[0].text, /Two branches/);
  const bot = await call(t, 'POST', '/api/leads', { name: 'Bot', phone: '9999999999', website: 'http://spam' });
  assert.equal(bot.status, 201);
  assert.equal(row(t, 'SELECT COUNT(*) AS n FROM leads').n, 1);
  const bad = await call(t, 'POST', '/api/leads', { name: 'X', phone: '12' });
  assert.equal(bad.status, 400);
});

test('missing keys or a Razorpay outage fail cleanly and store no order', async () => {
  const t = setup({ RAZORPAY_KEY_SECRET: '' });
  assert.equal((await call(t, 'POST', '/api/orders', order())).status, 503);
  const t2 = setup();
  t2.gw.down = true;
  const r = await call(t2, 'POST', '/api/orders', order());
  assert.equal(r.status, 502);
  assert.equal(row(t2, 'SELECT COUNT(*) AS n FROM orders').n, 0);
});

test('malformed JSON and oversized bodies are rejected', async () => {
  const t = setup();
  assert.equal((await call(t, 'POST', '/api/orders', '{not json')).status, 400);
  assert.equal((await call(t, 'POST', '/api/leads', JSON.stringify({ message: 'x'.repeat(9000) }))).status, 413);
});
