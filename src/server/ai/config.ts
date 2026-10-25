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

// ---------------------------------------------------------------------------
// GROQ (alternativa a Gemini)
// ---------------------------------------------------------------------------

/**
 * PROVEEDOR ACTIVO
 * ================
 *
 * `AI_PROVIDER` manda siempre. Si no está puesta, se elige **el que tenga
 * clave**: Groq si existe `GROQ_API_KEY` (y no hay clave de Gemini), Gemini en
 * cualquier otro caso. Así, añadir la variable de Groq en el despliegue cambia
 * de proveedor sin tocar código, y volver a Gemini es tan simple como poner
 * `AI_PROVIDER=gemini`.
 */
export type AiProviderId = "gemini" | "groq";

export function aiProvider(env: GeminiEnv = process.env): AiProviderId {
  const declared = clean(env.AI_PROVIDER)?.toLowerCase();
  if (declared === "groq" || declared === "gemini") return declared;
  if (clean(env.GROQ_API_KEY) && !clean(env.GEMINI_API_KEY)) return "groq";
  return "gemini";
}

export function aiProviderLabel(provider: AiProviderId): string {
  return provider === "groq" ? "Groq" : "Google Gemini";
}

export interface GroqSettings {
  apiKey: string | null;
  model: string;
  /** Raíz compatible con OpenAI (`/openai/v1`), sin barra final. */
  apiBase: string;
  timeoutMs: number;
  /** Tokens por minuto del plan contratado; el tramo gratuito da 8 000. */
  tokensPerMinute: number;
}

/** El modelo abierto grande de Groq: el único gratuito con calidad suficiente. */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_GROQ_API_BASE = "https://api.groq.com/openai/v1";

/** Límite publicado del tramo gratuito (`openai/gpt-oss-120b`). */
export const DEFAULT_GROQ_TOKENS_PER_MINUTE = 8_000;

export function groqSettings(env: GeminiEnv = process.env): GroqSettings {
  const model = clean(env.GROQ_MODEL) ?? DEFAULT_GROQ_MODEL;
  const apiBase = (clean(env.GROQ_API_BASE) ?? DEFAULT_GROQ_API_BASE).replace(/\/+$/, "");

  const rawTimeout = Number(clean(env.GROQ_TIMEOUT_MS) ?? "90000");
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(Math.round(rawTimeout), 10_000), 300_000)
    : 90_000;

  const rawTpm = Number(clean(env.GROQ_TPM) ?? String(DEFAULT_GROQ_TOKENS_PER_MINUTE));
  // Nunca por debajo de 1 000 (haría imposible cualquier petición) ni por
  // encima de 1 000 000 (dejaría de espaciar y chocaría con el límite real).
  const tokensPerMinute = Number.isFinite(rawTpm)
    ? Math.min(Math.max(Math.round(rawTpm), 1_000), 1_000_000)
    : DEFAULT_GROQ_TOKENS_PER_MINUTE;

  return { apiKey: clean(env.GROQ_API_KEY), model, apiBase, timeoutMs, tokensPerMinute };
}

export function isGroqConfigured(env: GeminiEnv = process.env): boolean {
  return groqSettings(env).apiKey !== null;
}

/** Falla cerrado, con un mensaje que el administrador pueda accionar. */
export function requireGroq(env: GeminiEnv = process.env): GroqSettings & { apiKey: string } {
  const settings = groqSettings(env);
  if (!settings.apiKey) {
    throw new DomainError(
      "AI_NOT_CONFIGURED",
      "La creación con IA está configurada para Groq, pero falta GROQ_API_KEY en el servidor. Añádela en el entorno (console.groq.com) y vuelve a intentarlo.",
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
  let out = text;
  for (const key of [clean(env.GEMINI_API_KEY), clean(env.GROQ_API_KEY)]) {
    if (key) out = out.split(key).join("[clave oculta]");
  }
  // Por si la clave llegase desde otra variable del proceso: las de Google
  // empiezan por `AIza` y las de Groq por `gsk_`.
  return out
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[clave oculta]")
    .replace(/gsk_[0-9A-Za-z]{20,}/g, "[clave oculta]");
}
