-- The size of what was uploaded (or pasted) for each knowledge-base document, in bytes. Only the extracted text is
-- stored, so this is what the per-business storage limit (100 MB, open documents only) adds up. Existing documents
-- count as 0 because their original size is not known.
alter table public.kb_documents add column size_bytes bigint not null default 0 check (size_bytes >= 0);
