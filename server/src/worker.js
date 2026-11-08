/* Amble Beats order API (Cloudflare Worker + D1).

   The website is static (GitHub Pages), so everything that needs a secret lives here:
   - POST /api/orders           create a Razorpay order at the server-side price
   - POST /api/orders/verify    check the Razorpay signature, confirm capture with the Razorpay API, mark paid
   - GET  /api/orders/:ref      order status for the confirmation page (no personal details beyond a first name)
   - POST /api/razorpay/webhook Razorpay's server-to-server notice; catches payments whose browser tab closed
   - POST /api/leads            demo / quotation requests
   - GET  /api/product          price and quantity limit, so the checkout page shows what will be charged

   Secrets (wrangler secret put): RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RESEND_API_KEY (optional).
   Vars (wrangler.toml): RAZORPAY_KEY_ID, ALLOWED_ORIGINS, NOTIFY_EMAIL, MAIL_FROM. */

// The only place the price is defined for charging. Amounts are in paise.
export const PRODUCT = { sku: 'AMBLE-BEATS', name: 'Amble Beats', unitPrice: 4950000, currency: 'INR', maxQty: 5 };

export const STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const REF_RE = /^AMB-[0-9A-HJKMNP-TV-Z]{10}$/;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // Razorpay calls this server-to-server: no CORS, authenticated by its own signature.
    if (path === '/api/razorpay/webhook' && request.method === 'POST') {
      try { return await webhook(request, env, ctx); } catch (err) { return serverError(err); }
    }

    const cors = corsHeaders(request.headers.get('Origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    // Browser-only endpoints refuse other sites, and scripts that send no Origin.
    if (request.method === 'POST' && !cors) return json({ error: 'forbidden_origin' }, 403);

    let res;
    try {
      if (path === '/api/product' && request.method === 'GET') res = json(productInfo());
      else if (path === '/api/orders' && request.method === 'POST') res = await createOrder(request, env);
      else if (path === '/api/orders/verify' && request.method === 'POST') res = await verifyOrder(request, env, ctx);
      else if (path.startsWith('/api/orders/') && request.method === 'GET') res = await orderStatus(path.slice(12), env);
      else if (path === '/api/leads' && request.method === 'POST') res = await createLead(request, env, ctx);
      else res = json({ error: 'not_found' }, 404);
    } catch (err) {
      res = err instanceof HttpError ? json({ error: err.code }, err.status) : serverError(err);
    }
    for (const [k, v] of Object.entries(cors || {})) res.headers.set(k, v);
    return res;
  }
};

/* ---------------- orders ---------------- */

function productInfo() {
  return { sku: PRODUCT.sku, name: PRODUCT.name, unitPrice: PRODUCT.unitPrice, currency: PRODUCT.currency, maxQty: PRODUCT.maxQty };
}

async function createOrder(request, env) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return json({ error: 'payments_not_configured' }, 503);
  const { value: o, errors } = validateOrder(await readJson(request, 8000));
  if (errors) return json({ error: 'invalid', fields: errors }, 400);

  // Same checkout attempt again (double click, refresh, retry after a failed payment): return the same order.
  const existing = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key = ?').bind(o.idempotencyKey).first();
  if (existing) {
    if (existing.quantity !== o.quantity || existing.email !== o.email) return json({ error: 'idempotency_conflict' }, 409);
    return json(orderResponse(existing, env));
  }

  const ref = newRef();
  const amount = PRODUCT.unitPrice * o.quantity;
  const rzp = await razorpay(env, 'POST', '/v1/orders', {
    amount, currency: PRODUCT.currency, receipt: ref,
    notes: { ref, organisation: o.organisation, phone: o.phone, quantity: String(o.quantity) }
  });
  if (!rzp.ok || !rzp.body || !rzp.body.id || rzp.body.amount !== amount) {
    console.error('razorpay order create failed', rzp.status, JSON.stringify(rzp.body));
    return json({ error: 'gateway_unavailable' }, 502);
  }

  const now = isoNow();
  const row = {
    ref, idempotency_key: o.idempotencyKey, rzp_order_id: rzp.body.id, status: 'created', amount, currency: PRODUCT.currency,
    quantity: o.quantity, name: o.name, organisation: o.organisation, email: o.email, phone: o.phone, gstin: o.gstin || null,
    address_line1: o.line1, address_line2: o.line2 || null, city: o.city, state: o.state, pincode: o.pincode,
    notes: o.notes || null, created_at: now, updated_at: now
  };
  const cols = Object.keys(row);
  try {
    await env.DB.prepare(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .bind(...cols.map(c => row[c])).run();
  } catch (err) {
    // A concurrent request with the same key won the race. Its Razorpay order is the one to pay;
    // the one created above stays unpaid and expires on Razorpay's side.
    const winner = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key = ?').bind(o.idempotencyKey).first();
    if (winner) return json(orderResponse(winner, env));
    throw err;
  }
  return json(orderResponse(row, env), 201);
}

