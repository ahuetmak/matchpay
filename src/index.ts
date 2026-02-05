import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

type Env = {
  MATCHPAY_DB: D1Database;
  MATCHPAY_KV: KVNamespace;
  APP_ENV: string;
  PUBLIC_BASE_URL: string;
};

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors());

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function randomToken(bytes = 18) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function rateLimit(env: Env, key: string, limit: number, windowSeconds: number) {
  const bucketKey = `rl:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const current = await env.MATCHPAY_KV.get(bucketKey);
  const n = current ? parseInt(current, 10) : 0;
  if (n >= limit) return false;
  await env.MATCHPAY_KV.put(bucketKey, String(n + 1), { expirationTtl: windowSeconds + 2 });
  return true;
}

function idemKey(req: Request) {
  return req.headers.get("Idempotency-Key") || req.headers.get("X-Idempotency-Key") || null;
}

function getUserId(c: any) {
  const auth = c.req.header("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

app.get("/health", (c) => c.json({ ok: true, name: "MatchPay", ts: Date.now() }));

// Public index (SEO)
app.get("/offers", async (c) => {
  const r = await c.env.MATCHPAY_DB.prepare(`
    SELECT offer_id, brand_id, name, conversion_type, payout_type, payout_amount, currency, join_mode
    FROM offers
    WHERE status = 'active'
    ORDER BY created_at DESC
    LIMIT 500
  `).all();
  return c.json({ results: r.results ?? [] });
});

app.get("/o/:offer_id", async (c) => {
  const offer_id = c.req.param("offer_id");
  const row = await c.env.MATCHPAY_DB.prepare(`SELECT * FROM offers WHERE offer_id=? AND status='active'`).bind(offer_id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

app.get("/b/:brand_id", async (c) => {
  const brand_id = c.req.param("brand_id");
  const row = await c.env.MATCHPAY_DB.prepare(`SELECT brand_id, name, website, payout_sla_days, status, created_at FROM brands WHERE brand_id=?`).bind(brand_id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// Tracking redirect
app.get("/t/:attribution_key", async (c) => {
  const attribution_key = c.req.param("attribution_key");
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ok = await rateLimit(c.env, `click:${ip}`, 120, 60);
  if (!ok) return c.text("rate_limited", 429);

  const join = await c.env.MATCHPAY_DB.prepare(`
    SELECT j.offer_id, j.partner_id, o.landing_url
    FROM offer_joins j
    JOIN offers o ON o.offer_id = j.offer_id
    WHERE j.attribution_key=? AND j.status IN ('active','pending')
  `).bind(attribution_key).first<any>();

  if (!join) return c.text("invalid_token", 404);

  const idk = `click:${attribution_key}:${ip}:${Math.floor(Date.now()/60000)}`;
  await c.env.MATCHPAY_DB.prepare(`
    INSERT OR IGNORE INTO events (event_id, event_type, offer_id, partner_id, attribution_key, idempotency_key, payload, source, created_at)
    VALUES (?, 'click', ?, ?, ?, ?, ?, 'tracking', ?)
  `).bind(
    uuid(), join.offer_id, join.partner_id, attribution_key, idk,
    JSON.stringify({ ip, ua: c.req.header("User-Agent") || null }),
    nowIso()
  ).run();

  return c.redirect(join.landing_url || "https://example.com", 302);
});

// Events
const LeadBody = z.object({
  attribution_key: z.string(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  external_id: z.string().optional(),
  meta: z.record(z.any()).optional()
});

const ConvBody = z.object({
  attribution_key: z.string(),
  external_id: z.string().optional(),
  value: z.number().optional(),
  currency: z.string().optional(),
  meta: z.record(z.any()).optional()
});

app.post("/e/lead", async (c) => {
  const body = LeadBody.parse(await c.req.json());
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ok = await rateLimit(c.env, `lead:${ip}`, 40, 60);
  if (!ok) return c.json({ error: "rate_limited" }, 429);

  const join = await c.env.MATCHPAY_DB.prepare(`
    SELECT offer_id, partner_id FROM offer_joins WHERE attribution_key=? AND status IN ('active','pending')
  `).bind(body.attribution_key).first<any>();
  if (!join) return c.json({ error: "invalid_attribution_key" }, 404);

  const idk = idemKey(c.req.raw) || `lead:${body.attribution_key}:${body.external_id ?? ""}:${body.email ?? ""}:${body.phone ?? ""}`;
  const event_id = uuid();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO events (event_id, event_type, offer_id, partner_id, attribution_key, idempotency_key, payload, source, created_at)
    VALUES (?, 'lead', ?, ?, ?, ?, ?, 'api', ?)
  `).bind(
    event_id, join.offer_id, join.partner_id, body.attribution_key, idk,
    JSON.stringify({ ip, email: body.email ?? null, phone: body.phone ?? null, external_id: body.external_id ?? null, meta: body.meta ?? null }),
    nowIso()
  ).run();

  const conversion_id = uuid();
  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO conversions (conversion_id, event_id, offer_id, partner_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(conversion_id, event_id, join.offer_id, join.partner_id, nowIso()).run();

  return c.json({ ok: true, conversion_id }, 201);
});

