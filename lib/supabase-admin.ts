import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

// Service-role client: bypasses RLS, so it is SERVER ONLY and every query made
// with it must filter by client_id itself. Never import this in client code.
let admin: SupabaseClient | undefined;

export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    admin = createClient(env().NEXT_PUBLIC_SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}