function orderResponse(row, env) {
  return {
    ref: row.ref, status: row.status, razorpayOrderId: row.rzp_order_id, amount: row.amount, currency: row.currency,
    quantity: row.quantity, keyId: env.RAZORPAY_KEY_ID, prefill: { name: row.name, email: row.email, contact: row.phone }
  };
}

async function verifyOrder(request, env, ctx) {
  const b = await readJson(request, 2000);
  const orderId = str(b.razorpay_order_id, 40), paymentId = str(b.razorpay_payment_id, 40), signature = str(b.razorpay_signature, 64);
  if (!/^order_\w+$/.test(orderId) || !/^pay_\w+$/.test(paymentId) || !/^[a-f0-9]{64}$/.test(signature)) {
    return json({ error: 'invalid' }, 400);
  }
  const order = await env.DB.prepare('SELECT * FROM orders WHERE rzp_order_id = ?').bind(orderId).first();
  if (!order) return json({ error: 'not_found' }, 404);

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, orderId + '|' + paymentId);
  if (!safeEqual(expected, signature)) {
    await recordError(env, order.ref, 'signature_mismatch ' + paymentId);
    return json({ error: 'signature_mismatch' }, 400);
  }
  if (order.status === 'paid') return json({ ref: order.ref, status: 'paid' });

  const result = await confirmPayment(env, order, paymentId);
  if (result.mismatch) return json({ error: 'payment_mismatch', ref: order.ref }, 400);
  if (result.paid && result.firstTime) ctx.waitUntil(notifyPaid(env, result.order));
  // 202: genuine payment, not captured yet. The webhook (or a later check) will complete it.
  return json({ ref: order.ref, status: result.paid ? 'paid' : 'pending' }, result.paid ? 200 : 202);
}

// A valid signature proves the response came from Razorpay. The Payments API says whether the money
// was actually captured, for this order and this amount.
async function confirmPayment(env, order, paymentId) {
  const res = await razorpay(env, 'GET', '/v1/payments/' + encodeURIComponent(paymentId));
  if (!res.ok || !res.body) {
    await recordError(env, order.ref, 'payment_fetch_failed ' + res.status);
    return { paid: false };
  }
  let p = res.body;
  if (p.order_id !== order.rzp_order_id || p.amount !== order.amount || p.currency !== order.currency) {
    await recordError(env, order.ref, `payment_mismatch ${p.id} ${p.order_id} ${p.amount} ${p.currency}`);
    return { paid: false, mismatch: true };
  }
  if (p.status === 'authorized') {
    // Only happens if automatic capture is off in the Razorpay dashboard.
    const cap = await razorpay(env, 'POST', `/v1/payments/${encodeURIComponent(paymentId)}/capture`, { amount: order.amount, currency: order.currency });
    if (!cap.ok) {
      await recordError(env, order.ref, 'capture_failed ' + cap.status);
      return { paid: false };
    }
    p = cap.body;
  }
  if (p.status !== 'captured') return { paid: false };
  return markPaid(env, order.ref, paymentId, p.method);
}

// Idempotent: only the first caller (browser verify or webhook) flips the row and sends the notification.
async function markPaid(env, ref, paymentId, method) {
  const now = isoNow();
  const r = await env.DB.prepare(
    "UPDATE orders SET status = 'paid', rzp_payment_id = ?, payment_method = ?, paid_at = ?, updated_at = ?, last_error = NULL WHERE ref = ? AND status <> 'paid'"
  ).bind(paymentId, method || null, now, now, ref).run();
  const order = await env.DB.prepare('SELECT * FROM orders WHERE ref = ?').bind(ref).first();
  return { paid: order.status === 'paid', firstTime: r.meta.changes === 1, order };
}

async function recordError(env, ref, message) {
  console.warn('order', ref, message);
  await env.DB.prepare('UPDATE orders SET last_error = ?, updated_at = ? WHERE ref = ?').bind(message.slice(0, 300), isoNow(), ref).run();
}

