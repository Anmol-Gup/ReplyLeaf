# WhatsApp AI Assistant (multi-tenant)

Next.js (App Router, TypeScript) on Vercel + Supabase (Postgres, pgvector, Auth). Small businesses connect a WhatsApp number; an AI assistant answers customers using only that business's knowledge base.

**Status: Stage 3 of 6 (in progress, see git log).** Webhook, dedupe, message batching, AI replies from a pasted knowledge base (Gemini or OpenAI), sample-question eval. CRM, booking requests, email alerts and the dashboard come in later stages.

## How it works
1. `POST /api/webhooks/whatsapp` verifies `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body, constant-time compare). Invalid signature: 401.
2. It **stores the messages first** (quick DB-only step) via the SQL function `record_inbound_message`: one transaction upserts the contact and conversation, inserts the message (`UNIQUE(wa_message_id)` dedupes Meta retries) and queues it in `pending_messages`. If storing fails the route returns 500, so Meta retries.
3. It returns `200` and does the slow work in `after()` (Next.js; on Vercel backed by `waitUntil`, so the function stays alive up to `maxDuration` = 60s).
4. **Batching:** each inbound message pushes the conversation's `batch_due_at` to now + 4s. After waiting, a worker claims the conversation with one atomic UPDATE (`claim_batch`; the row lock lets only one concurrent worker win), builds one prompt from all pending messages, sends one reply, then `complete_batch` removes the handled rows. Messages that arrive during the reply cause another loop.
5. **Recovery:** the claim sets a lease (120s). If a worker crashes the lease expires, and the sweep (`find_due_batches`) re-processes the batch. The sweep runs after every webhook request and from `/api/cron/sweep`. Delivery is at-least-once: a crash between sending and completing can produce a duplicate reply, which we prefer to silence.
6. `generateReply()` (`lib/ai/generate-reply.ts`) calls the client's provider (Gemini or OpenAI adapter in `lib/ai/providers.ts`) and asks for JSON. The output is parsed and validated with Zod; on failure it retries once, then throws. Nothing downstream sees unvalidated output. Input/output tokens are stored on the message and in `usage_events`.

Rules enforced in code: human takeover (`human_active`) keeps the bot silent; auto-handoff on `intent = human_needed` or two failed answers in a row; free-form sends only inside the 24-hour window (otherwise recorded as `blocked`); media-only messages get a "please send text" reply with no AI call; per-customer limit of 30 messages/hour; per-client monthly reply cap (`clients.monthly_message_cap`) checked before each model call; any failure writes an `admin_alerts` row and sends the customer a safe fallback (admin **email** arrives in Stage 3).

**CRM, booking and owner alerts (Stage 3):**
- Every person who messages becomes a contact. A contact's first reply flips it from `new` to `lead` and emails the owner (once, guarded by an atomic SQL update).
- Names/emails the model extracts are guesses. `apply_contact_details` fills **empty** fields only; a different value is stored in `contacts.suggested` for the owner to confirm (dashboard, Stage 4). Emails must pass Zod validation first; junk like "n/a" is dropped.
- Booking: if the client has a `booking_link`, the model shares it and never says "booked". If not, once the model has service + preferred time + name, a `booking_requests` row is saved (one open request per conversation, later messages refine it) and the owner is emailed.
- Owner emails (new lead, new booking request, conversation needs a human) go to `clients.owner_email`; failures go to `ADMIN_ALERT_EMAIL` (first alert of a kind per client per 10 minutes is emailed, the rest stay in `admin_alerts`). Email uses nodemailer + Gmail SMTP behind the `Mailer` interface in `lib/email/mailer.ts`; to swap providers write another implementation there. Emails are plain text and subjects are forced to one line.
- Bookkeeping that fails *after* the customer already got their reply is alerted but never triggers the "something went wrong" fallback message.
- **Gmail setup:** turn on 2-step verification, create an app password at myaccount.google.com/apppasswords, then set `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ADMIN_ALERT_EMAIL`, and `APP_URL`. With these unset, emails are skipped (a warning is logged) and everything else still works. Set the owner address with `OWNER_EMAIL=... npm run create-client`.

**Prompt-injection stance:** the system prompt holds only our rules and the owner's knowledge. Customer text goes only inside `<customer_messages>` tags in a user turn (our closing tag is stripped from it), is labelled untrusted, and the model has no tools, so it cannot read other customers' data or change settings.

**Deviation from the spec:** the model JSON has one extra field, `answered` (boolean). It is the signal needed for "two failed answers" handoff and, in Stage 5, for logging unanswered questions. Remove it from `lib/ai/schema.ts` if you disagree.

## Setup

Requires Node 20.9+.

1. **Install**: `npm install`
2. **Supabase database**: create a project in the Supabase dashboard, then link it and apply the migrations with the Supabase CLI (run from this folder; `npx` downloads the CLI, it is not a project dependency):
   ```bash
   npx supabase login                                  # opens a browser to authorise the CLI
   npx supabase init                                   # once only; creates supabase/config.toml, keeps supabase/migrations/
   npx supabase link --project-ref <project-ref>       # ref = the id in https://supabase.com/dashboard/project/<project-ref>
   npx supabase db push --dry-run                      # preview: should list 0001, 0002 and 0003
   npx supabase db push                                # apply (asks for the database password you set when creating the project)
   npx supabase migration list                         # Local and Remote columns should all show 0001, 0002 and 0003
   ```
   For non-interactive use set `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` instead of answering prompts.
   **Schema rule:** all schema changes live in numbered files in `supabase/migrations/` (`npx supabase migration new <name>` creates the next one). Never edit tables, policies or functions by hand in the dashboard. Each table is created with RLS enabled in the same migration. If you applied an earlier draft of these migrations, reset the project's database first, because 0001/0002 were reorganised before the first release.
3. **Env**: `cp .env.example .env` and fill it in. Generate the encryption key with `openssl rand -base64 32`. `GRAPH_API_VERSION` is pinned in env (the docs currently show `v26.0`).
4. **Meta app** (developers.facebook.com): create a Business app and add the **WhatsApp** product. Under *WhatsApp > API Setup* you get a **test phone number**, its **Phone number ID**, and a temporary **access token** (expires in about 24h; regenerate it and re-run step 6 when it does). Add your own phone as a recipient there.
5. **Webhook**: deploy (or tunnel), then in *WhatsApp > Configuration* set
   - **Callback URL:** `https://<your-domain>/api/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
   - click Verify and save, then **subscribe to the `messages` field**.
   - Local testing: `npm run dev`, expose it with a tunnel (e.g. `ngrok http 3000`) and use `https://<tunnel>/api/webhooks/whatsapp`.
   - `WHATSAPP_APP_SECRET` is under *App settings > Basic > App secret*.
