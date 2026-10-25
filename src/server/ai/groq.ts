import { DomainError } from "@/domain/text";
import {
  DEFAULT_GROQ_TOKENS_PER_MINUTE,
  redactSecrets,
  requireGroq,
  type GroqSettings,
  type GeminiEnv,
} from "@/server/ai/config";
import type {
  FetchLike,
  GeminiRequest,
  GeminiResult,
  GeminiSchema,
} from "@/server/ai/gemini";

/**
 * CLIENTE DE GROQ (servidor)
 * ==========================
 *
 * Groq expone una API **compatible con OpenAI** (`/openai/v1/chat/completions`),
 * así que una llamada es un `POST` con mensajes y un `response_format` de tipo
 * `json_object`. Sin SDK y sin dependencias nuevas.
 *
 * Diferencias con Gemini que este módulo tiene que resolver:
 *
 *   · **no lee PDF**: los `parts` con `pdf` son un error de programación aquí
 *     (el flujo tiene que haber extraído el texto antes);
 *   · **no acepta un esquema de respuesta**: se pide JSON y se describe el
 *     esquema en el propio mensaje. La validación real la sigue haciendo el
 *     dominio (`parseTopicPlan`, `parseScreens`, `parseGeneratedQuiz`), que es
 *     la que decide si el resultado sirve;
 *   · **el tramo gratuito limita tokens por minuto** (8 000), así que quien
 *     trocee tiene que espaciar las llamadas: aquí solo se traduce el 429 a un
 *     mensaje que se entiende.
 *
 * La clave va en la cabecera `Authorization: Bearer …` y nunca aparece en un
 * error, un log ni una respuesta HTTP.
 */

/** Tope de tokens de salida por petición (el modelo admite más). */
const MAX_OUTPUT_TOKENS = 8192;

function resolveSettings(deps: { settings?: GroqSettings; env?: GeminiEnv }): GroqSettings & {
  apiKey: string;
} {
  if (deps.settings) {
    const apiKey = deps.settings.apiKey;
    if (!apiKey) {
      throw new DomainError(
        "AI_NOT_CONFIGURED",
        "La creación con IA está configurada para Groq, pero falta GROQ_API_KEY en el servidor.",
        503,
      );
    }
    return { ...deps.settings, apiKey };
  }
  return requireGroq(deps.env ?? process.env);
}

function redacted(message: string, env: GeminiEnv): string {
  return redactSecrets(message, env);
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

/** El esquema de Gemini usa tipos en mayúscula; JSON Schema los usa minúscula. */
export function toJsonSchema(schema: GeminiSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type.toLowerCase() };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    );
  }
  return out;
}

/**
 * Mensajes para `chat/completions`.
 *
 * El orden importa: papel (sistema) → tarea (usuario) → documento (usuario). El
 * documento va **después** de la tarea porque el modelo atiende mejor a lo
 * último que lee, y aquí lo último que tiene que mirar son las páginas.
 */
export function toGroqMessages(request: GeminiRequest): Array<{
  role: "system" | "user";
  content: string;
}> {
  const documentParts: string[] = [];
  for (const part of request.parts ?? []) {
    if (part.pdf) {
      throw new DomainError(
        "AI_PDF_UNSUPPORTED",
        "El proveedor de IA configurado (Groq) no puede leer el PDF directamente: hay que extraer su texto antes de llamar. Avisa a quien mantiene la aplicación.",
        500,
      );
    }
    if (part.text !== undefined && part.text.trim() !== "") documentParts.push(part.text);
  }

  const schema = JSON.stringify(toJsonSchema(request.schema));
  const user = [
    request.prompt,
    "",
    "Formato de la respuesta:",
    "Devuelve EXCLUSIVAMENTE un objeto JSON válido, sin explicaciones, sin texto antes ni después y sin bloques de código.",
    `El objeto debe cumplir este esquema JSON: ${schema}`,
    "",
    ...(documentParts.length > 0
      ? ["Documento de trabajo (cada bloque empieza por su número de página):", "", ...documentParts]
      : []),
  ].join("\n");

  return [
    { role: "system", content: request.instruction },
    { role: "user", content: user },
  ];
}

