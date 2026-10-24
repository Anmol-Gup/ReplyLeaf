# WhatsApp AI Assistant (multi-tenant)

Next.js (App Router, TypeScript) on Vercel + Supabase (Postgres, pgvector, Auth). Small businesses connect a WhatsApp number; an AI assistant answers customers using only that business's knowledge base.

**Status: Stage 1 of 6.** Webhook, signature check, dedupe, message storage, fixed-text reply, RLS schema. No AI yet.

## What Stage 1 does
- `GET /api/webhooks/whatsapp` answers Meta's verification handshake (`hub.verify_token`).
- `POST /api/webhooks/whatsapp` verifies `X-Hub-Signature-256` (HMAC-SHA256 of the **raw** body with the app secret, constant-time compare), returns `200` immediately, and does the work in `after()` (Next.js; on Vercel this is backed by `waitUntil`, so the function stays alive until the work finishes, up to `maxDuration`).
- Each inbound message is stored via the SQL function `record_inbound_message` (one transaction: upsert contact + conversation, insert message; `UNIQUE(wa_message_id)` dedupes Meta retries).
- If the conversation is `human_active` the bot stays silent. Otherwise it sends a fixed reply, but only inside the 24-hour window (`last_customer_message_at`); outside it the send is blocked and recorded as `blocked`.
- Non-text messages (voice, images) get a "please send text" reply.
- Failures write an `admin_alerts` row and send the customer a safe fallback. (Admin **email** arrives in Stage 3 with nodemailer.)

## Setup

Requires Node 20.9+.

1. **Install**: `npm install`
2. **Supabase**: create a project, then apply the migrations in `supabase/migrations/` in order (`0001`, `0002`, `0003`), either with the Supabase CLI (`supabase link`, then `supabase db push`) or by pasting each file into the SQL editor.
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
7. **Test**: from your phone, message the test number. You should get the fixed reply and see rows in `contacts`, `conversations` and `messages`. Replaying the same payload must not produce a second reply.
8. **Vercel**: add the same env vars to the project. The webhook route has `maxDuration = 60`.

## Commands
- `npm test`: unit tests (signature, dedupe, 24h window, payload parsing, crypto). Uses Node's built-in test runner on `tsc` output, so no extra test dependency.
- `npm run typecheck`, `npm run build`

## Multi-tenancy and secrets
- Every table has `client_id`. Composite foreign keys `(id, client_id)` stop a row from pointing at another client's parent row.
- RLS is on for every table; owners can only read rows of clients they belong to via `client_users`. `client_secrets` and `admin_alerts` have RLS on with no policy and no grants, so they are unreachable from a browser session.
- The server uses the service-role key (bypasses RLS), so **every server query must filter by `client_id`**. Keep `lib/supabase-admin.ts` out of client code.
- Tokens are never logged or returned to the browser.

## Known Stage 1 limits (planned)
- No batching yet: each message gets its own reply. Stage 2 adds the pending-messages worker.
- A crash between storing a message and replying is not retried, because a Meta retry would be deduped. The Stage 2 worker design fixes this.
- Rate limits, monthly cap, email alerts, dashboard, retention and deletion jobs come in later stages.
- **Real clients can only onboard after Tech Provider approval** (Stage 6, Embedded Signup). Until then only Meta's test number, or numbers in your own WABA, work.
