-- Stage 3: owner email address, CRM suggestions, booking requests, lead flag.

alter table public.clients add column owner_email text;

-- At most one OPEN booking request per conversation: later messages that refine
-- the details update it instead of creating duplicates (and duplicate emails).
create unique index booking_requests_one_pending_per_conversation
  on public.booking_requests (conversation_id) where status = 'pending';

-- Save (or refine) a booking request. out_created is true only for a new row,
-- which is when the owner gets an email.
create function public.save_booking_request(
  p_client_id uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_service text,
  p_preferred_time text,
  p_name text
)
returns table (out_id uuid, out_created boolean)
language sql
set search_path = ''
as $$
  insert into public.booking_requests (client_id, contact_id, conversation_id, service, preferred_time, name)
  values (p_client_id, p_contact_id, p_conversation_id, p_service, p_preferred_time, p_name)
  on conflict (conversation_id) where status = 'pending'
  do update set service = excluded.service,
                preferred_time = excluded.preferred_time,
                name = excluded.name
  returning id, (xmax = 0)
$$;

-- Model-extracted details are GUESSES. Empty fields are filled in; a value that
-- differs from an existing one is only stored under contacts.suggested, for the
-- owner to confirm in the dashboard. Nothing existing is overwritten here.
create function public.apply_contact_details(
  p_client_id uuid,
  p_contact_id uuid,
  p_name text,
  p_email text
)
returns void
language sql
set search_path = ''
as $$
  update public.contacts c
     set name = case when c.name is null and p_name is not null then p_name else c.name end,
         email = case when c.email is null and p_email is not null then p_email else c.email end,
         suggested =
           (case when p_name is not null and c.name is not null and lower(c.name) <> lower(p_name)
                 then jsonb_set(c.suggested, '{name}', to_jsonb(p_name))
                 else c.suggested end)
           ||
           (case when p_email is not null and c.email is not null and lower(c.email) <> lower(p_email)
                 then jsonb_build_object('email', p_email)
                 else '{}'::jsonb end)
   where c.id = p_contact_id and c.client_id = p_client_id
$$;

-- Flip a brand-new contact to 'lead'. Returns true only for the call that made
-- the change, so the "new lead" email is sent exactly once.
create function public.mark_contact_lead(p_client_id uuid, p_contact_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.contacts set status = 'lead'
   where id = p_contact_id and client_id = p_client_id and status = 'new'
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function
  public.save_booking_request(uuid, uuid, uuid, text, text, text),
  public.apply_contact_details(uuid, uuid, text, text),
  public.mark_contact_lead(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.save_booking_request(uuid, uuid, uuid, text, text, text),
  public.apply_contact_details(uuid, uuid, text, text),
  public.mark_contact_lead(uuid, uuid)
to service_role;