function mapStatus(status: number, body: string, model: string, env: GeminiEnv): DomainError {
  const detail = snippet(body);

  if (status === 401 || status === 403) {
    return new DomainError(
      "AI_CREDENTIALS_REJECTED",
      redacted(
        "Groq rechazó la clave configurada (401/403). Revisa GROQ_API_KEY en el servidor: la clave se crea en console.groq.com y se muestra una sola vez.",
        env,
      ),
      502,
      { upstreamStatus: status },
    );
  }
  if (status === 404) {
    return new DomainError(
      "AI_MODEL_UNAVAILABLE",
      `El modelo «${model}» no está disponible en esta cuenta de Groq. Cambia GROQ_MODEL por uno del catálogo (por ejemplo openai/gpt-oss-120b).`,
      502,
      { upstreamStatus: status },
    );
  }
  if (status === 413 || status === 429) {
    return new DomainError(
      "AI_RATE_LIMITED",
      "Groq ha cortado la petición por límite de tamaño o de cuota. El plan gratuito admite unos 8 000 tokens por minuto y 200 000 al día: espera un minuto y reinténtalo, o genera el curso por partes. El borrador no se ha tocado.",
      429,
      { upstreamStatus: status },
    );
  }
  if (status === 400 && /context_length|too large|maximum context/i.test(body)) {
    return new DomainError(
      "AI_INPUT_TOO_LARGE",
      "El documento es demasiado largo para una sola llamada de Groq. Genera el contenido por temas, o divide el temario en documentos más pequeños.",
      413,
      { upstreamStatus: status },
    );
  }
  if (status >= 500) {
    return new DomainError(
      "AI_UNAVAILABLE",
      "Groq no responde correctamente ahora mismo. Reinténtalo en unos minutos; no se ha guardado nada.",
      503,
      { upstreamStatus: status },
    );
  }
  return new DomainError(
    "AI_REQUEST_REJECTED",
    redacted(`Groq rechazó la petición (HTTP ${status}): ${detail}`, env),
    502,
    { upstreamStatus: status },
  );
}

/** El modelo a veces envuelve el JSON en ```json … ```; se acepta y se limpia. */
function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export interface GroqDeps {
  settings?: GroqSettings;
  env?: GeminiEnv;
  fetchImpl?: FetchLike;
}

/**
 * Una llamada a Groq que devuelve JSON ya parseado.
 *
 * Mismo contrato que `generateJson` de Gemini (misma forma de resultado y
 * `DomainError` con código accionable), para que el flujo no distinga entre
 * proveedores.
 */
export async function generateGroqJson(
  request: GeminiRequest,
  deps: GroqDeps = {},
): Promise<GeminiResult> {
  const env = deps.env ?? process.env;
  const settings = resolveSettings({ ...(deps.settings ? { settings: deps.settings } : {}), env });

  const fetchImpl =
    deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  const messages = toGroqMessages(request);

  const body = {
    model: settings.model,
    messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: Math.min(request.maxOutputTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    response_format: { type: "json_object" },
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${settings.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    throw new DomainError(
      aborted ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
      aborted
        ? `Groq no ha contestado en ${Math.round(settings.timeoutMs / 1000)} s. El temario puede ser muy largo: reinténtalo o genera el curso por temas.`
        : redacted(
            `No se pudo conectar con Groq (${(error as Error)?.message ?? "error de red"}). Comprueba la salida a Internet del servidor.`,
            env,
          ),
      aborted ? 504 : 503,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    throw mapStatus(response.status, text, settings.model, env);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      redacted(`Groq devolvió algo que no es JSON: ${snippet(text)}`, env),
      502,
    );
  }

  const payload = parsed as {
    choices?: Array<{
      message?: { content?: string | null };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const candidate = payload.choices?.[0];
  const raw = candidate?.message?.content ?? "";

  if (!raw.trim()) {
    throw new DomainError(
      "AI_EMPTY_RESPONSE",
      `Groq no devolvió contenido (${candidate?.finish_reason ?? "sin motivo"}). Reinténtalo.`,
      502,
    );
  }

  if (candidate?.finish_reason === "length") {
    throw new DomainError(
      "AI_INCOMPLETE_RESPONSE",
      "La respuesta de Groq se cortó por longitud. Reduce la cantidad pedida (menos pantallas o menos preguntas) y vuelve a intentarlo.",
      502,
    );
  }
  if (candidate?.finish_reason === "content_filter") {
    throw new DomainError(
      "AI_BLOCKED",
      "Groq no ha procesado el contenido por sus filtros. Revisa que el documento sea material formativo y no datos personales.",
      422,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(unwrapJson(raw));
  } catch {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      redacted(`Groq devolvió un JSON incompleto: ${snippet(raw)}`, env),
      502,
    );
  }

  return {
    data,
    model: settings.model,
    usage: {
      promptTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    },
  };
}

/** Tokens por minuto configurados; lo usa el troceado para espaciar llamadas. */
export function groqTokensPerMinute(env: GeminiEnv = process.env): number {
  const raw = Number(env.GROQ_TPM ?? "");
  return Number.isFinite(raw) && raw >= 1_000 ? Math.round(raw) : DEFAULT_GROQ_TOKENS_PER_MINUTE;
}