app.post("/e/conversion", async (c) => {
  const body = ConvBody.parse(await c.req.json());
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const ok = await rateLimit(c.env, `conv:${ip}`, 60, 60);
  if (!ok) return c.json({ error: "rate_limited" }, 429);

  const join = await c.env.MATCHPAY_DB.prepare(`
    SELECT offer_id, partner_id FROM offer_joins WHERE attribution_key=? AND status IN ('active','pending')
  `).bind(body.attribution_key).first<any>();
  if (!join) return c.json({ error: "invalid_attribution_key" }, 404);

  const idk = idemKey(c.req.raw) || `conv:${body.attribution_key}:${body.external_id ?? ""}:${body.value ?? ""}:${body.currency ?? ""}`;
  const event_id = uuid();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO events (event_id, event_type, offer_id, partner_id, attribution_key, idempotency_key, payload, source, created_at)
    VALUES (?, 'conversion', ?, ?, ?, ?, ?, 'api', ?)
  `).bind(
    event_id, join.offer_id, join.partner_id, body.attribution_key, idk,
    JSON.stringify({ ip, external_id: body.external_id ?? null, value: body.value ?? null, currency: body.currency ?? null, meta: body.meta ?? null }),
    nowIso()
  ).run();

  const conversion_id = uuid();
  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO conversions (conversion_id, event_id, offer_id, partner_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(conversion_id, event_id, join.offer_id, join.partner_id, nowIso()).run();

  return c.json({ ok: true, conversion_id }, 201);
});

// Webhook brand (MVP unsigned)
const WebhookBody = z.object({
  attribution_key: z.string(),
  external_id: z.string().optional(),
  event_type: z.enum(["lead","conversion"]),
  value: z.number().optional(),
  currency: z.string().optional(),
  meta: z.record(z.any()).optional()
});

app.post("/webhooks/brand/:brand_id", async (c) => {
  const brand_id = c.req.param("brand_id");
  const body = WebhookBody.parse(await c.req.json());

  const join = await c.env.MATCHPAY_DB.prepare(`
    SELECT offer_id, partner_id FROM offer_joins WHERE attribution_key=?
  `).bind(body.attribution_key).first<any>();
  if (!join) return c.json({ error: "invalid_attribution_key" }, 404);

  const offerBrand = await c.env.MATCHPAY_DB.prepare(`SELECT brand_id FROM offers WHERE offer_id=?`).bind(join.offer_id).first<any>();
  if (!offerBrand || offerBrand.brand_id !== brand_id) return c.json({ error: "brand_mismatch" }, 403);

  const idk = idemKey(c.req.raw) || `wh:${brand_id}:${body.event_type}:${body.external_id ?? ""}:${body.attribution_key}`;
  const event_id = uuid();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO events (event_id, event_type, offer_id, partner_id, attribution_key, idempotency_key, payload, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'webhook', ?)
  `).bind(
    event_id, body.event_type, join.offer_id, join.partner_id, body.attribution_key, idk,
    JSON.stringify({ external_id: body.external_id ?? null, value: body.value ?? null, currency: body.currency ?? null, meta: body.meta ?? null }),
    nowIso()
  ).run();

  const conversion_id = uuid();
  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO conversions (conversion_id, event_id, offer_id, partner_id, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(conversion_id, event_id, join.offer_id, join.partner_id, nowIso()).run();

  return c.json({ ok: true, conversion_id }, 201);
});

