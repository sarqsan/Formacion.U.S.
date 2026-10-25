import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
  aiProvider,
  aiProviderLabel,
  geminiSettings,
  groqSettings,
  redactSecrets,
  type AiProviderId,
  type GeminiEnv,
} from "@/server/ai/config";
import type { FetchLike } from "@/server/ai/gemini";

/**
 * ESTADO DE LA CONEXIÓN CON GEMINI
 * ================================
 *
 * Lo que la pantalla de administración (y `/api/health`) puede contar: si hay
 * clave, qué modelo se usará y si la cuenta responde. **Nunca** la clave, ni su
 * longitud, ni un trozo.
 *
 * La comprobación es una llamada barata al catálogo de modelos de la cuenta
 * (`GET /models`), no una generación: sirve para distinguir «falta la clave»,
 * «la clave no vale» y «la cuenta no tiene ese modelo» sin gastar cuota.
 * El resultado se guarda unos minutos para no golpear la API en cada visita.
 */

export interface GeminiStatus {
  /** Quién responde de verdad: `groq` o `gemini`. */
  provider: AiProviderId;
  /** Nombre legible del proveedor, para la pantalla. */
  providerLabel: string;
  configured: boolean;
  model: string;
  /** `null` = no comprobado (sin clave o comprobación desactivada). */
  reachable: boolean | null;
  /** `null` = no comprobado. `false` = la cuenta no ofrece ese modelo. */
  modelAvailable: boolean | null;
  checkedAt: string | null;
  message: string;
}

export interface GeminiStatusDeps {
  env?: GeminiEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Ignora la caché (botón «comprobar conexión»). */
  force?: boolean;
  /** No sale a la red: solo dice si hay clave. */
  probe?: boolean;
}

const CACHE_MS = 5 * 60 * 1000;

let cache: { at: number; provider: AiProviderId; status: GeminiStatus } | null = null;

/** Solo pruebas. */
export function resetGeminiStatusCache(): void {
  cache = null;
}

