import { DomainError } from "@/domain/text";

/**
 * CONFIGURACIÓN DE GEMINI (solo servidor)
 * =======================================
 *
 * Se lee del entorno del proceso y **no** forma parte de `serverEnvSchema` a
 * propósito: la aplicación tiene que funcionar sin Gemini (todo lo demás, con
 * sus pruebas, sigue igual) y, si falta la credencial, el error debe ser el de
 * la función que la necesita —un aviso claro en la pantalla—, no un 503 global
 * que tumbe el resto del portal.
 *
 * Nunca se registra la clave, ni se devuelve, ni se envía al navegador. Esta
 * estructura se queda en el servidor: la interfaz solo recibe `status.ts`, que
 * publica si está configurada, el modelo y el resultado de la comprobación.
 */

export interface GeminiSettings {
  apiKey: string | null;
  model: string;
  /** Raíz de la API oficial (`v1beta`), sin barra final. */
  apiBase: string;
  timeoutMs: number;
}

export type GeminiEnv = Record<string, string | undefined>;

/** Modelo por defecto: familia Flash, la adecuada para leer PDF y devolver JSON. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Límite oficial de una petición con el PDF en línea (20 MB de cuerpo). */
export const MAX_INLINE_PDF_BYTES = 8 * 1024 * 1024;

/**
 * Tamaño máximo del PDF que se sube en el asistente.
 *
 * La aplicación admite PDF de hasta 8 MiB, pero el asistente los envía **en una
 * sola petición** (formulario → acción de servidor). Vercel corta cualquier
 * petición a una función en 4,5 MB con un 413 que no llega a nuestro código, así
 * que el límite real en el despliegue es más bajo que el de la aplicación. Se
 * deja margen para las cabeceras del formulario: 4 MiB.
 *
 * Para temarios mayores no hay que tocar esto: en el editor de siempre se suben
 * por partes (endpoint fragmentado), sin pasar por este límite.
 */
export const MAX_AI_UPLOAD_BYTES = 4 * 1024 * 1024;

function clean(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function geminiSettings(env: GeminiEnv = process.env): GeminiSettings {
  const model = clean(env.GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL;
  const apiBase = (clean(env.GEMINI_API_BASE) ?? DEFAULT_GEMINI_API_BASE).replace(/\/+$/, "");

  const rawTimeout = Number(clean(env.GEMINI_TIMEOUT_MS) ?? "120000");
  // Un PDF grande tarda: menos de 10 s no tiene sentido y más de 5 min deja la
  // petición del administrador colgada sin explicación.
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(Math.round(rawTimeout), 10_000), 300_000)
    : 120_000;

  return {
    apiKey: clean(env.GEMINI_API_KEY),
    model: model.replace(/^models\//, ""),
    apiBase,
    timeoutMs,
  };
}

export function isGeminiConfigured(env: GeminiEnv = process.env): boolean {
  return geminiSettings(env).apiKey !== null;
}

/** Falla cerrado, con un mensaje que el administrador pueda accionar. */
export function requireGemini(env: GeminiEnv = process.env): GeminiSettings & { apiKey: string } {
  const settings = geminiSettings(env);
  if (!settings.apiKey) {
    throw new DomainError(
      "AI_NOT_CONFIGURED",
      "La creación con IA no está configurada: falta GEMINI_API_KEY en el servidor. Añádela en el entorno (Google AI Studio) y vuelve a intentarlo.",
      503,
    );
  }
  return { ...settings, apiKey: settings.apiKey };
}

/**
 * La clave nunca debe aparecer en un mensaje de error ni en un log. Esta
 * función se aplica a todo texto antes de lanzarlo o registrarlo.
 */
export function redactSecrets(text: string, env: GeminiEnv = process.env): string {
  const key = clean(env.GEMINI_API_KEY);
  let out = text;
  if (key) out = out.split(key).join("[clave oculta]");
  // Por si la clave llegase desde otra variable del proceso.
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[clave oculta]");
}
