// supabase-js builds a Realtime client eagerly, and on Node versions without a
// native WebSocket (Node 20) that throws as soon as createClient() is called, even
// for apps that never use Realtime. This app only uses the database and Auth, so
// we hand it a stub transport that fails loudly if anything ever tries to use it.
class NoRealtime {
  constructor() {
    throw new Error("Supabase Realtime is not used in this app");
  }
}

export const REALTIME_STUB = { transport: NoRealtime as unknown as never };