function modelId(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return name.replace(/^models\//, "");
}

export async function geminiStatus(deps: GeminiStatusDeps = {}): Promise<GeminiStatus> {
  const env = deps.env ?? process.env;
  const provider = aiProvider(env);
  const now = deps.now ?? (() => new Date());
  const at = now();

  if (provider === "groq") {
    return groqStatus(deps, env, at);
  }

  const settings = geminiSettings(env);

  if (!settings.apiKey) {
    return {
      provider,
      providerLabel: aiProviderLabel(provider),
      configured: false,
      model: settings.model || DEFAULT_GEMINI_MODEL,
      reachable: null,
      modelAvailable: null,
      checkedAt: null,
      message:
        "Sin GEMINI_API_KEY en el servidor. La creación con IA está desactivada; el resto de la aplicación funciona igual.",
    };
  }

  if (deps.probe === false) {
    return {
      provider,
      providerLabel: aiProviderLabel(provider),
      configured: true,
      model: settings.model,
      reachable: null,
      modelAvailable: null,
      checkedAt: null,
      message: `Clave configurada. No se ha comprobado la conexión (modelo ${settings.model}).`,
    };
  }

  if (!deps.force && cache && cache.provider === provider && at.getTime() - cache.at < CACHE_MS) {
    return cache.status;
  }

  const fetchImpl =
    deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  const result = await probeOnce(settings, fetchImpl, at, env, provider);
  cache = { at: at.getTime(), provider, status: result };
  return result;
}

async function probeOnce(
  settings: { apiKey: string | null; model: string; apiBase: string; timeoutMs: number },
  fetchImpl: FetchLike,
  at: Date,
  env: GeminiEnv,
  provider: AiProviderId,
): Promise<GeminiStatus> {
  const checkedAt = at.toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(settings.timeoutMs, 15_000));

  try {
    // `GET` **sin cuerpo**: `ListModels` no admite body y la plataforma lanza
    // «Request with GET/HEAD method cannot have body» si se envía uno (aunque
    // sea la cadena vacía). La clave va en la cabecera `x-goog-api-key`, que es
    // el mecanismo oficial y no aparece en la URL ni en los errores.
    const response = await fetchImpl(`${settings.apiBase}/models?pageSize=200`, {
      method: "GET",
      headers: { "x-goog-api-key": settings.apiKey ?? "" },
      signal: controller.signal,
    });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      return {
        provider,
        providerLabel: aiProviderLabel(provider),
        configured: true,
        model: settings.model,
        reachable: false,
        modelAvailable: null,
        checkedAt,
        message:
          "Gemini rechaza la clave configurada (401/403). Revisa GEMINI_API_KEY y que la API Generative Language esté habilitada.",
      };
    }

    if (!response.ok) {
      return {
        provider,
        providerLabel: aiProviderLabel(provider),
        configured: true,
        model: settings.model,
        reachable: false,
        modelAvailable: null,
        checkedAt,
        message: redactSecrets(
          `Gemini respondió HTTP ${response.status} al comprobar la conexión.`,
          env,
        ),
      };
    }

    let models: string[] = [];
    try {
      const parsed = JSON.parse(text) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
      models = (parsed.models ?? [])
        .filter(
          (model) =>
            !model.supportedGenerationMethods ||
            model.supportedGenerationMethods.includes("generateContent"),
        )
        .map((model) => modelId(model.name))
        .filter((id): id is string => Boolean(id));
    } catch {
      return {
        provider,
        providerLabel: aiProviderLabel(provider),
        configured: true,
        model: settings.model,
        reachable: false,
        modelAvailable: null,
        checkedAt,
        message: "Gemini respondió, pero el catálogo de modelos no se pudo leer.",
      };
    }

    const available = models.includes(settings.model);
    return {
      provider,
      providerLabel: aiProviderLabel(provider),
      configured: true,
      model: settings.model,
      reachable: true,
      modelAvailable: available,
      checkedAt,
      message: available
        ? `Conexión correcta. Se usará el modelo ${settings.model}.`
        : `Conexión correcta, pero la cuenta no ofrece «${settings.model}». Cambia GEMINI_MODEL; modelos disponibles: ${models.slice(0, 5).join(", ") || "ninguno"}.`,
    };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    return {
      provider,
      providerLabel: aiProviderLabel(provider),
      configured: true,
      model: settings.model,
      reachable: false,
      modelAvailable: null,
      checkedAt,
      message: aborted
        ? "La comprobación con Gemini agotó el tiempo de espera. Revisa la salida a Internet del servidor."
        : redactSecrets(
            `No se pudo conectar con Gemini: ${(error as Error)?.message ?? "error de red"}.`,
            env,
          ),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Estado cuando el proveedor activo es Groq.
 *
 * La comprobación es `GET /models` con la clave en la cabecera: no gasta
 * tokens, solo confirma que la clave vale y que el modelo está en el catálogo.
 * El tramo gratuito de Groq no se toca por comprobar la conexión.
 */
async function groqStatus(
  deps: GeminiStatusDeps,
  env: GeminiEnv,
  at: Date,
): Promise<GeminiStatus> {
  const settings = groqSettings(env);
  const provider: AiProviderId = "groq";
  const providerLabel = aiProviderLabel(provider);
  const model = settings.model || DEFAULT_GROQ_MODEL;

  if (!settings.apiKey) {
    return {
      provider,
      providerLabel,
      configured: false,
      model,
      reachable: null,
      modelAvailable: null,
      checkedAt: null,
      message:
        "Sin GROQ_API_KEY en el servidor. La creación con IA está desactivada; el resto de la aplicación funciona igual.",
    };
  }

  if (deps.probe === false) {
    return {
      provider,
      providerLabel,
      configured: true,
      model,
      reachable: null,
      modelAvailable: null,
      checkedAt: null,
      message: `Clave configurada. No se ha comprobado la conexión (modelo ${model}).`,
    };
  }

  if (!deps.force && cache && cache.provider === provider && at.getTime() - cache.at < CACHE_MS) {
    return cache.status;
  }

  const fetchImpl =
    deps.fetchImpl ?? ((input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(settings.timeoutMs, 15_000));
  const checkedAt = at.toISOString();

  let result: GeminiStatus;
  try {
    const response = await fetchImpl(`${settings.apiBase}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
    });
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      result = {
        provider,
        providerLabel,
        configured: true,
        model,
        reachable: false,
        modelAvailable: null,
        checkedAt,
        message:
          "Groq rechaza la clave configurada (401/403). Revisa GROQ_API_KEY: la clave se crea en console.groq.com y solo se muestra una vez.",
      };
    } else if (!response.ok) {
      result = {
        provider,
        providerLabel,
        configured: true,
        model,
        reachable: false,
        modelAvailable: null,
        checkedAt,
        message: redactSecrets(`Groq respondió HTTP ${response.status} al comprobar la conexión.`, env),
      };
    } else {
      let models: string[] = [];
      try {
        const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> };
        models = (parsed.data ?? [])
          .map((entry) => (typeof entry.id === "string" ? entry.id : null))
          .filter((id): id is string => Boolean(id));
      } catch {
        models = [];
      }

      const available = models.includes(model);
      result = {
        provider,
        providerLabel,
        configured: true,
        model,
        reachable: true,
        modelAvailable: available,
        checkedAt,
        message: available
          ? `Conexión correcta con Groq. Se usará el modelo ${model}.`
          : `Groq responde, pero esta cuenta no ofrece «${model}». Cambia GROQ_MODEL; modelos disponibles: ${models.slice(0, 6).join(", ") || "ninguno"}.`,
      };
    }
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    result = {
      provider,
      providerLabel,
      configured: true,
      model,
      reachable: false,
      modelAvailable: null,
      checkedAt,
      message: aborted
        ? "La comprobación con Groq agotó el tiempo de espera. Revisa la salida a Internet del servidor."
        : redactSecrets(
            `No se pudo conectar con Groq: ${(error as Error)?.message ?? "error de red"}.`,
            env,
          ),
    };
  } finally {
    clearTimeout(timer);
  }

  cache = { at: at.getTime(), provider, status: result };
  return result;
}
