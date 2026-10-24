import { z } from "zod";

// All server env vars are validated in one place, lazily, so a missing
// variable produces one clear error instead of a confusing failure later.
const schema = z.object({
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/, "must look like v26.0"),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Print only variable names, never values.
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}
