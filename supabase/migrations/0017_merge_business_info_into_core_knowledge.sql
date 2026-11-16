-- "About the business" and "Opening hours" were removed from Settings: the knowledge base's core text is
-- now the one place for them. Move any existing text into clients.kb_text (about, hours, then the old core
-- text) and clear the old columns, which the assistant's prompt still reads, so nothing is said twice.
-- A business whose merged text would not fit the 8,000-character core limit is left untouched, so no text
-- is ever cut off.
update public.clients c
   set kb_text = m.merged, business_info = null, business_hours = null
  from (
    select id,
           concat_ws(E'\n\n',
             nullif(btrim(business_info), ''),
             case when nullif(btrim(business_hours), '') is not null then 'Opening hours: ' || btrim(business_hours) end,
             nullif(btrim(kb_text), '')) as merged
      from public.clients
     where business_info is not null or business_hours is not null
  ) m
 where c.id = m.id and length(m.merged) <= 8000;
