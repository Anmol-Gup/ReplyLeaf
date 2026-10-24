-- Stage 4: per-day token usage for the dashboard's Usage page.
-- Server only: the dashboard calls it with the service role AFTER deriving the
-- client_id from the signed-in owner's membership.
create function public.client_usage_summary(p_client_id uuid, p_since timestamptz)
returns table (
  out_day date,
  out_provider text,
  out_model text,
  out_kind text,
  out_events bigint,
  out_input_tokens bigint,
  out_output_tokens bigint
)
language sql stable
set search_path = ''
as $$
  select (created_at at time zone 'utc')::date, provider, model, kind,
         count(*), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
    from public.usage_events
   where client_id = p_client_id and created_at >= p_since
   group by 1, 2, 3, 4
   order by 1 desc
$$;

revoke execute on function public.client_usage_summary(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.client_usage_summary(uuid, timestamptz) to service_role;
