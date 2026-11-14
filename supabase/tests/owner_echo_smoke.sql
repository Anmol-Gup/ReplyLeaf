-- Smoke test for coexistence owner echoes (migration 0016). Throwaway Postgres with migrations 0001-0016 and stubbed Supabase roles only.
\set ON_ERROR_STOP on
begin;
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- 1. first owner reply: stored as an outbound human message, assistant silenced via an open human_active handoff
select pg_temp.check(not (select out_duplicate from public.record_owner_echo('aaaaaaaa-0000-0000-0000-000000000001','919800000001','wamid.e1','text','On my way',now())), 'first echo is stored');
select pg_temp.check((select count(*) from public.messages where wa_message_id='wamid.e1' and direction='outbound' and sender='human')=1, 'stored as outbound human message');
select pg_temp.check((select handling from public.conversations)='human_active', 'assistant is silenced for that chat');
select pg_temp.check((select count(*) from public.handoff_requests where source='owner' and status='human_active')=1, 'one human_active handoff opened');
select pg_temp.check((select last_customer_message_at from public.conversations) is null, 'customer 24h window untouched');
-- 2. Meta retry and a second reply: no duplicates
select pg_temp.check((select out_duplicate from public.record_owner_echo('aaaaaaaa-0000-0000-0000-000000000001','919800000001','wamid.e1','text','On my way',now())), 'retry reports duplicate');
select pg_temp.check((select out_duplicate from public.record_owner_echo('aaaaaaaa-0000-0000-0000-000000000001','919800000001','wamid.e2','text','Done',now())) is false, 'second reply stored');
select pg_temp.check((select count(*) from public.handoff_requests)=1, 'still exactly one handoff');
select pg_temp.check((select count(*) from public.messages)=2, 'two messages in total');
-- 3. another business is untouched
select pg_temp.check((select count(*) from public.conversations where client_id='bbbbbbbb-0000-0000-0000-000000000001')=0, 'other business has nothing');
-- 4. server only
set local role authenticated;
do $$ begin begin perform public.record_owner_echo('aaaaaaaa-0000-0000-0000-000000000001','1','w','text','x',now()); exception when insufficient_privilege then raise notice 'ok - authenticated cannot call record_owner_echo'; return; end; raise exception 'FAILED: callable by authenticated'; end $$;
rollback;
