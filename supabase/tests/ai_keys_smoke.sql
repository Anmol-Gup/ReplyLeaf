-- Smoke test for bring-your-own AI keys (migration 0012): defaults, constraints, and that a business's key can never be
-- read back through the API. A plain SQL script (no pgTAP). Run it against a THROWAWAY Postgres that has migrations
-- 0001-0012 applied and Supabase's roles stubbed (anon, authenticated, service_role, auth.users, auth.uid()).
-- Never run it on a real project: it inserts fixture rows (inside a transaction that is rolled back at the end).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.client_secrets (client_id, wa_access_token_enc, ai_api_key_enc) values
  ('aaaaaaaa-0000-0000-0000-000000000001','wa-token-a','ENCRYPTED-AI-KEY-A'),
  ('bbbbbbbb-0000-0000-0000-000000000001','wa-token-b','ENCRYPTED-AI-KEY-B');
insert into public.contacts (id, client_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111');
insert into public.conversations (id, client_id, contact_id) values ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1');

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

select pg_temp.check((select ai_mode from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')='platform', 'existing and admin-created clients default to the platform''s AI');
select pg_temp.check((select ai_key_status from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')='none' and (select ai_key_last4 from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001') is null, 'no key status or last four by default');
select pg_temp.fails($$update public.clients set ai_mode='free-for-all'$$, 'ai_mode is restricted to byok / platform');
select pg_temp.fails($$update public.clients set ai_key_status='maybe'$$, 'ai_key_status is restricted');
update public.clients set ai_mode='byok', ai_key_status='valid', ai_key_last4='6789' where id='aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.check((select ai_mode='byok' and ai_key_last4='6789' from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001'), 'a business can be switched to its own key');
select pg_temp.check((select out_created from public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','ai_unavailable','key missing','a message')), 'handoff accepts the ai_unavailable source');

-- The key can never be read through the API, even if the table has the privileges Supabase gives new tables by default.
grant select, insert, update, delete on public.client_secrets to authenticated;
grant select, update on public.clients to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.client_secrets)=0, 'an owner reads ZERO rows of client_secrets (no AI key, no WhatsApp token)');
select pg_temp.check((select ai_key_status from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')='valid' and (select ai_key_last4 from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')='6789', 'an owner CAN see their own key status and last four');
select pg_temp.check((select count(*) from public.clients where id='bbbbbbbb-0000-0000-0000-000000000001')=0, 'an owner cannot see another business at all');
with u as (update public.client_secrets set ai_api_key_enc='stolen' returning 1) select pg_temp.check((select count(*) from u)=0, 'an owner cannot overwrite a key through the API');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.client_secrets)=0, 'another business reads zero secrets too');
reset role;
select pg_temp.check((select ai_api_key_enc from public.client_secrets where client_id='aaaaaaaa-0000-0000-0000-000000000001')='ENCRYPTED-AI-KEY-A', 'the key is untouched');
rollback;
