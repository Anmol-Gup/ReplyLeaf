-- Owners read these tables from the dashboard with their own login (role "authenticated"). Row level security already
-- limits them to their own business, but a table also needs an explicit GRANT. Earlier migrations created the read
-- policies without it, which only works on projects where Supabase adds table grants automatically. On other projects the
-- dashboard pages fail with "permission denied" (the Leads page showed "We couldn't load this"). GRANT is safe to repeat.
-- Read only: all writes still go through the server (service role) or server-only SQL functions.
grant select on public.handoff_requests, public.appointments, public.leads, public.lead_requirements,
  public.notification_settings, public.tickets, public.subscriptions, public.invoices to authenticated;
