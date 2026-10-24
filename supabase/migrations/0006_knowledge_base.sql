-- Stage 5: knowledge base at scale.
--   clients.kb_text      = the "core": short, always-included facts (hours, headline prices)
--   kb_documents/chunks  = everything else, found per question by hybrid search
-- Embedding model: Gemini `gemini-embedding-2` at 768 dimensions (recommended
-- size, auto-normalised by the model). The model name is stored per chunk.

-- ---------------------------------------------------------------- documents
alter table public.kb_documents
  add column status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  add column source text not null default 'paste',     -- paste | txt | md | docx | pdf
  add column filename text,
  add column updated_at timestamptz not null default now();
-- version 0 = never published (a draft awaiting the owner's confirmation)
alter table public.kb_documents alter column version set default 0;
create index kb_documents_client_idx on public.kb_documents (client_id, status);

-- Version history: every published change keeps the full text.
create table public.kb_document_versions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid not null,
  version integer not null,
  title text not null,
  content text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (document_id, version),
  foreign key (document_id, client_id) references public.kb_documents (id, client_id) on delete cascade
);
alter table public.kb_document_versions enable row level security;
grant select on public.kb_document_versions to authenticated;
create policy "members read kb versions" on public.kb_document_versions
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ------------------------------------------------------------------- chunks
alter table public.kb_chunks add column chunk_index integer not null default 0;
-- Fix the dimension now that the model is chosen (the table is empty at this point).
alter table public.kb_chunks alter column embedding type vector(768);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);

-- Replace ALL chunks of one document atomically.
-- p_chunks: [{ "heading": text|null, "content": text, "embedding": [numbers]|null, "model": text|null }, ...]
create function public.replace_document_chunks(p_client_id uuid, p_document_id uuid, p_chunks jsonb)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.kb_documents where id = p_document_id and client_id = p_client_id) then
    raise exception 'document not found for this client';
  end if;

  delete from public.kb_chunks where document_id = p_document_id and client_id = p_client_id;

  insert into public.kb_chunks (client_id, document_id, heading, content, embedding, embedding_model, chunk_index)
  select p_client_id, p_document_id, c.elem ->> 'heading', c.elem ->> 'content',
         case when jsonb_typeof(c.elem -> 'embedding') = 'array'
              then (c.elem -> 'embedding')::text::vector else null end,
         c.elem ->> 'model', (c.ord - 1)::integer
    from jsonb_array_elements(p_chunks) with ordinality as c(elem, ord);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Publish a new version of a document: bump the version, keep the old text in
-- history, activate it and swap its chunks, all in one transaction.
create function public.save_document_version(
  p_client_id uuid, p_document_id uuid, p_title text, p_content text, p_user_id uuid, p_chunks jsonb
)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  v_version integer;
begin
  update public.kb_documents
     set title = p_title, content = p_content, version = version + 1,
         status = 'active', updated_at = now()
   where id = p_document_id and client_id = p_client_id
  returning version into v_version;
  if v_version is null then
    raise exception 'document not found for this client';
  end if;

  insert into public.kb_document_versions (client_id, document_id, version, title, content, created_by)
  values (p_client_id, p_document_id, v_version, p_title, p_content, p_user_id);

  perform public.replace_document_chunks(p_client_id, p_document_id, p_chunks);
  return v_version;
end;
$$;

-- Hybrid search: full-text rank and vector rank merged with reciprocal rank
-- fusion. Active documents of ONE client only. p_embedding may be null (embedding
-- service down), in which case this is plain full-text search.
create function public.search_kb(
  p_client_id uuid, p_query text, p_embedding vector default null, p_limit integer default 6, p_rrf_k integer default 50
)
returns table (out_id uuid, out_document_id uuid, out_heading text, out_content text, out_score double precision)
language sql stable
set search_path = public, extensions
as $$
  with fts as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query)) desc) as rank
      from public.kb_chunks c
      join public.kb_documents d on d.id = c.document_id and d.client_id = c.client_id
     where c.client_id = p_client_id and d.status = 'active'
       and c.fts @@ websearch_to_tsquery('english', p_query)
     order by rank
     limit 20
  ),
  sem as (
    select c.id, row_number() over (order by c.embedding <=> p_embedding) as rank
      from public.kb_chunks c
      join public.kb_documents d on d.id = c.document_id and d.client_id = c.client_id
     where p_embedding is not null and c.embedding is not null
       and c.client_id = p_client_id and d.status = 'active'
     order by c.embedding <=> p_embedding
     limit 20
  )
  select c.id, c.document_id, c.heading, c.content,
         (coalesce(1.0 / (p_rrf_k + fts.rank), 0) + coalesce(1.0 / (p_rrf_k + sem.rank), 0))::double precision as score
    from fts
    full outer join sem on fts.id = sem.id
    join public.kb_chunks c on c.id = coalesce(fts.id, sem.id) and c.client_id = p_client_id
   order by score desc
   limit p_limit
$$;

-- ------------------------------------------------- unanswered questions log
create table public.unanswered_questions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  question text not null,                    -- customer words: deleted with the 12-month retention job
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade
);
create index unanswered_questions_client_idx on public.unanswered_questions (client_id, status, created_at desc);
alter table public.unanswered_questions enable row level security;
grant select on public.unanswered_questions to authenticated;
create policy "members read unanswered questions" on public.unanswered_questions
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- Server only.
revoke execute on function
  public.replace_document_chunks(uuid, uuid, jsonb),
  public.save_document_version(uuid, uuid, text, text, uuid, jsonb),
  public.search_kb(uuid, text, vector, integer, integer)
from public, anon, authenticated;
grant execute on function
  public.replace_document_chunks(uuid, uuid, jsonb),
  public.save_document_version(uuid, uuid, text, text, uuid, jsonb),
  public.search_kb(uuid, text, vector, integer, integer)
to service_role;
