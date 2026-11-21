-- When the business knowledge last changed in a way a document timestamp cannot show (core text saved, a document deleted).
-- The assistant's earlier replies from before this moment are hidden from it, so it never repeats facts that were removed.
alter table public.clients add column kb_changed_at timestamptz;
