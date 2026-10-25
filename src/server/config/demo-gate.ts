/**
 * CANDADO DE LA DEMOSTRACIÓN
 * ==========================
 *
 * El modo demostración deja entrar **sin contraseña**: la «sesión» es una cookie
 * con el identificador de una cuenta inventada. Es correcto para enseñar la
 * aplicación en un portátil y es una puerta abierta si se activa por error en el
 * servidor de producción.
 *
 * Antes bastaba con que alguien escribiera `DEMO_MODE=1` en las variables de
 * Vercel: la aplicación habría arrancado con el alumnado ficticio y sin pedir
 * credenciales a nadie. La documentación lo desaconsejaba, pero nada lo impedía.
 *
 * Ahora la regla es única y no tiene excepción:
 *
 *   · `DEMO_MODE=1` **no hace nada** si `NODE_ENV=production`;
 *   · no hay variable de escape, porque una variable de escape solo traslada el
 *     problema a «quién puede escribir esa variable»;
 *   · fuera de producción sigue funcionando igual (`DEMO_MODE=1 npm run dev`).
 *
 * Este módulo es puro y no importa nada de Next: lo usan las páginas, el proxy
 * del borde, el diagnóstico y las pruebas. Una sola definición, no tres.
 */

export const DEMO_MODE_VARIABLE = "DEMO_MODE";

export type DemoModeReason = "not-requested" | "production" | "development";

export interface DemoModeDecision {
  /** Solo `true` si la demostración puede usarse de verdad. */
  enabled: boolean;
  reason: DemoModeReason;
  /** Aviso legible cuando se pidió y no se concede. `null` si no hay nada que decir. */
  warning: string | null;
}

type Env = Record<string, string | undefined>;

/**
 * Decide si la demostración está disponible.
 *
 * Solo se pide con el valor exacto `1`: `true`, `yes` o `sí` no la activan, para
 * que un valor «razonable» escrito a mano no abra la puerta por sorpresa.
 */
export function decideDemoMode(env: Env): DemoModeDecision {
  if (env[DEMO_MODE_VARIABLE] !== "1") {
    return { enabled: false, reason: "not-requested", warning: null };
  }

  if (env.NODE_ENV === "production") {
    return {
      enabled: false,
      reason: "production",
      warning:
        "DEMO_MODE=1 se ignora con NODE_ENV=production: la demostración entra sin contraseña y no puede estar abierta en un servidor. Se seguirá usando Firebase. Quita la variable en Vercel.",
    };
  }

  return { enabled: true, reason: "development", warning: null };
}

/** Atajo para el proceso actual. */
export function demoEnabled(env: Env = process.env): boolean {
  return decideDemoMode(env).enabled;
}
