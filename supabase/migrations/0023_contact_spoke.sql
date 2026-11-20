-- A contact counts as a real person once they have sent a TEXT message. Someone whose first message is only a photo or a voice note still
-- gets a conversation (so the assistant can ask them to type), but is not listed under Contacts until they type something.
alter table public.contacts add column spoke boolean not null default false;

update public.contacts c set spoke = true
 where exists (select 1 from public.messages m join public.conversations v on v.id = m.conversation_id
                where v.contact_id = c.id and m.direction = 'inbound' and m.type = 'text');

create function public.mark_contact_spoke() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.direction = 'inbound' and new.type = 'text' then
    update public.contacts set spoke = true
     where spoke = false and id = (select v.contact_id from public.conversations v where v.id = new.conversation_id and v.client_id = new.client_id);
  end if;
  return new;
end;
$$;
create trigger messages_mark_contact_spoke after insert on public.messages for each row execute function public.mark_contact_spoke();
