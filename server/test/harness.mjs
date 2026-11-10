// Test doubles for the order API: an in-memory D1 (node:sqlite running the real schema.sql)
// and a fake Razorpay + Resend that record every call. Used by the unit tests and by dev-server.mjs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { hmacHex } from '../src/worker.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// Minimal D1 surface the worker uses: prepare().bind().first() / run() / all()
export function memoryD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; }
      };
      return stmt;
    }
  };
}

export function fakeGateway() {
  const orders = new Map(), payments = new Map(), calls = [], emails = [];
  let n = 0;
  async function fetchImpl(url, init = {}) {
    const u = new URL(url), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, host: u.host, path: u.pathname, body, auth: init.headers && init.headers.Authorization });
    if (u.host === 'api.resend.com') { emails.push(body); return Response.json({ id: 'email_' + emails.length }); }
    if (u.host !== 'api.razorpay.com') throw new Error('unexpected fetch ' + url);
    if (gateway.down) return new Response('upstream error', { status: 503 });
    let m;
    if (method === 'POST' && u.pathname === '/v1/orders') {
      const id = 'order_T' + String(++n).padStart(13, '0');
      const o = { id, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created', notes: body.notes };
      orders.set(id, o);
      return Response.json(o);
    }
    if (method === 'GET' && (m = u.pathname.match(/^\/v1\/payments\/(pay_\w+)$/))) {
      if (gateway.hold) { gateway.hold.reached(); await gateway.hold.release; } // lets a test interleave a webhook here
      const p = payments.get(m[1]);
      return p ? Response.json(p) : Response.json({ error: { code: 'BAD_REQUEST_ERROR' } }, { status: 400 });
    }
    if (method === 'POST' && (m = u.pathname.match(/^\/v1\/payments\/(pay_\w+)\/capture$/))) {
      const p = payments.get(m[1]);
      if (!p || p.status !== 'authorized' || body.amount !== p.amount) return Response.json({ error: {} }, { status: 400 });
      p.status = 'captured';
      return Response.json(p);
    }
    return Response.json({ error: 'unhandled ' + method + ' ' + u.pathname }, { status: 404 });
  }
  // What Razorpay Checkout hands the browser after the buyer pays `orderId`.
  async function pay(orderId, secret, { status = 'captured', amount, method = 'upi' } = {}) {
    const o = orders.get(orderId), id = 'pay_' + orderId.slice(6);
    payments.set(id, { id, entity: 'payment', order_id: orderId, amount: amount ?? o.amount, currency: o.currency, status, method });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: await hmacHex(secret, orderId + '|' + id) };
  }
  const gateway = { fetch: fetchImpl, orders, payments, calls, emails, pay, down: false };
  return gateway;
}

export function testEnv(DB, over = {}) {
  return {
    DB, RAZORPAY_KEY_ID: 'rzp_test_KEYID', RAZORPAY_KEY_SECRET: 'test_key_secret', RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
    ALLOWED_ORIGINS: 'https://amble.invengic.in,http://localhost:8080', NOTIFY_EMAIL: 'sales@invengic.in',
    MAIL_FROM: 'Amble Beats <orders@invengic.in>', RESEND_API_KEY: 're_test', ...over
  };
}

export function setup(over) {
  const gw = fakeGateway();
  globalThis.fetch = gw.fetch;
  const db = memoryD1();
  const pending = [];
  return {
    gw, db, env: testEnv(db, over),
    ctx: { waitUntil(p) { pending.push(p); } },
    settle: () => Promise.all(pending.splice(0))
  };
}
