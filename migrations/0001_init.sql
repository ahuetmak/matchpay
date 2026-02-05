PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  phone TEXT,
  country TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('brand','partner','admin')),
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS brands (
  brand_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  payout_sla_days INTEGER DEFAULT 14,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','banned')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS partners (
  partner_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  display_name TEXT,
  niche_tags TEXT,
  channels TEXT,
  country TEXT,
  language TEXT,
  methods TEXT,
  portfolio TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','banned')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  conversion_type TEXT NOT NULL CHECK (conversion_type IN ('sale','valid_lead','appointment','demo')),
  payout_type TEXT NOT NULL CHECK (payout_type IN ('percent','fixed','per_event')),
  payout_amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  validation_rules TEXT NOT NULL,
  assets TEXT,
  landing_url TEXT,
  allowed_channels TEXT,
  geo TEXT,
  attribution_window_days INTEGER DEFAULT 7,
  join_mode TEXT DEFAULT 'auto' CHECK (join_mode IN ('auto','approval')),
  status TEXT DEFAULT 'active' CHECK (status IN ('draft','active','paused','banned')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(brand_id)
);

CREATE TABLE IF NOT EXISTS offer_joins (
  join_id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('pending','active','rejected','paused')),
  attribution_key TEXT NOT NULL,
  coupon_code TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (offer_id, partner_id),
  UNIQUE (attribution_key),
  FOREIGN KEY (offer_id) REFERENCES offers(offer_id),
  FOREIGN KEY (partner_id) REFERENCES partners(partner_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('click','lead','conversion')),
  offer_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  attribution_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (idempotency_key),
  FOREIGN KEY (offer_id) REFERENCES offers(offer_id),
  FOREIGN KEY (partner_id) REFERENCES partners(partner_id)
);

CREATE TABLE IF NOT EXISTS conversions (
  conversion_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','valid','invalid','paid')),
  reason TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  validated_by_user_id TEXT,
  validated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(event_id)
);

CREATE TABLE IF NOT EXISTS wallet_balances (
  partner_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (partner_id) REFERENCES partners(partner_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  payout_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT DEFAULT 'approved' CHECK (status IN ('pending','approved','paid','reversed')),
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (partner_id) REFERENCES partners(partner_id),
  FOREIGN KEY (brand_id) REFERENCES brands(brand_id),
  FOREIGN KEY (conversion_id) REFERENCES conversions(conversion_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