// App endpoints (Auth MVP)
const BrandCreate = z.object({
  owner_user_id: z.string(),
  name: z.string().min(2),
  website: z.string().url().optional(),
  payout_sla_days: z.number().int().positive().default(14)
});

app.post("/app/brands", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const body = BrandCreate.parse(await c.req.json());
  const brand_id = uuid();
  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO brands (brand_id, owner_user_id, name, website, payout_sla_days)
    VALUES (?, ?, ?, ?, ?)
  `).bind(brand_id, body.owner_user_id, body.name, body.website ?? null, body.payout_sla_days).run();
  return c.json({ brand_id }, 201);
});

const PartnerCreate = z.object({
  owner_user_id: z.string(),
  display_name: z.string().optional(),
  niche_tags: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
  country: z.string().optional(),
  language: z.string().optional(),
  methods: z.array(z.string()).default([]),
  portfolio: z.array(z.string()).default([])
});

app.post("/app/partners", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const body = PartnerCreate.parse(await c.req.json());
  const partner_id = uuid();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO partners (partner_id, owner_user_id, display_name, niche_tags, channels, country, language, methods, portfolio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    partner_id, body.owner_user_id, body.display_name ?? null,
    JSON.stringify(body.niche_tags), JSON.stringify(body.channels),
    body.country ?? null, body.language ?? null,
    JSON.stringify(body.methods), JSON.stringify(body.portfolio)
  ).run();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT OR IGNORE INTO wallet_balances (partner_id, available, pending, currency)
    VALUES (?, 0, 0, 'USD')
  `).bind(partner_id).run();

  return c.json({ partner_id }, 201);
});

const OfferCreate = z.object({
  brand_id: z.string(),
  name: z.string().min(2),
  conversion_type: z.enum(["sale","valid_lead","appointment","demo"]),
  payout_type: z.enum(["percent","fixed","per_event"]),
  payout_amount: z.number().int().positive(),
  currency: z.string().default("USD"),
  validation_rules: z.record(z.any()),
  assets: z.array(z.string()).optional(),
  landing_url: z.string().url().optional(),
  allowed_channels: z.array(z.string()).optional(),
  geo: z.array(z.string()).optional(),
  attribution_window_days: z.number().int().positive().default(7),
  join_mode: z.enum(["auto","approval"]).default("auto")
});

app.post("/app/offers", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const body = OfferCreate.parse(await c.req.json());
  const offer_id = uuid();

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO offers (
      offer_id, brand_id, name, conversion_type, payout_type, payout_amount, currency,
      validation_rules, assets, landing_url, allowed_channels, geo, attribution_window_days, join_mode, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).bind(
    offer_id, body.brand_id, body.name, body.conversion_type, body.payout_type, body.payout_amount, body.currency,
    JSON.stringify(body.validation_rules),
    body.assets ? JSON.stringify(body.assets) : null,
    body.landing_url ?? null,
    body.allowed_channels ? JSON.stringify(body.allowed_channels) : null,
    body.geo ? JSON.stringify(body.geo) : null,
    body.attribution_window_days, body.join_mode
  ).run();

  return c.json({ offer_id }, 201);
});

const JoinReq = z.object({
  offer_id: z.string(),
  partner_id: z.string(),
  coupon_code: z.string().optional()
});

