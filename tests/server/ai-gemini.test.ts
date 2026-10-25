import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import { generateJson, type FetchLike, type GeminiRequest } from "@/server/ai/gemini";
import { geminiSettings, redactSecrets } from "@/server/ai/config";

/**
 * CLIENTE DE GEMINI: FORMA DE LA PETICIÓN Y FALLOS
 * ================================================
 *
 * Estas pruebas no salen a Internet: `fetch` se inyecta. Comprueban lo que se
 * puede comprobar sin credenciales reales:
 *
 *   · la petición va a la API oficial, con la clave **solo** en la cabecera;
 *   · el PDF viaja como `inlineData` en base64 y el JSON se exige con esquema;
 *   · la respuesta se parsea y se devuelven los tokens usados;
 *   · cada fallo de Gemini se traduce a un error accionable;
 *   · la clave nunca aparece en un mensaje de error.
 *
 * Lo que NO demuestra: que una cuenta real responda. Eso exige
 * `GEMINI_API_KEY` en el entorno y se ve en `/api/health` y en la pantalla.
 */

const KEY = "AIzaTESTKEY_0123456789abcdefghijklmnop";
const ENV = { GEMINI_API_KEY: KEY };

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
}

function responder(payload: unknown, status = 200): { fetch: FetchLike; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    captured.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { fetch: fetchImpl, captured };
}

function candidate(text: string, finishReason = "STOP") {
  return {
    candidates: [{ finishReason, content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 },
  };
}

const request: GeminiRequest = {
  instruction: "Instrucción de sistema",
  prompt: "Tarea concreta",
  parts: [{ pdf: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } }],
  schema: { type: "OBJECT", properties: { topics: { type: "ARRAY", items: { type: "STRING" } } } },
  temperature: 0.1,
};

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("se esperaba un DomainError");
}

describe("generateJson: petición", () => {
  it("llama a la API oficial con la clave solo en la cabecera y el PDF en línea", async () => {
    const { fetch, captured } = responder(candidate(JSON.stringify({ topics: ["a"] })));

    const result = await generateJson(request, { fetchImpl: fetch, env: ENV });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers["x-goog-api-key"]).toBe(KEY);
    expect(captured[0].url).not.toContain(KEY);
    expect(captured[0].init.body).not.toContain(KEY);

    const body = JSON.parse(captured[0].init.body) as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
      generationConfig: { responseMimeType: string; responseSchema: unknown; temperature: number };
    };

    const parts = body.contents[0].parts;
    expect(parts[0].text).toContain("Instrucción de sistema");
    expect(parts[1].text).toContain("Tarea concreta");
    expect(parts[2].inlineData?.mimeType).toBe("application/pdf");
    expect(Buffer.from(parts[2].inlineData?.data ?? "", "base64")).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46]),
    );

    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(request.schema);
    expect(body.generationConfig.temperature).toBe(0.1);

    expect(result.data).toEqual({ topics: ["a"] });
    expect(result.model).toBe("gemini-2.5-flash");
    expect(result.usage).toEqual({ promptTokens: 120, outputTokens: 80 });
  });

  it("usa el modelo configurado y quita el prefijo models/", async () => {
    const { fetch, captured } = responder(candidate("{}"));
    await generateJson(request, {
      fetchImpl: fetch,
      env: { ...ENV, GEMINI_MODEL: "models/gemini-2.5-pro" },
    });
    expect(captured[0].url).toContain("/models/gemini-2.5-pro:generateContent");
  });

  it("falla con AI_NOT_CONFIGURED si no hay clave, sin llamar a la red", async () => {
    const { fetch, captured } = responder(candidate("{}"));
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: {} }));
    expect(error.code).toBe("AI_NOT_CONFIGURED");
    expect(error.status).toBe(503);
    expect(captured).toHaveLength(0);
  });

  it("no envía un PDF de más de 8 MiB", async () => {
    const { fetch } = responder(candidate("{}"));
    const error = await failure(
      generateJson(
        { ...request, parts: [{ pdf: { bytes: new Uint8Array(8 * 1024 * 1024 + 1) } }] },
        { fetchImpl: fetch, env: ENV },
      ),
    );
    expect(error.code).toBe("AI_PDF_TOO_LARGE");
  });
});

