import { DomainError } from "@/domain/text";
import {
  MAX_INLINE_PDF_BYTES,
  redactSecrets,
  requireGemini,
  type GeminiEnv,
  type GeminiSettings,
} from "@/server/ai/config";

/**
 * CLIENTE DE GEMINI (servidor)
 * ============================
 *
 * Habla con la API oficial (`generativelanguage.googleapis.com`) por HTTP, sin
 * SDK y sin dependencias nuevas: una petición `generateContent` con el PDF del
 * temario en línea y una respuesta forzada a JSON (`responseMimeType` +
 * `responseSchema`). El modelo **no** puede responder en texto libre, así que
 * lo que llega se puede validar campo a campo antes de tocar el borrador.
 *
 * Reglas que se sostienen aquí:
 *
 *   · la clave va en la cabecera `x-goog-api-key` y nunca aparece en un error,
 *     un log ni una respuesta HTTP;
 *   · toda llamada tiene límite de tiempo (un PDF grande tarda, pero no puede
 *     dejar la petición del administrador colgada);
 *   · los fallos se traducen a errores del dominio con estado HTTP propio, para
 *     que la pantalla explique qué pasó (sin clave, clave rechazada, límite de
 *     cuota, modelo no disponible, respuesta inservible);
 *   · `fetch` se inyecta: las pruebas no salen a Internet y comprueban el
 *     cuerpo exacto de la petición.
 */

export interface GeminiSchema {
  type: "OBJECT" | "ARRAY" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN";
  description?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
}

export interface GeminiPart {
  text?: string;
  /** PDF, en base64, dentro de la propia petición. */
  pdf?: { bytes: Uint8Array };
}

export interface GeminiRequest {
  /** Instrucción de sistema: papel y reglas. */
  instruction: string;
  /** Instrucción de la tarea, después del papel. */
  prompt: string;
  parts?: GeminiPart[];
  schema: GeminiSchema;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiResult {
  data: unknown;
  model: string;
  usage: { promptTokens: number | null; outputTokens: number | null };
}

/**
 * `fetch` inyectable. `body` es **opcional a propósito**: la comprobación de
 * conexión (`status.ts`) es un `GET` al catálogo de modelos y la plataforma
 * rechaza cualquier `GET` o `HEAD` con cuerpo —«Request with GET/HEAD method
 * cannot have body»—, así que la petición se construye sin esa propiedad.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface GeminiDeps {
  settings?: GeminiSettings;
  env?: GeminiEnv;
  fetchImpl?: FetchLike;
  /** Solo pruebas: sustituye el temporizador del límite de tiempo. */
  now?: () => Date;
}

function resolveSettings(deps: GeminiDeps): GeminiSettings & { apiKey: string } {
  return deps.settings
    ? { ...deps.settings, apiKey: deps.settings.apiKey ?? "" }
    : requireGemini(deps.env ?? process.env);
}

function redacted(message: string, deps: GeminiDeps): string {
  return redactSecrets(message, deps.env ?? process.env);
}

/** Trozo de respuesta para poder diagnosticar sin volcar todo el texto. */
function snippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function toGeminiParts(request: GeminiRequest): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of request.parts ?? []) {
    if (part.text !== undefined) parts.push({ text: part.text });
    if (part.pdf) {
      if (part.pdf.bytes.length === 0) {
        throw new DomainError("AI_INPUT_EMPTY", "El PDF está vacío: no hay nada que analizar.", 400);
      }
      if (part.pdf.bytes.length > MAX_INLINE_PDF_BYTES) {
        throw new DomainError(
          "AI_PDF_TOO_LARGE",
          "El PDF es demasiado grande para analizarlo de una vez (máximo 8 MiB). Divide el temario en documentos más pequeños.",
          413,
        );
      }
      parts.push({
        inlineData: { mimeType: "application/pdf", data: base64(part.pdf.bytes) },
      });
    }
  }
  return parts;
}

