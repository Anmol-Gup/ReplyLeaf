-- Ticket priority becomes Low / Medium / High. "normal" stays the stored value for Medium (so existing tickets and the assistant, which
-- only ever sets normal or high, are unchanged); this adds "low", which only the owner sets.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.tickets'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%priority%';
  if c is not null then execute format('alter table public.tickets drop constraint %I', c); end if;
end $$;
alter table public.tickets add constraint tickets_priority_check check (priority in ('low', 'normal', 'high'));