describe("generateJson: fallos de la API", () => {
  it("traduce 401/403 a credenciales rechazadas y no filtra la clave", async () => {
    const { fetch } = responder(`{"error":{"message":"API key not valid: ${KEY}"}}`, 403);
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: ENV }));
    expect(error.code).toBe("AI_CREDENTIALS_REJECTED");
    expect(error.status).toBe(502);
    expect(error.message).not.toContain(KEY);
  });

  it("traduce 400 por clave inválida a credenciales rechazadas", async () => {
    const { fetch } = responder("API key not valid. Please pass a valid API key.", 400);
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: ENV }));
    expect(error.code).toBe("AI_CREDENTIALS_REJECTED");
  });

  it("traduce 404 a modelo no disponible", async () => {
    const { fetch } = responder("{}", 404);
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: ENV }));
    expect(error.code).toBe("AI_MODEL_UNAVAILABLE");
    expect(error.message).toContain("gemini-2.5-flash");
  });

  it("traduce 429 a límite de cuota", async () => {
    const { fetch } = responder("{}", 429);
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: ENV }));
    expect(error.code).toBe("AI_RATE_LIMITED");
    expect(error.status).toBe(429);
  });

  it("traduce 5xx a servicio no disponible", async () => {
    const { fetch } = responder("{}", 503);
    const error = await failure(generateJson(request, { fetchImpl: fetch, env: ENV }));
    expect(error.code).toBe("AI_UNAVAILABLE");
    expect(error.status).toBe(503);
  });

  it("detecta un error de red y un tiempo agotado", async () => {
    const offline: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
    };
    const netError = await failure(generateJson(request, { fetchImpl: offline, env: ENV }));
    expect(netError.code).toBe("AI_UNAVAILABLE");

    const aborted: FetchLike = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };
    const timeout = await failure(generateJson(request, { fetchImpl: aborted, env: ENV }));
    expect(timeout.code).toBe("AI_TIMEOUT");
    expect(timeout.status).toBe(504);
  });

  it("detecta una respuesta bloqueada, vacía o cortada", async () => {
    const blocked = responder({ promptFeedback: { blockReason: "SAFETY" } });
    expect(
      (await failure(generateJson(request, { fetchImpl: blocked.fetch, env: ENV }))).code,
    ).toBe("AI_BLOCKED");

    const empty = responder({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] });
    expect(
      (await failure(generateJson(request, { fetchImpl: empty.fetch, env: ENV }))).code,
    ).toBe("AI_EMPTY_RESPONSE");

    const cut = responder(candidate('{"topics": ["a"', "MAX_TOKENS"));
    expect((await failure(generateJson(request, { fetchImpl: cut.fetch, env: ENV }))).code).toBe(
      "AI_INCOMPLETE_RESPONSE",
    );
  });

  it("detecta JSON inválido o incompleto", async () => {
    const notJson = responder("esto no es json", 200);
    expect(
      (await failure(generateJson(request, { fetchImpl: notJson.fetch, env: ENV }))).code,
    ).toBe("AI_INVALID_OUTPUT");

    const partial = responder(candidate('{"topics": ["a"'));
    expect(
      (await failure(generateJson(request, { fetchImpl: partial.fetch, env: ENV }))).code,
    ).toBe("AI_INVALID_OUTPUT");
  });
});

describe("configuración y redacción", () => {
  it("recorta el tiempo de espera a un rango razonable y aplica valores por defecto", () => {
    expect(geminiSettings({}).model).toBe("gemini-2.5-flash");
    expect(geminiSettings({ GEMINI_TIMEOUT_MS: "1" }).timeoutMs).toBe(10_000);
    expect(geminiSettings({ GEMINI_TIMEOUT_MS: "9999999" }).timeoutMs).toBe(300_000);
    expect(geminiSettings({ GEMINI_MODEL: "  " }).model).toBe("gemini-2.5-flash");
    expect(geminiSettings({ GEMINI_API_KEY: "  " }).apiKey).toBeNull();
  });

  it("oculta la clave de cualquier texto antes de mostrarlo", () => {
    const text = `fallo con ${KEY} y con otra clave AIzaOTRA1234567890abcdefghij`;
    const clean = redactSecrets(text, ENV);
    expect(clean).not.toContain(KEY);
    expect(clean).not.toContain("AIzaOTRA");
    expect(clean).toContain("[clave oculta]");
  });
});
