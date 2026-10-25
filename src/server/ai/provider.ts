import { aiProvider, type AiProviderId, type GeminiEnv, type GroqSettings } from "@/server/ai/config";
import {
  generateJson as geminiJson,
  type GeminiDeps,
  type GeminiRequest,
  type GeminiResult,
} from "@/server/ai/gemini";
import { generateGroqJson } from "@/server/ai/groq";

/**
 * PROVEEDOR DE IA
 * ===============
 *
 * Un único punto de entrada (`generateJson`) para el flujo de creación de
 * cursos. El flujo pide JSON y le da igual quién lo escriba; aquí se decide si
 * la llamada va a Google Gemini o a Groq según `AI_PROVIDER` (ver
 * `config.ts`).
 *
 * El contrato es el mismo en los dos casos: misma forma de resultado, mismos
 * códigos de error y la clave siempre fuera de los mensajes. Por eso cambiar de
 * proveedor **no toca** ni el editor, ni la validación del dominio, ni la base
 * de datos: solo la forma de viajar.
 */

export interface AiDeps extends GeminiDeps {
  /** Solo pruebas: ajustes de Groq inyectados en vez de leídos del entorno. */
  groqSettings?: GroqSettings;
  /** Solo pruebas: sustituye la espera real entre llamadas. */
  sleep?: (ms: number) => Promise<void>;
  /** Solo pruebas: reloj del espaciado de llamadas. */
  nowMs?: () => number;
}

export { type GeminiRequest, type GeminiResult, type GeminiDeps };

export function activeProvider(env: GeminiEnv = process.env): AiProviderId {
  return aiProvider(env);
}

/**
 * Una llamada al proveedor activo que devuelve JSON ya parseado.
 *
 * Los `parts` con `pdf` solo los entiende Gemini; cuando el proveedor es Groq,
 * el flujo tiene que haber extraído el texto antes (`text.ts`) y mandar `text`.
 * Si se cuela un PDF, el cliente de Groq falla con un error explícito en vez de
 * enviar algo que el otro extremo no sabe leer.
 */
export async function generateJson(
  request: GeminiRequest,
  deps: AiDeps = {},
): Promise<GeminiResult> {
  const env = deps.env ?? process.env;

  if (activeProvider(env) === "groq") {
    const groqDeps = {
      env,
      ...(deps.groqSettings ? { settings: deps.groqSettings } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
    return generateGroqJson(request, groqDeps);
  }

  return geminiJson(request, deps);
}