async function orderStatus(ref, env) {
  if (!REF_RE.test(ref)) return json({ error: 'not_found' }, 404);
  const o = await env.DB.prepare('SELECT ref, status, amount, currency, quantity, name, email, created_at, paid_at FROM orders WHERE ref = ?').bind(ref).first();
  if (!o) return json({ error: 'not_found' }, 404);
  return json({
    ref: o.ref, status: o.status, amount: o.amount, currency: o.currency, quantity: o.quantity,
    firstName: o.name.split(/\s+/)[0], email: maskEmail(o.email), createdAt: o.created_at, paidAt: o.paid_at
  });
}

/* ---------------- webhook ---------------- */

async function webhook(request, env, ctx) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return new Response('webhook not configured', { status: 503 });
  const raw = await request.text();
  if (raw.length > 200000) return new Response('too large', { status: 413 });
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, request.headers.get('X-Razorpay-Signature') || '')) return new Response('bad signature', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const pay = evt && evt.payload && evt.payload.payment && evt.payload.payment.entity;
  const eventId = request.headers.get('X-Razorpay-Event-Id') || `${evt.event}:${pay ? pay.id : ''}:${evt.created_at}`;
  const seen = await env.DB.prepare('SELECT 1 AS seen FROM webhook_events WHERE event_id = ?').bind(eventId).first();
  if (seen) return new Response('duplicate');

  if (pay && (evt.event === 'payment.captured' || evt.event === 'order.paid')) {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE rzp_order_id = ?').bind(pay.order_id).first();
    if (order && order.status !== 'paid') {
      if (pay.status === 'captured' && pay.amount === order.amount && pay.currency === order.currency) {
        const r = await markPaid(env, order.ref, pay.id, pay.method);
        if (r.firstTime) ctx.waitUntil(notifyPaid(env, r.order));
      } else {
        await recordError(env, order.ref, `webhook_mismatch ${pay.id} ${pay.status} ${pay.amount}`);
      }
    }
  } else if (pay && evt.event === 'payment.failed') {
    const order = await env.DB.prepare('SELECT ref, status FROM orders WHERE rzp_order_id = ?').bind(pay.order_id).first();
    if (order && order.status !== 'paid') {
      await recordError(env, order.ref, `payment_failed ${pay.id} ${pay.error_code || ''} ${pay.error_description || ''}`);
    }
  }
  // Recorded only after processing, so a failure above makes Razorpay retry. Processing twice is safe.
  await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event, received_at) VALUES (?, ?, ?)').bind(eventId, String(evt.event || ''), isoNow()).run();
  return new Response('ok');
}

/* ---------------- leads ---------------- */

