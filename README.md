# WhatsApp AI Assistant (multi-tenant)

Next.js (App Router, TypeScript) on Vercel + Supabase (Postgres, pgvector, Auth). Small businesses connect a WhatsApp number; an AI assistant (Gemini or OpenAI, chosen per client) answers customers using only that business's knowledge base. Owners manage everything from a dashboard.

**Status: all 6 stages are built and unit-tested (102 tests).** Nothing has been run against real Meta, Supabase, Gmail or AI-provider accounts yet; see [What is not verified yet](#what-is-not-verified-yet).

> **Real clients can only onboard after Meta approves your app as a Tech Provider.** The Embedded Signup flow (Stage 6) is written but only works for people with a role on your own Meta app until App Review is passed. Until then, connect numbers yourself with `npm run create-client`.

## How it works
1. `POST /api/webhooks/whatsapp` verifies `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body, constant-time compare). Invalid signature: 401. `GET` answers Meta's verify handshake.
2. It **stores the messages first** (quick DB-only step) via the SQL function `record_inbound_message`: one transaction upserts the contact and conversation, inserts the message (`UNIQUE(wa_message_id)` dedupes Meta retries) and queues it in `pending_messages`. If storing fails the route returns 500, so Meta retries.
3. It returns `200` and does the slow work in `after()` (Next.js; on Vercel backed by `waitUntil`, so the function stays alive up to `maxDuration` = 60s).
4. **Batching:** each inbound message pushes the conversation's `batch_due_at` to now + 4s. After waiting, a worker claims the conversation with one atomic UPDATE (`claim_batch`; the row lock lets only one concurrent worker win), builds one prompt from all pending messages, sends one reply, then `complete_batch` removes the handled rows. Messages that arrive during the reply cause another loop.
5. **Recovery:** the claim sets a lease (120s). If a worker crashes the lease expires and the sweep (`find_due_batches`) re-processes the batch. The sweep runs after every webhook request and from `/api/cron/sweep`. Delivery is at-least-once: a crash between sending and completing can produce a duplicate reply, which is preferred over silence.
6. `generateReply()` (`lib/ai/generate-reply.ts`) calls the client's provider (Gemini or OpenAI adapter in `lib/ai/providers.ts`) and asks for JSON. The output is parsed and validated with Zod; on failure it retries once, then throws. Nothing downstream sees unvalidated output. Input/output tokens are stored on the message and in `usage_events`.

Rules enforced in code: human takeover (`human_active`) keeps the bot silent; auto-handoff on `intent = human_needed` or two failed answers in a row; free-form sends only inside the 24-hour window (otherwise recorded as `blocked` and shown as a warning); media-only messages get a "please send text" reply with no AI call; per-customer limit of 30 messages/hour; per-client monthly reply cap (`clients.monthly_message_cap`) checked before each model call; any failure writes an `admin_alerts` row, emails the admin and sends the customer a safe fallback.

**Prompt-injection stance:** the system prompt holds only our rules and the owner's knowledge. Customer text goes only inside `<customer_messages>` tags in a user turn (our closing tag is stripped from it), is labelled untrusted, and the model has no tools, so it cannot read other customers' data or change settings.

**Deviation from the spec:** the model JSON has one extra field, `answered` (boolean). It is the signal needed for "two failed answers" handoff and for logging unanswered questions. Remove it from `lib/ai/schema.ts` if you disagree.

### CRM, booking and owner alerts
- Every person who messages becomes a contact. A contact's first reply flips it from `new` to `lead` and emails the owner (once, guarded by an atomic SQL update).
- Names/emails the model extracts are guesses. `apply_contact_details` fills **empty** fields only; a different value goes to `contacts.suggested` for the owner to confirm in the dashboard. Emails must pass Zod validation first; junk like "n/a" is dropped.
- Booking: if the client has a `booking_link`, the model shares it and never says "booked". If not, once the model has service + preferred time + name, a `booking_requests` row is saved (one open request per conversation, later messages refine it) and the owner is emailed.
- Owner emails (new lead, new booking request, conversation needs a human) go to `clients.owner_email`; failures go to `ADMIN_ALERT_EMAIL` (the first alert of a kind per client per 10 minutes is emailed, the rest stay in `admin_alerts`). Email uses nodemailer + Gmail SMTP behind the `Mailer` interface in `lib/email/mailer.ts`; to swap providers, write another implementation there. Emails are plain text and subjects are forced to one line.
- Bookkeeping that fails *after* the customer already got their reply is alerted but never triggers the "something went wrong" fallback.

### Owner dashboard (`/dashboard`)
Conversations (takeover / hand back / reply), contacts (edit, confirm or dismiss suggestions, delete a person's data), booking requests (confirm / decline), knowledge base, settings (business info, hours, booking link, AI provider, alert email), usage (tokens, monthly cap).
- **Login:** Supabase Auth email + password, no social login. There is no public sign-up: create owners with `CLIENT_ID=<uuid> OWNER_LOGIN_EMAIL=... OWNER_PASSWORD='12+ chars' npm run create-owner`.
- **Sessions** use plain supabase-js (no extra package): the login action stores the tokens in httpOnly cookies, `proxy.ts` refreshes them, and every page re-verifies the user with Supabase (`requireClient()` in `lib/auth/session.ts`).
- **Tenant isolation, two layers:** page reads use a client carrying the owner's own JWT, so RLS applies. Writes (server actions) use the service role but always filter by the `client_id` derived from the verified membership, never from form input. `supabase/tests/rls_isolation.test.sql` is a pgTAP test of the isolation rules (`npx supabase test db`, needs Docker).
- **Human reply:** take over a conversation first (the assistant stays silent while you handle it). Replies outside the 24-hour window are blocked, recorded as "NOT SENT", and shown with a clear warning.
- Confirming or declining a booking request does not message the customer; reply to them yourself from the conversation.

### Knowledge base at scale
- **Two layers.** *Core knowledge* (`clients.kb_text`, max 8,000 chars) is always in the prompt: hours, headline prices. *Documents* hold everything else; for each customer message only the most relevant chunks are added (`<retrieved_knowledge>`).
- **Adding documents** (dashboard > Knowledge base): paste text or upload **.pdf, .docx, .txt** (also .md), up to 2 MB. The text is extracted, shown to the owner for editing, and **nothing is searchable until the owner confirms**. Drafts can be discarded.
- **Chunking** is by markdown headings (`# Policies > ## Cancellations` keeps its path in the chunk), with long sections split at paragraph/sentence boundaries (`lib/kb/chunk.ts`). Word headings become `#` headings on import.
- **Hybrid search** (`search_kb` SQL function): full-text rank and vector rank merged by reciprocal rank fusion, active documents of one client only. Embeddings: Gemini `gemini-embedding-2`, 768 dimensions, one model for every client regardless of their chat provider (so `GEMINI_API_KEY` is needed for search). If embedding fails, chunks are stored without vectors and keyword search still works; the owner can press *Re-index* later.
- **Version history:** every publish keeps the full text (`kb_document_versions`); restoring creates a new version, so history is never rewritten. Archived documents stop being searched.
- **Unanswered questions:** when the model says it could not answer (`answered: false`), the customer's question is logged and listed in the dashboard so the owner can add the answer.
- **File parsing uses no extra packages** (`lib/kb/extract.ts`, built on `node:zlib`). `.txt`, `.md` and `.docx` are reliable. **PDF is best effort:** it reads simple text PDFs, and refuses (with a clear message, storing nothing) scanned PDFs and PDFs whose fonts use custom encodings, which includes many PDFs exported from Word or Google Docs. For robust PDF support, add a parsing package such as `unpdf` and replace `extractPdf`. It was not added because the project rules say to ask before adding dependencies.
- Embedding token usage is not tracked (the embeddings API does not report it).

### Onboarding, privacy and operations (Stage 6)
- **Embedded Signup v4** (`/onboarding`, callback `POST /onboarding/callback`): a signed-in owner without a business sees a "Connect WhatsApp" button that opens Meta's popup (this uses Meta's JS SDK only to connect a number; owners never log in with Facebook). The browser sends the one-time `code` (valid ~30s) plus `waba_id` and `phone_number_id`; the **server** then (1) exchanges the code for a business token, (2) checks that token can read that phone number (so nobody can claim someone else's number), (3) subscribes our app to the customer's WABA, (4) registers the number with a random 6-digit PIN, (5) creates the client, stores the token and PIN **encrypted** (AES-256-GCM), links the owner, and removes the half-saved rows if any save step fails. The request is protected by a signed, 30-minute, per-user `state` token and requires JSON. Needs `NEXT_PUBLIC_META_APP_ID` and `NEXT_PUBLIC_META_ES_CONFIG_ID`; without them the page tells the user to contact you. In the Meta dashboard (Facebook Login for Business > Settings) your domain must be in the allowed domains and valid OAuth redirect URIs, and "Login with the JavaScript SDK" must be on.
- **Data deletion on request:** owners use the button on a contact's page, or `POST /api/privacy/delete {"phone": "+91..."}` with their dashboard session. Admins can call it with `Authorization: Bearer $ADMIN_API_KEY` and a `clientId` (disabled unless `ADMIN_API_KEY` is set). It deletes the contact and, by cascade, their conversations, messages, pending batches, booking requests and logged questions for that one client.
- **Retention job** (`/api/cron/retention`, daily, SQL function `run_retention`): message **content** blanked after 12 months (rows stay for counts); unanswered-question text deleted after 12 months; contacts (and their conversations/messages) deleted 12 months after a client leaves (`npm run offboard-client`); a departed client's WhatsApp token wiped immediately; `admin_alerts` logs deleted after 90 days. **Backups (90 days) are managed by Supabase, not by this code:** set the retention in your Supabase project (Database > Backups) to 90 days or less, and set log retention in Vercel to match. `usage_events` (anonymous token counts) are kept.
- **Daily check** (`/api/cron/daily-check`): per client, messages received vs replies sent in the last 24h, plus conversations with no reply, failed/blocked sends and stuck batches. It emails the admin only when something is wrong.
- **Cron on Vercel:** `vercel.json` runs retention (03:30 UTC), sweep (04:00) and daily check (07:00), each once a day, which Hobby plans allow. All cron routes require `CRON_SECRET` (16+ chars) and are safe to run twice.

## Setup

Requires Node 20.9+.

1. **Install**: `npm install`
2. **Supabase database**: create a project in the Supabase dashboard, then link it and apply the migrations with the Supabase CLI (run from this folder; `npx` downloads the CLI, it is not a project dependency):
   ```bash
   npx supabase login                                  # opens a browser to authorise the CLI
   npx supabase init                                   # once only; creates supabase/config.toml, keeps supabase/migrations/
   npx supabase link --project-ref <project-ref>       # ref = the id in https://supabase.com/dashboard/project/<project-ref>
   npx supabase db push --dry-run                      # preview: should list 0001 to 0007
   npx supabase db push                                # apply (asks for the database password you set when creating the project)
   npx supabase migration list                         # Local and Remote columns should both show 0001 to 0007
   ```
   For non-interactive use set `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` instead of answering prompts.
   **Schema rule:** all schema changes live in numbered files in `supabase/migrations/` (`npx supabase migration new <name>` creates the next one). Never edit tables, policies or functions by hand in the dashboard. Each table is created with RLS enabled in the same migration. If you applied an earlier draft of 0001/0002 (they were reorganised before the first release), reset that database first.
3. **Env**: `cp .env.example .env` and fill it in (every variable is explained there). Generate the encryption key with `openssl rand -base64 32`. `GRAPH_API_VERSION` is pinned in env (Meta's docs currently show `v26.0`). In Supabase > Project Settings > API, copy the project URL, the public anon key and the service-role key.
4. **Meta app** (developers.facebook.com): create a Business app and add the **WhatsApp** product. Under *WhatsApp > API Setup* you get a **test phone number**, its **Phone number ID**, and a temporary **access token** (expires in about 24h; regenerate it and re-run step 7 when it does). Add your own phone as a recipient there.
5. **Webhook**: deploy (or tunnel), then in *WhatsApp > Configuration* set
   - **Callback URL:** `https://<your-domain>/api/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
   - click Verify and save, then **subscribe to the `messages` field**.
   - Local testing: `npm run dev`, expose it with a tunnel (e.g. `ngrok http 3000`) and use `https://<tunnel>/api/webhooks/whatsapp`.
   - `WHATSAPP_APP_SECRET` is under *App settings > Basic > App secret*.
6. **AI keys and email**: put `GEMINI_API_KEY` (aistudio.google.com) and optionally `OPENAI_API_KEY` in `.env`. For email, turn on 2-step verification on a Gmail account, create an app password at myaccount.google.com/apppasswords, and set `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `ADMIN_ALERT_EMAIL` and `APP_URL`. With these unset, emails are skipped (a warning is logged) and everything else still works.
7. **Register the test number as a client**:
   ```
   CLIENT_NAME="Test Biz" WA_PHONE_NUMBER_ID=<phone number id> WA_ACCESS_TOKEN=<token> OWNER_EMAIL=you@example.com npm run create-client
   ```
   The token is stored AES-256-GCM encrypted in `client_secrets`, a table the dashboard's database role cannot read. The command prints the client id.
8. **Create your dashboard login**: `CLIENT_ID=<id from step 7> OWNER_LOGIN_EMAIL=you@example.com OWNER_PASSWORD='a-long-password' npm run create-owner`, then sign in at `/login`.
9. **Try the eval first** (no database needed): `npm run eval` runs the 20 sample questions in `eval/questions.json` against the sample knowledge base `eval/sample-kb.md` on both providers (or `npm run eval -- --provider gemini`). It prints each reply with PASS/FAIL, tokens and latency. The checks are heuristic, so skim the replies.
10. **Give your test client knowledge**: paste the sample into dashboard > Knowledge base > Core knowledge, or run `CLIENT_ID=<id> KB_FILE=eval/sample-kb.md npm run set-kb` (optional `BOOKING_LINK=...`, `AI_PROVIDER=openai`). Try uploading a `.docx` or `.txt` under Documents to see the preview-and-confirm step.
11. **Test on WhatsApp**: message the test number several short messages in a row. You should get ONE reply about 5 seconds later, built from all of them. Check `messages` (token columns filled), `usage_events` and `pending_messages` (empty again). Replaying the same payload must not produce a second reply. Try "I want to talk to a person": you should get an owner email and the conversation shows as waiting in the dashboard.
12. **Vercel**: add the same env vars to the project (including `CRON_SECRET`; on Hobby the crons run once a day, on Pro you can make `/api/cron/sweep` run every minute). Routes that wait for the batch window or call a model set `maxDuration = 60`.

## Verify the database after `db push`

Run these in the Supabase SQL editor (read-only). Expected results are in bold.

- [ ] **Extensions**: `select extname from pg_extension where extname in ('vector','pgcrypto');` gives **2 rows**.
- [ ] **14 tables, all with RLS on**: `select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;` gives **admin_alerts, booking_requests, client_secrets, client_users, clients, contacts, conversations, kb_chunks, kb_document_versions, kb_documents, messages, pending_messages, unanswered_questions, usage_events, and `rowsecurity = true` on every row**.
- [ ] **11 policies, all `SELECT` for `authenticated`**: `select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by 1;` gives policies on every table **except `client_secrets`, `admin_alerts` and `pending_messages`** (those three deliberately have none).
- [ ] **No access for `anon`; browser role is read-only and never sees secrets**: `select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') order by 1, 2;` gives **only `SELECT` rows for `authenticated`, nothing for `anon`, and nothing for `client_secrets`, `admin_alerts` or `pending_messages`**.
- [ ] **Functions locked down**: `select routine_name, grantee from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon','authenticated','public') order by 1;` gives **only `current_client_ids` (for `authenticated`)**. Every other function (`record_inbound_message`, `claim_batch`, `complete_batch`, `find_due_batches`, `save_booking_request`, `apply_contact_details`, `mark_contact_lead`, `client_usage_summary`, `replace_document_chunks`, `save_document_version`, `search_kb`, `run_retention`, `daily_reply_check`) is callable by `service_role` only.
- [ ] **Embedding column is 768-dimensional with an HNSW index**: `select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.kb_chunks'::regclass and attname = 'embedding';` gives **`vector(768)`**, and `select indexname from pg_indexes where tablename = 'kb_chunks';` includes **`kb_chunks_embedding_idx`**.
- [ ] **RLS actually blocks a browser session**:
  ```sql
  begin;
  set local role authenticated;
  select count(*) from public.clients;          -- 0 (no signed-in user, so no rows)
  select * from public.client_secrets;          -- ERROR: permission denied
  rollback;
  ```
- [ ] **Isolation test passes** (needs Docker): `npx supabase test db` runs `supabase/tests/rls_isolation.test.sql`.
- [ ] **Migrations match**: `npx supabase migration list` shows 0001 to 0007 on both sides.

## Commands
- `npm test`: 102 unit tests (signatures, dedupe, batching, handoff rules, 24h window, caps, AI validation, prompt safety, CRM/booking, email, auth helpers, chunking, file extraction, onboarding calls, retention checks). Uses Node's built-in test runner on `tsc` output, so no extra test dependency.
- `npm run eval`: the 20 sample questions against the AI providers.
- `npm run create-client`, `create-owner`, `set-kb`, `offboard-client`: admin scripts (read `.env`).
- `npm run typecheck`, `npm run build`, `npm run dev`.

## Multi-tenancy and secrets
- Every table has `client_id`. Composite foreign keys `(id, client_id)` stop a row from pointing at another client's parent row.
- RLS is on for every table; owners can only read rows of clients they belong to via `client_users`. `client_secrets`, `admin_alerts` and `pending_messages` have RLS on with no policy and no grants, so they are unreachable from a browser session.
- The server uses the service-role key (bypasses RLS), so **every server query filters by `client_id`**. Keep `lib/supabase-admin.ts` out of client code.
- WhatsApp tokens and PINs are AES-256-GCM encrypted at rest (key from `ENCRYPTION_KEY`), never logged, never sent to the browser. The app secret and tokens are kept out of error messages (covered by tests).

## What is not verified yet
- **Never run against real services:** Meta's webhook and send API, Supabase (the SQL in `supabase/migrations/` and the pgTAP test), Gmail SMTP, and the Gemini/OpenAI calls. Unit tests use fakes; types were checked against the installed SDKs. Expect to fix small things on first contact, and run the checklist above.
- **Model IDs** (`gemini-3.5-flash-lite`, `gpt-6-luna`) come from the providers' current model pages; check `gpt-6-luna` supports structured output when you run `npm run eval`. Both are set in `.env`.
- **Embedded Signup** has not been exercised at all and cannot be until your Meta app has a Business Login configuration and Tech Provider approval.
- **PDF upload** is best effort (see above).

## Known limits
- One business per owner login; a login with no business is sent to `/onboarding`.
- Each webhook invocation sleeps ~5s for the batch window; fine at small scale.
- Confirmed/declined bookings and template messages (outside the 24-hour window) are not sent to customers; templates are Phase 2.
- Unsubscribing a departed client's WABA from our app is not automated; do it in Meta's dashboard when offboarding.
