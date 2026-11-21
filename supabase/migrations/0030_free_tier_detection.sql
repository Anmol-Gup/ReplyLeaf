-- Eligibility for Meta's free service-message allowance is now read from Meta's own delivery reports (pricing on status webhooks)
-- instead of asked of the owner. These record the last time Meta reported a message as covered by the free tier, and the last time
-- it reported a charged service message.
alter table public.clients
  add column wa_free_tier_seen_at timestamptz,
  add column wa_paid_service_seen_at timestamptz;
