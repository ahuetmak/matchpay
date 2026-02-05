CREATE INDEX IF NOT EXISTS idx_offers_brand ON offers(brand_id);
CREATE INDEX IF NOT EXISTS idx_joins_offer ON offer_joins(offer_id);
CREATE INDEX IF NOT EXISTS idx_events_offer_partner ON events(offer_id, partner_id);
CREATE INDEX IF NOT EXISTS idx_events_attrkey ON events(attribution_key);
CREATE INDEX IF NOT EXISTS idx_conversions_status ON conversions(status);
CREATE INDEX IF NOT EXISTS idx_payouts_partner_status ON payouts(partner_id, status);
