-- Smoke test for contacts.spoke (migration 0023). Throwaway Postgres with migrations 0001-0023 and stubbed Supabase roles only.
\set ON_ERROR_STOP on
begin;
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
select * from public.record_inbound_message('aaaaaaaa-0000-0000-0000-000000000001','911','Ann','w1','image',null,now(),0);
select pg_temp.check(not (select spoke from public.contacts where phone='911'), 'a first message that is only an image does not make a listed contact');
select * from public.record_inbound_message('aaaaaaaa-0000-0000-0000-000000000001','911','Ann','w2','text','hello',now(),0);
select pg_temp.check((select spoke from public.contacts where phone='911'), 'the first text message does');
select * from public.record_inbound_message('aaaaaaaa-0000-0000-0000-000000000001','922',null,'w3','text','hi',now(),0);
select pg_temp.check((select spoke from public.contacts where phone='922'), 'a contact whose first message is text is listed at once');
-- an owner reply (outbound) alone never counts
select * from public.record_owner_echo('aaaaaaaa-0000-0000-0000-000000000001','933','e1','text','hello',now());
select pg_temp.check(not (select spoke from public.contacts where phone='933'), 'a message the owner sent does not count as the customer speaking');
rollback;
