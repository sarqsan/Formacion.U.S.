import { cookies } from "next/headers";
import { jsonOk, toErrorResponse, assertTrustedOrigin, readJsonBody } from "@/server/http";
import { requireActor, sessionCookieName } from "@/server/auth/session";
import { getServerConfig } from "@/server/config";
import { passwordChangeDependencies } from "@/server/deps";
import { changeOwnPassword } from "@/server/accounts/password-service";
import { passwordLimiter } from "@/server/ratelimit/limiter";
import { isDemoMode } from "@/demo/session";
import { DomainError } from "@/domain/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
  newPasswordRepeat?: unknown;
}

/**
 * POST /api/account/password
 *   { currentPassword, newPassword, newPasswordRepeat }
 *
 * Cambia **la contraseña de quien llama**. No acepta ningún identificador de
 * cuenta: el uid sale de la sesión verificada, así que esta ruta no permite
 * tocar la contraseña de otra persona ni con una sesión de administrador.
 *
 * Al terminar se revoca la sesión: la cookie se borra aquí mismo y el usuario
 * vuelve a entrar con la contraseña nueva. Si alguien más estaba dentro con esa
 * cuenta, deja de estarlo (la verificación de la cookie consulta revocación).
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);

    if (isDemoMode()) {
      throw new DomainError(
        "DEMO_UNSUPPORTED",
        "El cambio de contraseña no está disponible en la demostración.",
        400,
      );
    }

    const actor = await requireActor();
    // Límite por usuario: corta el sondeo de la contraseña actual.
    passwordLimiter().consumeOrThrow(`password:${actor.uid}`);

    const body = await readJsonBody<PasswordBody>(request);
    const result = await changeOwnPassword(actor, body, passwordChangeDependencies());

    const cookieStore = await cookies();
    cookieStore.delete(sessionCookieName());

    return jsonOk({ ok: true, username: result.username, changedAt: result.changedAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}
