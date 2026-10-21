import { NextResponse } from "next/server";
import { DomainError } from "@/domain/text";

/** Respuesta JSON uniforme con cabeceras seguras. */
export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<T> {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

const FALLBACK = {
  code: "INTERNAL_ERROR",
  message: "Error interno. Inténtalo de nuevo o avisa a administración.",
  status: 500,
} as const;

/** Traduce errores de dominio a respuestas HTTP sin filtrar detalles internos. */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    return jsonError(error.status, error.code, error.message, error.details);
  }

  // Nunca se devuelve el stack ni mensajes de Firebase al cliente.
  console.error("[api] error no controlado:", error instanceof Error ? error.message : "desconocido");
  return jsonError(FALLBACK.status, FALLBACK.code, FALLBACK.message);
}

/**
 * Comprobación de origen para peticiones que cambian estado.
 *
 * Además de SameSite=Lax en la cookie de sesión, se valida `Origin` cuando
 * está presente: dos barreras contra CSRF.
 *
 * Orígenes aceptados: el configurado en `APP_ORIGIN` y el `Host` real de la
 * petición (con http y https). **No** se acepta `X-Forwarded-Host`: esa
 * cabecera la controla quien llama, así que confiar en ella permitiría a una
 * página ajena declarar su propio dominio como «el nuestro» y saltarse la
 * comprobación. Si se despliega detrás de un proxy, hay que fijar `APP_ORIGIN`
 * al dominio público real.
 */
export function assertTrustedOrigin(
  request: Request,
  allowedOrigin: string | undefined,
): void {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  if (!origin && !referer) {
    // Peticiones sin Origin (curl, pruebas) no se aceptan en mutaciones.
    throw new DomainError("ORIGIN_MISSING", "Petición sin origen.", 403);
  }

  const candidate = origin ?? referer ?? "";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new DomainError("ORIGIN_INVALID", "Origen no válido.", 403);
  }

  const allowed = new Set<string>();
  if (allowedOrigin) allowed.add(new URL(allowedOrigin).origin);

  const host = request.headers.get("host");
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }

  if (allowed.size === 0) {
    throw new DomainError("ORIGIN_UNVERIFIABLE", "No se puede verificar el origen.", 403);
  }

  if (!allowed.has(parsed.origin)) {
    throw new DomainError("ORIGIN_FORBIDDEN", "Origen no permitido.", 403);
  }
}

/** Límite de cuerpo para endpoints JSON. */
export const MAX_JSON_BYTES = 64 * 1024;

export async function readJsonBody<T = unknown>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Se esperaba application/json.", 415);
  }

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new DomainError("BODY_TOO_LARGE", "El cuerpo de la petición es demasiado grande.", 413);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DomainError("BODY_INVALID", "El cuerpo de la petición no es JSON válido.");
  }
}
