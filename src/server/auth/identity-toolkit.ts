import { DomainError } from "@/domain/text";

/**
 * COMPROBACIÓN DE CONTRASEÑA CONTRA FIREBASE AUTH
 * ===============================================
 *
 * Para cambiar la contraseña hay que demostrar que se conoce la actual. El SDK
 * de Admin **no** puede comprobarlo: sabe fijar contraseñas, no verificarlas.
 * La comprobación se hace contra el endpoint de Identity Toolkit con la clave
 * web del proyecto, que es pública (identifica el proyecto, no autoriza nada) y
 * ya está configurada en Vercel para el SDK del navegador.
 *
 * No se usa el SDK del navegador a propósito: así la contraseña actual no pasa
 * por el cliente y la decisión de aceptar el cambio se toma en el servidor.
 */

const ENDPOINT = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

export interface VerifyPasswordInput {
  email: string;
  password: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * `true` si la contraseña es la correcta.
 *
 * Distingue tres desenlaces porque la interfaz debe poder decir la verdad:
 *   · contraseña incorrecta → `false` (mensaje genérico, no se revela nada más);
 *   · demasiados intentos     → error 429 (no es «contraseña incorrecta»);
 *   · Auth no disponible      → error 503 (no se puede afirmar nada).
 */
export async function verifyAccountPassword(input: VerifyPasswordInput): Promise<boolean> {
  const doFetch = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${ENDPOINT}?key=${encodeURIComponent(input.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, password: input.password }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DomainError("AUTH_UNAVAILABLE", "No se ha podido comprobar la contraseña. Inténtalo de nuevo.", 503);
  }

  if (response.ok) return true;

  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  const code = (body.error?.message ?? "").split(" ")[0];

  if (
    code === "INVALID_PASSWORD" ||
    code === "EMAIL_NOT_FOUND" ||
    code === "INVALID_LOGIN_CREDENTIALS" ||
    code === "INVALID_EMAIL"
  ) {
    return false;
  }
  if (code === "TOO_MANY_ATTEMPTS_TRY_LATER" || response.status === 429) {
    throw new DomainError(
      "RATE_LIMITED",
      "Demasiados intentos. Espera unos minutos antes de volver a probar.",
      429,
    );
  }
  if (code === "USER_DISABLED") {
    throw new DomainError("ACCOUNT_DISABLED", "Esta cuenta está deshabilitada.", 403);
  }

  throw new DomainError("AUTH_UNAVAILABLE", "No se ha podido comprobar la contraseña. Inténtalo de nuevo.", 503);
}
