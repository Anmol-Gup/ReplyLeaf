import { cookies } from "next/headers";
import { z } from "zod";
import { ACCESS_COOKIE, anonClient } from "../../../../lib/auth/anon";
import { getUserOrNull } from "../../../../lib/auth/session";
import { deleteContactData } from "../../../../lib/privacy";
import { safeEqual } from "../../../../lib/whatsapp/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Data deletion on request: deletes ONE contact (by phone number) and all their
// conversations, messages and booking requests for ONE client.
//
//   Owner:  POST /api/privacy/delete   { "phone": "+91 98765 43210" }   (signed-in dashboard session)
//   Admin:  POST /api/privacy/delete   { "phone": "...", "clientId": "<uuid>" }
//           with  Authorization: Bearer $ADMIN_API_KEY   (disabled unless ADMIN_API_KEY is set)
//
// Owners can only ever delete inside their own business: the client comes from
// their verified membership, never from the request body.
const body = z.object({ phone: z.string().min(6).max(40), clientId: z.string().uuid().optional() });

export async function POST(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "JSON required" }, { status: 415 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  let clientId: string | undefined;
  const adminKey = process.env.ADMIN_API_KEY;
  const auth = req.headers.get("authorization");
  if (auth) {
    // Admin mode
    if (!adminKey || adminKey.length < 24 || !safeEqual(auth, `Bearer ${adminKey}`)) return new Response("Unauthorized", { status: 401 });
    clientId = parsed.data.clientId;
    if (!clientId) return Response.json({ error: "clientId is required in admin mode" }, { status: 400 });
  } else {
    // Owner mode
    const user = await getUserOrNull();
    if (!user) return new Response("Unauthorized", { status: 401 });
    const token = (await cookies()).get(ACCESS_COOKIE)?.value;
    const { data } = await anonClient(token).from("client_users").select("client_id").limit(1);
    clientId = data?.[0]?.client_id as string | undefined;
    if (!clientId) return new Response("Forbidden", { status: 403 });
  }

  try {
    const result = await deleteContactData(clientId, { phone: parsed.data.phone });
    console.log("privacy deletion", { clientId, deleted: result.deleted }); // no phone number in logs
    return Response.json(result);
  } catch {
    return Response.json({ error: "Deletion failed" }, { status: 500 });
  }
}
