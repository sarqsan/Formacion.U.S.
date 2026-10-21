import { jsonOk, readJsonBody, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { activationDependencies } from "@/server/deps";
import { activateAccount } from "@/server/auth/activation-service";
import { getServerConfig } from "@/server/config";
import { DomainError } from "@/domain/text";
import { activationLimiter } from "@/server/ratelimit/limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/activate
 * Activación de cuenta: usuario + token de un solo uso + contraseña personal.
 * No hay registro público: el token solo lo emite una importación de admin.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);

    // Límite por dirección: el token de 256 bits ya impide adivinarlo, esto
    // corta el sondeo masivo y el abuso del endpoint. En memoria y por
    // proceso; con varias instancias habría que compartirlo.
    activationLimiter().consumeOrThrow(`activate:${clientKey(request)}`);

    const body = await readJsonBody<{
      username?: unknown;
      token?: unknown;
      newPassword?: unknown;
    }>(request);

    if (
      typeof body.username !== "string" ||
      typeof body.token !== "string" ||
      typeof body.newPassword !== "string"
    ) {
      throw new DomainError("BODY_INVALID", "Faltan datos de activación.");
    }

    const result = await activateAccount(
      { username: body.username, token: body.token, newPassword: body.newPassword },
      activationDependencies(),
    );

    // La contraseña no se registra ni se devuelve.
    return jsonOk({ ok: true, username: result.username });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Identifica al llamante para el límite sin guardar datos personales. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const direct = request.headers.get("x-real-ip");
  const ip = (forwarded?.split(",")[0] ?? direct ?? "").trim();
  return ip || "sin-ip";
}