function mapStatus(status: number, body: string, model: string, deps: GeminiDeps): DomainError {
  const detail = snippet(body);

  if (status === 400 && /API key|api_key|API_KEY/i.test(body)) {
    return new DomainError(
      "AI_CREDENTIALS_REJECTED",
      "Gemini rechazó la clave configurada. Revisa GEMINI_API_KEY en el servidor.",
      502,
      { upstreamStatus: status },
    );
  }
  if (status === 401 || status === 403) {
    return new DomainError(
      "AI_CREDENTIALS_REJECTED",
      redacted(
        "Gemini rechazó las credenciales (401/403). Comprueba que la clave es válida y que la API Generative Language está habilitada en el proyecto.",
        deps,
      ),
      502,
      { upstreamStatus: status },
    );
  }
  if (status === 404) {
    return new DomainError(
      "AI_MODEL_UNAVAILABLE",
      `El modelo «${model}» no está disponible para esta clave. Cambia GEMINI_MODEL a un modelo de la cuenta.`,
      502,
      { upstreamStatus: status },
    );
  }
  if (status === 429) {
    return new DomainError(
      "AI_RATE_LIMITED",
      "Gemini ha devuelto límite de cuota. Espera un momento y reinténtalo; el borrador no se ha tocado.",
      429,
      { upstreamStatus: status },
    );
  }
  if (status >= 500) {
    return new DomainError(
      "AI_UNAVAILABLE",
      "Gemini no responde correctamente ahora mismo. Reinténtalo en unos minutos; no se ha guardado nada.",
      503,
      { upstreamStatus: status },
    );
  }
  return new DomainError(
    "AI_REQUEST_REJECTED",
    redacted(`Gemini rechazó la petición (HTTP ${status}): ${detail}`, deps),
    502,
    { upstreamStatus: status },
  );
}

/**
 * Una llamada a Gemini que devuelve JSON ya parseado.
 *
 * Lanza `DomainError` con código accionable en todos los caminos de error; no
 * hay reintentos internos a propósito: reintentar lo decide la pantalla, que
 * sabe si el administrador sigue delante.
 */
export async function generateJson(request: GeminiRequest, deps: GeminiDeps = {}): Promise<GeminiResult> {
  const settings = resolveSettings(deps);
  if (!settings.apiKey) {
    throw new DomainError(
      "AI_NOT_CONFIGURED",
      "La creación con IA no está configurada: falta GEMINI_API_KEY en el servidor.",
      503,
    );
  }

  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: request.instruction },
          { text: request.prompt },
          ...toGeminiParts(request),
        ],
      },
    ],
    generationConfig: {
      temperature: request.temperature ?? 0.2,
      responseMimeType: "application/json",
      responseSchema: request.schema,
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
    },
  };

  const url = `${settings.apiBase}/models/${encodeURIComponent(settings.model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": settings.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    throw new DomainError(
      aborted ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
      aborted
        ? `Gemini no ha contestado en ${Math.round(settings.timeoutMs / 1000)} s. El temario puede ser muy largo: reinténtalo o divide el PDF.`
        : redacted(
            `No se pudo conectar con Gemini (${(error as Error)?.message ?? "error de red"}). Comprueba la salida a Internet del servidor.`,
            deps,
          ),
      aborted ? 504 : 503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    throw mapStatus(response.status, text, settings.model, deps);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      redacted(`Gemini devolvió algo que no es JSON: ${snippet(text)}`, deps),
      502,
    );
  }

  const payload = parsed as {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };

  if (payload.promptFeedback?.blockReason) {
    throw new DomainError(
      "AI_BLOCKED",
      `Gemini no ha procesado el contenido (${payload.promptFeedback.blockReason}). Revisa que el PDF sea material formativo y no datos personales.`,
      422,
    );
  }

  const candidate = payload.candidates?.[0];
  const raw = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");

  if (!raw.trim()) {
    throw new DomainError(
      "AI_EMPTY_RESPONSE",
      `Gemini no devolvió contenido (${candidate?.finishReason ?? "sin motivo"}). Reinténtalo.`,
      502,
    );
  }

  if (candidate?.finishReason && !["STOP", "FINISH_REASON_STOP"].includes(candidate.finishReason)) {
    throw new DomainError(
      "AI_INCOMPLETE_RESPONSE",
      `La respuesta de Gemini se cortó (${candidate.finishReason}). Reduce el número de elementos pedidos y reinténtalo.`,
      502,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      redacted(`Gemini devolvió un JSON incompleto: ${snippet(raw)}`, deps),
      502,
    );
  }

  return {
    data,
    model: settings.model,
    usage: {
      promptTokens: payload.usageMetadata?.promptTokenCount ?? null,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
}