app.post("/app/joins", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const body = JoinReq.parse(await c.req.json());
  const join_id = uuid();
  const attribution_key = randomToken(20);

  const offer = await c.env.MATCHPAY_DB.prepare(`SELECT offer_id, join_mode FROM offers WHERE offer_id=? AND status='active'`)
    .bind(body.offer_id).first<any>();
  if (!offer) return c.json({ error: "offer_not_found" }, 404);

  const status = offer.join_mode === "approval" ? "pending" : "active";

  await c.env.MATCHPAY_DB.prepare(`
    INSERT INTO offer_joins (join_id, offer_id, partner_id, status, attribution_key, coupon_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(join_id, body.offer_id, body.partner_id, status, attribution_key, body.coupon_code ?? null).run();

  const tracking_link = `${c.env.PUBLIC_BASE_URL}/t/${attribution_key}`;
  return c.json({ join_id, status, attribution_key, tracking_link }, 201);
});

const ValidateBody = z.object({
  status: z.enum(["valid","invalid"]),
  reason: z.string().optional()
});

app.post("/app/conversions/:conversion_id/validate", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const conversion_id = c.req.param("conversion_id");
  const body = ValidateBody.parse(await c.req.json());

  const conv = await c.env.MATCHPAY_DB.prepare(`
    SELECT conversion_id, offer_id, partner_id, status
    FROM conversions WHERE conversion_id=?
  `).bind(conversion_id).first<any>();
  if (!conv) return c.json({ error: "not_found" }, 404);
  if (conv.status != "pending") return c.json({ error: "already_processed" }, 409);

  const offer = await c.env.MATCHPAY_DB.prepare(`
    SELECT brand_id, payout_type, payout_amount, currency
    FROM offers WHERE offer_id=?
  `).bind(conv.offer_id).first<any>();
  if (!offer) return c.json({ error: "offer_not_found" }, 404);

  if (body.status === "invalid") {
    await c.env.MATCHPAY_DB.prepare(`
      UPDATE conversions SET status='invalid', reason=? WHERE conversion_id=?
    `).bind(body.reason ?? "invalid", conversion_id).run();
    return c.json({ ok: true });
  }

  let amount = 0;
  if (offer.payout_type === "fixed" || offer.payout_type === "per_event") amount = offer.payout_amount;

  const payout_id = uuid();
  await c.env.MATCHPAY_DB.batch([
    c.env.MATCHPAY_DB.prepare(`
      UPDATE conversions SET status='valid', amount=?, currency=? WHERE conversion_id=?
    `).bind(amount, offer.currency, conversion_id),

    c.env.MATCHPAY_DB.prepare(`
      INSERT INTO payouts (payout_id, partner_id, brand_id, conversion_id, amount, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)
    `).bind(payout_id, conv.partner_id, offer.brand_id, conversion_id, amount, offer.currency, nowIso()),

    c.env.MATCHPAY_DB.prepare(`
      INSERT OR IGNORE INTO wallet_balances (partner_id, available, pending, currency)
      VALUES (?, 0, 0, ?)
    `).bind(conv.partner_id, offer.currency),

    c.env.MATCHPAY_DB.prepare(`
      UPDATE wallet_balances SET available=available+?, updated_at=? WHERE partner_id=?
    `).bind(amount, nowIso(), conv.partner_id)
  ]);

  return c.json({ ok: true, payout_id, amount, currency: offer.currency });
});

app.get("/app/partners/:partner_id/balance", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const partner_id = c.req.param("partner_id");
  const row = await c.env.MATCHPAY_DB.prepare(`SELECT * FROM wallet_balances WHERE partner_id=?`).bind(partner_id).first<any>();
  return c.json(row ?? { partner_id, available: 0, pending: 0, currency: "USD" });
});

app.get("/app/partners/:partner_id/payouts", async (c) => {
  if (!getUserId(c)) return c.json({ error: "unauthorized" }, 401);
  const partner_id = c.req.param("partner_id");
  const r = await c.env.MATCHPAY_DB.prepare(`SELECT * FROM payouts WHERE partner_id=? ORDER BY created_at DESC LIMIT 200`).bind(partner_id).all();
  return c.json({ results: r.results ?? [] });
});

export default app;
