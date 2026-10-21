import { cookies } from "next/headers";
import { jsonOk, readJsonBody, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { createSessionCookie, sessionCookieName, sessionCookieOptions } from "@/server/auth/session";
import { getServerConfig } from "@/server/config";
import { DomainError } from "@/domain/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/session
 * Intercambia un ID token de Firebase (recién emitido tras login) por una
 * cookie de sesión httpOnly. Así el navegador no guarda tokens duraderos.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);

    const body = await readJsonBody<{ idToken?: unknown }>(request);
    if (typeof body.idToken !== "string" || body.idToken.length < 100) {
      throw new DomainError("ID_TOKEN_INVALID", "Sesión no válida.", 401);
    }

    const { value, maxAgeSeconds } = await createSessionCookie(body.idToken);
    const cookieStore = await cookies();
    cookieStore.set({ ...sessionCookieOptions(maxAgeSeconds), value });

    return jsonOk({ ok: true, expiresIn: maxAgeSeconds });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** DELETE /api/auth/session — cierra la sesión del navegador. */
export async function DELETE(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);
    const cookieStore = await cookies();
    cookieStore.delete(sessionCookieName());
    return jsonOk({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
