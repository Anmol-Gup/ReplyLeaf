-- Every table that has a read policy for owners ("to authenticated") must also GRANT select to authenticated, or the
-- policy is useless on projects without automatic grants. Run on a throwaway Postgres with all migrations applied.
\set ON_ERROR_STOP on
do $$
declare r record; missing text := '';
begin
  for r in select distinct schemaname, tablename from pg_policies where schemaname = 'public' and 'authenticated' = any(roles) and cmd in ('SELECT', 'ALL') loop
    if not has_table_privilege('authenticated', format('%I.%I', r.schemaname, r.tablename), 'select') then
      missing := missing || ' ' || r.tablename;
    end if;
  end loop;
  if missing <> '' then raise exception 'FAILED: owner read policy without a select grant on:%', missing; end if;
  raise notice 'ok - every table with an owner read policy grants select to authenticated';
end $$;
