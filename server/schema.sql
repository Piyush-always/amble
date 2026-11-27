-- Amble Beats order API schema (Cloudflare D1 / SQLite).
-- Apply with: npx wrangler d1 execute amble-orders --remote --file=schema.sql

-- One row per checkout. Amounts are in paise. status moves created -> paid only;
-- a failed payment attempt leaves the order 'created' (the buyer can retry on the same order).
CREATE TABLE IF NOT EXISTS orders (
  ref             TEXT PRIMARY KEY,            -- shown to the buyer, e.g. AMB-7K2M9QX4TB
  idempotency_key TEXT NOT NULL UNIQUE,        -- from the checkout page; a retry returns the same order
  rzp_order_id    TEXT NOT NULL UNIQUE,
  rzp_payment_id  TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
  amount          INTEGER NOT NULL CHECK (amount > 0),   -- what is charged: subtotal - discount
  currency        TEXT NOT NULL,
  subtotal        INTEGER,                              -- price x quantity, before any coupon
  discount        INTEGER NOT NULL DEFAULT 0,
  coupon_code     TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  payment_method  TEXT,
  name            TEXT NOT NULL,
  organisation    TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT NOT NULL,
  gstin           TEXT,
  address_line1   TEXT NOT NULL,
  address_line2   TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  pincode         TEXT NOT NULL,
  notes           TEXT,
  last_error      TEXT,                        -- most recent failure reason, for support
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  paid_at         TEXT
);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at);

-- Razorpay webhook deliveries already processed (Razorpay retries, so the same event can arrive twice).
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- Demo and quotation requests from the enquiry forms.
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT,
  name         TEXT NOT NULL,
  organisation TEXT,
  role         TEXT,
  org_type     TEXT,
  city         TEXT,
  country      TEXT,
  phone        TEXT NOT NULL,
  email        TEXT,
  interest     TEXT,
  message      TEXT,
  page         TEXT,
  created_at   TEXT NOT NULL
);

-- Coupon codes. The server applies them when it creates the order; see README for how to add or change one.
CREATE TABLE IF NOT EXISTS coupons (
  code         TEXT PRIMARY KEY,                 -- upper case, e.g. AMBLE20
  percent_off  INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  active       INTEGER NOT NULL DEFAULT 1,       -- 0 switches the code off
  starts_at    TEXT,                             -- optional, e.g. 2026-12-01T00:00:00+05:30
  expires_at   TEXT,                             -- optional, e.g. 2026-12-31T23:59:59+05:30
  max_uses     INTEGER,                          -- optional cap on paid orders using the code
  min_quantity INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT NOT NULL
);
