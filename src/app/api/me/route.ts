import { jsonOk, toErrorResponse } from "@/server/http";
import { getActor } from "@/server/auth/session";
import { getAdminDb } from "@/server/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Datos mínimos del usuario en sesión (nunca datos sensibles). */
export async function GET() {
  try {
    const actor = await getActor();
    if (!actor) {
      return jsonOk({ authenticated: false });
    }

    const doc = await getAdminDb().collection("accounts").doc(actor.uid).get();
    const data = doc.exists ? doc.data() : undefined;

    return jsonOk({
      authenticated: true,
      uid: actor.uid,
      role: actor.role,
      status: actor.status,
      username: data?.username ?? null,
      personRol: data?.personRol ?? null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
