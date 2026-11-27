-- Run once on the existing database (fresh databases get this from schema.sql):
--   npx wrangler d1 execute amble-orders --remote --file=migrations/0002_coupons_and_country.sql
ALTER TABLE orders ADD COLUMN subtotal INTEGER;
ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN coupon_code TEXT;
ALTER TABLE leads ADD COLUMN country TEXT;

CREATE TABLE IF NOT EXISTS coupons (
  code         TEXT PRIMARY KEY,
  percent_off  INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  active       INTEGER NOT NULL DEFAULT 1,
  starts_at    TEXT,
  expires_at   TEXT,
  max_uses     INTEGER,
  min_quantity INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT NOT NULL
);

INSERT OR IGNORE INTO coupons (code, percent_off, note, created_at) VALUES
  ('AMBLE20', 20, 'Launch coupon, 20% off', '2026-11-27T00:00:00Z'),
  ('AMBLE30', 30, 'Launch coupon, 30% off', '2026-11-27T00:00:00Z');
