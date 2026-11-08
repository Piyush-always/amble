// Local API for trying the checkout without Razorpay keys: the real worker code, an in-memory database
// and a fake Razorpay. Run `node test/dev-server.mjs`, serve the site on http://localhost:8080 and set
// apiBase to http://localhost:8787 in assets/config.js (do not commit that change).
// The /__test/* routes exist only here, for the browser tests; they are not part of the worker.
import http from 'node:http';
import worker, { hmacHex } from '../src/worker.js';
import { memoryD1, fakeGateway, testEnv } from './harness.mjs';

const PORT = Number(process.env.PORT || 8787);
const gw = fakeGateway();
globalThis.fetch = gw.fetch;
const db = memoryD1();
const env = testEnv(db, { ALLOWED_ORIGINS: 'http://localhost:8080' });
const ctx = { waitUntil(p) { p.catch(e => console.error('waitUntil', e)); } };

async function sendWebhook(event, payment) {
  const raw = JSON.stringify({ entity: 'event', event, created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: payment } } });
  const res = await worker.fetch(new Request(`http://localhost:${PORT}/api/razorpay/webhook`, {
    method: 'POST', body: raw,
    headers: { 'X-Razorpay-Signature': await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw), 'X-Razorpay-Event-Id': 'evt_' + crypto.randomUUID() }
  }), env, ctx);
  return res.status;
}

async function testRoute(path, body) {
  if (path === '/__test/pay') {
    const r = await gw.pay(body.orderId, env.RAZORPAY_KEY_SECRET, { status: body.status || 'captured', amount: body.amount });
    if (body.webhook) await sendWebhook('payment.captured', gw.payments.get(r.razorpay_payment_id));
    return r;
  }
  if (path === '/__test/state') {
    return {
      orders: db.raw.prepare('SELECT ref, status, amount, quantity, rzp_order_id, rzp_payment_id, last_error FROM orders').all(),
      leads: db.raw.prepare('SELECT name, organisation, phone, interest, source FROM leads').all(),
      razorpayOrders: gw.orders.size,
      emails: gw.emails.map(e => e.subject)
    };
  }
  return null;
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  if (req.url.startsWith('/__test/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const out = await testRoute(req.url, bodyText ? JSON.parse(bodyText) : {});
    res.writeHead(out ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : bodyText
  });
  const response = await worker.fetch(request, env, ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  console.log(req.method, req.url, response.status);
}).listen(PORT, () => console.log(`order API (fake Razorpay) on http://localhost:${PORT}`));
