-- Smoke test for migration 0027: contact and appointment notes (tenant isolation, cascade, RLS). Throwaway Postgres only; rolls back.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111'),('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222');
insert into public.conversations (id, client_id, contact_id) values ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1');
insert into public.appointments (id, client_id, conversation_id, contact_id, customer_phone, purpose) values ('aaaaaaaa-0000-0000-0000-0000000000e1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','111','x');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

insert into public.contact_notes (client_id, contact_id, author_label, body) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1','a@x.com','called back');
insert into public.appointment_notes (client_id, appointment_id, author_label, body) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000e1','a@x.com','confirmed by phone');
select pg_temp.fails($$insert into public.contact_notes (client_id, contact_id, body) values ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1','x')$$, 'a note cannot point at another business''s contact');
select pg_temp.fails($$insert into public.appointment_notes (client_id, appointment_id, body) values ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000e1','x')$$, 'a note cannot point at another business''s appointment');
select pg_temp.fails($$insert into public.contact_notes (client_id, contact_id, body) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1','   ')$$, 'an empty note is refused');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.contact_notes)=1 and (select count(*) from public.appointment_notes)=1, 'members read their own notes');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.contact_notes)=0 and (select count(*) from public.appointment_notes)=0, 'another business sees none');
select pg_temp.fails($$insert into public.contact_notes (client_id, contact_id, body) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1','x')$$, 'signed-in users cannot write notes directly');
reset role;
delete from public.contacts where id='aaaaaaaa-0000-0000-0000-0000000000c1';
select pg_temp.check((select count(*) from public.contact_notes)=0 and (select count(*) from public.appointment_notes)=0, 'deleting the contact removes its notes');
rollback;