6. **Register the test number as a client**:
   ```
   CLIENT_NAME="Test Biz" WA_PHONE_NUMBER_ID=<phone number id> WA_ACCESS_TOKEN=<token> npm run create-client
   ```
   The token is stored AES-256-GCM encrypted in `client_secrets`, a table the dashboard's database role cannot read.
7. **Add AI keys**: put `GEMINI_API_KEY` (aistudio.google.com) and optionally `OPENAI_API_KEY` in `.env`. Keys are platform-owned, server-only.
8. **Try the eval first** (no database needed): `npm run eval` runs the 20 sample questions in `eval/questions.json` against the sample knowledge base `eval/sample-kb.md` on both providers (or `npm run eval -- --provider gemini`). It prints each reply with PASS/FAIL, tokens and latency. The checks are heuristic, so skim the replies.
9. **Give your test client a knowledge base**: `CLIENT_ID=<uuid printed in step 6> KB_FILE=eval/sample-kb.md npm run set-kb` (optional `BOOKING_LINK=...`, `AI_PROVIDER=openai`). The dashboard editor replaces this in Stage 4.
10. **Test on WhatsApp**: message the test number several short messages in a row. You should get ONE reply about 5 seconds later, built from all of them. Check `messages` (token columns filled), `usage_events` and `pending_messages` (empty again). Replaying the same payload must not produce a second reply.
11. **Vercel**: add the same env vars to the project (including `CRON_SECRET`). The webhook route has `maxDuration = 60`. `vercel.json` schedules `/api/cron/sweep` **once a day**, because Hobby plans allow nothing more frequent; on Pro you can change it to `* * * * *`. The webhook sweeps after every request anyway, so the cron is only a backstop.