async function createLead(request, env, ctx) {
  const b = await readJson(request, 8000);
  if (str(b.website, 200)) return json({ ok: true }, 201); // honeypot: pretend success, store nothing
  const lead = {
    source: str(b.source, 40) || null, name: str(b.name, 100), organisation: str(b.organisation, 150) || null,
    role: str(b.role, 100) || null, org_type: str(b.org_type, 80) || null, city: str(b.city, 100) || null,
    phone: str(b.phone, 30), email: str(b.email, 200).toLowerCase() || null, interest: str(b.interest, 60) || null,
    message: str(b.message, 2000) || null, page: str(b.page, 100) || null, created_at: isoNow()
  };
  const errors = {};
  if (lead.name.length < 2) errors.name = 'Enter your name.';
  const digits = lead.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) errors.phone = 'Enter a phone number we can call.';
  if (lead.email && !EMAIL_RE.test(lead.email)) errors.email = 'Enter a valid email address.';
  if (Object.keys(errors).length) return json({ error: 'invalid', fields: errors }, 400);

  const cols = Object.keys(lead);
  await env.DB.prepare(`INSERT INTO leads (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => lead[c])).run();
  ctx.waitUntil(sendEmail(env,
    `New Amble Beats enquiry: ${lead.organisation || lead.name}${lead.interest ? ' (' + lead.interest + ')' : ''}`,
    [['Name', lead.name], ['Organisation', lead.organisation], ['Role', lead.role], ['Type of centre', lead.org_type],
      ['City', lead.city], ['Phone', lead.phone], ['Email', lead.email], ['Looking for', lead.interest],
      ['Message', lead.message], ['Form', `${lead.source || ''} ${lead.page || ''}`]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'),
    lead.email));
  return json({ ok: true }, 201);
}

/* ---------------- validation ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateOrder(b) {
  b = b || {};
  const c = (b.customer && typeof b.customer === 'object') ? b.customer : {};
  const a = (b.address && typeof b.address === 'object') ? b.address : {};
  const errors = {};
  const v = {
    idempotencyKey: str(b.idempotencyKey, 64),
    quantity: Number(b.quantity),
    name: str(c.name, 100), organisation: str(c.organisation, 150), email: str(c.email, 200).toLowerCase(),
    phone: normalisePhone(c.phone), gstin: str(c.gstin, 15).toUpperCase().replace(/\s/g, ''),
    line1: str(a.line1, 200), line2: str(a.line2, 200), city: str(a.city, 100), state: str(a.state, 60),
    pincode: str(a.pincode, 6), notes: str(b.notes, 1000)
  };
  if (!/^[A-Za-z0-9-]{16,64}$/.test(v.idempotencyKey)) errors.idempotencyKey = 'Missing checkout key. Reload the page and try again.';
  if (!Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > PRODUCT.maxQty) errors.quantity = `Choose between 1 and ${PRODUCT.maxQty}.`;
  if (v.name.length < 2) errors.name = 'Enter your full name.';
  if (v.organisation.length < 2) errors.organisation = 'Enter your school or organisation.';
  if (!EMAIL_RE.test(v.email)) errors.email = 'Enter a valid email address.';
  if (!v.phone) errors.phone = 'Enter a 10-digit Indian mobile number.';
  if (v.gstin && !GSTIN_RE.test(v.gstin)) errors.gstin = 'A GSTIN has 15 characters, like 24ABCDE1234F1Z5.';
  if (v.line1.length < 3) errors.line1 = 'Enter the delivery address.';
  if (v.city.length < 2) errors.city = 'Enter the city.';
  if (!STATES.includes(v.state)) errors.state = 'Choose the state.';
  if (!/^[1-9]\d{5}$/.test(v.pincode)) errors.pincode = 'Enter the 6-digit PIN code.';
  return Object.keys(errors).length ? { errors } : { value: v };
}

export function normalisePhone(raw) {
  const d = String(raw || '').replace(/[\s\-().]/g, '').replace(/^(?:\+?91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : '';
}

/* ---------------- notifications ---------------- */

async function notifyPaid(env, o) {
  const rupees = (o.amount / 100).toLocaleString('en-IN');
  await sendEmail(env, `Paid order ${o.ref}: ${o.quantity} x Amble Beats, Rs ${rupees}`, [
    `Order: ${o.ref}`, `Paid: Rs ${rupees} (${o.payment_method || 'method unknown'})`, `Razorpay payment: ${o.rzp_payment_id}`,
    `Quantity: ${o.quantity}`, '', `${o.name}, ${o.organisation}`, `Phone: ${o.phone}`, `Email: ${o.email}`,
    o.gstin ? `GSTIN: ${o.gstin}` : 'GSTIN: not given', '', 'Deliver to:', o.address_line1, o.address_line2,
    `${o.city}, ${o.state} ${o.pincode}`, o.notes ? '\nNotes: ' + o.notes : ''
  ].filter(x => x != null).join('\n'), o.email);
}

async function sendEmail(env, subject, text, replyTo) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.MAIL_FROM) {
    console.log('email not configured, skipped:', subject);
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: env.NOTIFY_EMAIL.split(',').map(s => s.trim()), subject, text, reply_to: replyTo || undefined }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) console.error('email failed', r.status, await r.text());
  } catch (err) {
    console.error('email failed', String(err));
  }
}

/* ---------------- helpers ---------------- */

async function razorpay(env, method, path, body) {
  try {
    const r = await fetch('https://api.razorpay.com' + path, {
      method,
      headers: { Authorization: 'Basic ' + btoa(env.RAZORPAY_KEY_ID + ':' + env.RAZORPAY_KEY_SECRET), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON: keep the text for the log */ }
    return { ok: r.ok, status: r.status, body: parsed || text };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  }
}

export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
}

async function readJson(request, maxChars) {
  const text = await request.text();
  if (text.length > maxChars) throw new HttpError(413, 'too_large');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function newRef() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'AMB-' + Array.from(bytes, b => REF_ALPHABET[b & 31]).join('');
}

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : (typeof v === 'number' ? String(v).slice(0, max) : ''); }
function isoNow() { return new Date().toISOString(); }
function maskEmail(e) { const [u, d] = String(e).split('@'); return d ? u.slice(0, 2) + '***@' + d : ''; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function serverError(err) {
  console.error('unhandled', err && err.stack ? err.stack : String(err));
  return json({ error: 'server_error' }, 500);
}
