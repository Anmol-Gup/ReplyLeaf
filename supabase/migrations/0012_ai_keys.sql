-- Bring-your-own AI key (BYOK) next to the platform's own key.
--   ai_mode = 'byok'      the business uses ITS OWN provider key and the provider bills the business.
--                         The default for new self-serve sign-ups (set by the onboarding code).
--   ai_mode = 'platform'  the platform's key is used and the platform pays. Existing clients stay here,
--                         and an admin can grant it. The monthly reply cap applies only in this mode.
-- The key itself is stored ENCRYPTED in client_secrets (RLS on, no policy, no grant: owners can never read it
-- back, not even through the API). Only a status and the last four characters are kept in clients, for display.

alter table public.clients
  add column ai_mode text not null default 'platform' check (ai_mode in ('byok', 'platform')),
  add column ai_key_status text not null default 'none' check (ai_key_status in ('none', 'valid', 'unverified', 'invalid')),
  add column ai_key_last4 text,
  add column ai_key_checked_at timestamptz,
  add column ai_key_notified_at timestamptz;   -- last time the owner was emailed about a missing or bad key (once a day at most)

alter table public.client_secrets add column ai_api_key_enc text;

-- A handoff can also start when the assistant is off because the business's own AI key is missing or invalid.
alter table public.handoff_requests drop constraint handoff_requests_source_check;
alter table public.handoff_requests add constraint handoff_requests_source_check
  check (source in ('customer_request', 'failed_answers', 'booking_without_link', 'owner', 'action_failed', 'ai_unavailable'));