## Verify the database after `db push`

Run these in the Supabase SQL editor (read-only). Expected results are in bold.

- [ ] **Extensions**: `select extname from pg_extension where extname in ('vector','pgcrypto');` gives **2 rows**.
- [ ] **11 tables, all with RLS on**: `select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;` gives **admin_alerts, booking_requests, client_secrets, client_users, clients, contacts, conversations, kb_chunks, kb_documents, messages, usage_events, and `rowsecurity = true` on every row**.
- [ ] **9 policies, all `SELECT` for `authenticated`**: `select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1;` gives policies on every table **except `client_secrets` and `admin_alerts`** (those two deliberately have none).
- [ ] **No access for `anon`; browser role is read-only and never sees secrets**: `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') order by 1, 2;` gives **only `SELECT` rows for `authenticated`, nothing for `anon`, and nothing for `client_secrets` or `admin_alerts`**.
- [ ] **Functions locked down**: `select routine_name, grantee from information_schema.routine_privileges where routine_schema = 'public' and routine_name in ('record_inbound_message','current_client_ids') order by 1, 2;` gives **`record_inbound_message` only for `service_role` (plus the owner `postgres`), and `current_client_ids` for `authenticated`**.
- [ ] **Embedding column has no fixed dimension yet**: `select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.kb_chunks'::regclass and attname = 'embedding';` gives **`vector`** (Stage 5 sets the dimension).
- [ ] **RLS actually blocks a browser session**:
  ```sql
  begin;
  set local role authenticated;
  select count(*) from public.clients;          -- 0 (no signed-in user, so no rows)
  select * from public.client_secrets;          -- ERROR: permission denied
  rollback;
  ```
- [ ] **Migrations match**: `npx supabase migration list` shows 0001, 0002 and 0003 on both sides.

## Commands
- `npm test`: unit tests (signature, dedupe, batching, handoff rules, 24h window, caps, AI validation, prompt safety, payload parsing, crypto). Uses Node's built-in test runner on `tsc` output, so no extra test dependency.
- `npm run eval`, `npm run set-kb`, `npm run create-client`, `npm run typecheck`, `npm run build`

## Multi-tenancy and secrets
- Every table has `client_id`. Composite foreign keys `(id, client_id)` stop a row from pointing at another client's parent row.
- RLS is on for every table; owners can only read rows of clients they belong to via `client_users`. `client_secrets` and `admin_alerts` have RLS on with no policy and no grants, so they are unreachable from a browser session.
- The server uses the service-role key (bypasses RLS), so **every server query must filter by `client_id`**. Keep `lib/supabase-admin.ts` out of client code.
- Tokens are never logged or returned to the browser.

## Known limits (planned)
- Knowledge base is plain pasted text with no search (Stage 5 adds chunking and vector search).
- Each webhook invocation sleeps ~5s for the batch window; fine at small scale.
- Dashboard, retention and deletion jobs, daily check and Embedded Signup come in later stages.
- **Real clients can only onboard after Tech Provider approval** (Stage 6, Embedded Signup). Until then only Meta's test number, or numbers in your own WABA, work.
