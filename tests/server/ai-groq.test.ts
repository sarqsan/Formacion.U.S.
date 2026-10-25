import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import {
  aiProvider,
  groqSettings,
  redactSecrets,
  requireGroq,
} from "@/server/ai/config";
import type { FetchLike, GeminiRequest } from "@/server/ai/gemini";
import { generateGroqJson, toGroqMessages, toJsonSchema } from "@/server/ai/groq";
import { createPacer } from "@/server/ai/pacing";
import { generateJson as providerJson } from "@/server/ai/provider";
import {
  approximateTokens,
  chunkPages,
  extractPdfText,
  renderPages,
  selectPages,
  type PdfTextPage,
} from "@/server/ai/text";
import { proposeScreens, proposeTopics, quizRequest } from "@/server/courses/ai-service";
import { buildBlankPdf, buildPdf } from "../helpers/pdf-fixture";

/**
 * GROQ: TEXTO, PETICIÓN Y FALLOS
 * ==============================
 *
 * Groq no lee PDF y limita los tokens por minuto, así que lo que hay que
 * comprobar aquí es justo lo que no se ve en la pantalla:
 *
 *   · el PDF se convierte en texto **numerado por página**;
 *   · un escaneo sin letras se rechaza con un mensaje que se entiende;
 *   · la petición va a la API compatible con OpenAI, con la clave solo en la
 *     cabecera y el esquema descrito en el mensaje;
 *   · los temas de varios tramos se unen sin duplicados;
 *   · cada fallo se traduce a un error accionable.
 *
 * Lo que NO demuestra: que una cuenta real de Groq responda. Eso exige
 * `GROQ_API_KEY` y una generación de verdad desde la pantalla.
 */

const KEY = "gsk_TESTKEY0123456789abcdefghijklmnop";
const GROQ_ENV = { AI_PROVIDER: "groq", GROQ_API_KEY: KEY };

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
}

function respondWith(
  payload: unknown,
  status = 200,
): { fetch: FetchLike; captured: Captured[] } {
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

/** Respuesta de `chat/completions` con el JSON dentro de `content`. */
function completion(content: string, finishReason = "stop", usage = { prompt_tokens: 900, completion_tokens: 300 }) {
  return { choices: [{ message: { content }, finish_reason: finishReason }], usage };
}

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Se esperaba un DomainError y la promesa terminó bien");
}

const baseRequest: GeminiRequest = {
  instruction: "Instrucción de sistema",
  prompt: "Tarea concreta",
  parts: [{ text: "[Página 1]\nContenido del temario" }],
  schema: {
    type: "OBJECT",
    properties: { topics: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["topics"],
  },
  temperature: 0.1,
};

// ---------------------------------------------------------------------------
// Elección de proveedor
// ---------------------------------------------------------------------------

describe("proveedor activo", () => {
  it("usa Gemini si no hay ninguna clave", () => {
    expect(aiProvider({})).toBe("gemini");
  });

  it("usa Groq cuando solo hay clave de Groq", () => {
    expect(aiProvider({ GROQ_API_KEY: KEY })).toBe("groq");
  });

  it("prefiere Gemini si están las dos claves y no se declara proveedor", () => {
    expect(aiProvider({ GROQ_API_KEY: KEY, GEMINI_API_KEY: "AIzaTEST" })).toBe("gemini");
  });

  it("obedece a AI_PROVIDER por encima de las claves", () => {
    expect(aiProvider({ AI_PROVIDER: "groq", GEMINI_API_KEY: "AIzaTEST" })).toBe("groq");
    expect(aiProvider({ AI_PROVIDER: "gemini", GROQ_API_KEY: KEY })).toBe("gemini");
    expect(aiProvider({ AI_PROVIDER: "otra-cosa", GROQ_API_KEY: KEY, GEMINI_API_KEY: "x" })).toBe(
      "gemini",
    );
  });

  it("rechaza el valor por defecto del tramo gratuito en los ajustes", () => {
    const settings = groqSettings({ GROQ_API_KEY: KEY });
    expect(settings.model).toBe("openai/gpt-oss-120b");
    expect(settings.tokensPerMinute).toBe(8000);
    expect(settings.timeoutMs).toBe(90000);
    expect(groqSettings({ GROQ_TPM: "10" }).tokensPerMinute).toBe(1000);
    expect(groqSettings({ GROQ_TPM: "99999999" }).tokensPerMinute).toBe(1_000_000);
  });

  it("falla cerrado y con mensaje accionable si falta la clave", () => {
    expect(() => requireGroq({ AI_PROVIDER: "groq" })).toThrow(/GROQ_API_KEY/);
  });

  it("oculta las claves de los dos proveedores en los mensajes", () => {
    const text = redactSecrets(`fallo con ${KEY} y con AIzaAAAAAAAABBBBBBBBCCCCCCCC`, {
      GROQ_API_KEY: KEY,
    });
    expect(text).not.toContain(KEY);
    expect(text).toContain("[clave oculta]");
  });
});

// ---------------------------------------------------------------------------
// Texto del PDF
// ---------------------------------------------------------------------------

describe("texto del PDF", () => {
  it("extrae el texto de cada página y las numera desde 1", async () => {
    const pdf = buildPdf([
      ["Tema uno: introduccion", "La prevencion empieza por identificar el riesgo."],
      ["Tema dos: evaluacion"],
    ]);
    const text = await extractPdfText(pdf);

    expect(text.totalPages).toBe(2);
    expect(text.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(text.pages[0].text).toContain("introduccion");
    expect(text.emptyPages).toEqual([]);
    expect(text.chars).toBeGreaterThan(20);
  });

  it("dice que no hay texto cuando el PDF es un escaneo", async () => {
    const error = await failure(extractPdfText(buildBlankPdf(2)));
    expect(error.code).toBe("PDF_WITHOUT_TEXT");
    expect(error.status).toBe(422);
    expect(error.message).toMatch(/escaneo/i);
  });

  it("numera las páginas como el documento aunque se seleccionen", () => {
    const pages: PdfTextPage[] = [
      { page: 1, text: "uno" },
      { page: 2, text: "dos" },
      { page: 3, text: "tres" },
    ];
    expect(selectPages(pages, [3]).map((page) => page.page)).toEqual([3]);
    expect(renderPages(selectPages(pages, [3]))).toBe("[Página 3]\ntres");
    expect(selectPages(pages, []).length).toBe(3);
  });

  it("trocea por páginas enteras y respeta el máximo de caracteres", () => {
    const pages: PdfTextPage[] = Array.from({ length: 5 }, (_, index) => ({
      page: index + 1,
      text: "x".repeat(100),
    }));
    const chunks = chunkPages(pages, 250);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().map((page) => page.page)).toEqual([1, 2, 3, 4, 5]);
    for (const chunk of chunks) {
      const chars = chunk.reduce((total, page) => total + page.text.length, 0);
      expect(chars).toBeLessThanOrEqual(250);
    }
  });

  it("estima tokens a cuatro caracteres por token", () => {
    expect(approximateTokens("12345678")).toBe(2);
    expect(approximateTokens("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Petición a Groq
// ---------------------------------------------------------------------------

describe("petición a Groq", () => {
  it("convierte el esquema de Gemini a JSON Schema", () => {
    expect(toJsonSchema(baseRequest.schema)).toEqual({
      type: "object",
      properties: { topics: { type: "array", items: { type: "string" } } },
      required: ["topics"],
    });
  });

  it("pone el papel en el sistema y el documento después de la tarea", () => {
    const [system, user] = toGroqMessages(baseRequest);
    expect(system).toEqual({ role: "system", content: "Instrucción de sistema" });
    expect(user.content).toContain("Tarea concreta");
    expect(user.content).toContain("esquema JSON");
    expect(user.content).toContain("[Página 1]");
    expect(user.content.indexOf("Tarea concreta")).toBeLessThan(user.content.indexOf("[Página 1]"));
  });

  it("se niega a mandar un PDF: el texto tiene que venir extraído", () => {
    expect(() =>
      toGroqMessages({ ...baseRequest, parts: [{ pdf: { bytes: new Uint8Array([1]) } }] }),
    ).toThrow(/no puede leer el PDF/);
  });

  it("llama a chat/completions con la clave en la cabecera y pide JSON", async () => {
    const { fetch, captured } = respondWith(completion('{"topics":["uno"]}'));

    const result = await generateGroqJson(baseRequest, {
      env: GROQ_ENV,
      fetchImpl: fetch,
    });

    expect(captured[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(captured[0].url).not.toContain(KEY);

    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(8192);

    expect(result.data).toEqual({ topics: ["uno"] });
    expect(result.usage).toEqual({ promptTokens: 900, outputTokens: 300 });
  });

  it("acepta el JSON envuelto en un bloque de código", async () => {
    const { fetch } = respondWith(completion('```json\n{"topics":["uno"]}\n```'));
    const result = await generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: fetch });
    expect(result.data).toEqual({ topics: ["uno"] });
  });

  it("traduce los fallos a errores accionables sin filtrar la clave", async () => {
    const unauthorized = respondWith({ error: `invalid key ${KEY}` }, 401);
    const rejected = await failure(
      generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: unauthorized.fetch }),
    );
    expect(rejected.code).toBe("AI_CREDENTIALS_REJECTED");
    expect(rejected.message).not.toContain(KEY);

    const limited = respondWith({ error: "rate limit" }, 429);
    const rate = await failure(generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: limited.fetch }));
    expect(rate.code).toBe("AI_RATE_LIMITED");
    expect(rate.status).toBe(429);

    const missing = respondWith({ error: "model not found" }, 404);
    const model = await failure(generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: missing.fetch }));
    expect(model.code).toBe("AI_MODEL_UNAVAILABLE");

    const down = respondWith({ error: "boom" }, 503);
    const unavailable = await failure(
      generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: down.fetch }),
    );
    expect(unavailable.code).toBe("AI_UNAVAILABLE");
  });

  it("avisa cuando la respuesta se corta por longitud", async () => {
    const { fetch } = respondWith(completion("{}", "length"));
    const error = await failure(generateGroqJson(baseRequest, { env: GROQ_ENV, fetchImpl: fetch }));
    expect(error.code).toBe("AI_INCOMPLETE_RESPONSE");
  });

  it("no sale a Internet si faltan las claves… ni se inventa la respuesta", async () => {
    const error = await failure(
      generateGroqJson(baseRequest, { env: { AI_PROVIDER: "groq" }, fetchImpl: async () => {
        throw new Error("no debería llamarse");
      } }),
    );
    expect(error.code).toBe("AI_NOT_CONFIGURED");
  });
});

// ---------------------------------------------------------------------------
// Enrutado del proveedor
// ---------------------------------------------------------------------------

describe("punto de entrada del proveedor", () => {
  it("manda a Groq cuando el proveedor es groq", async () => {
    const { fetch, captured } = respondWith(completion('{"topics":["uno"]}'));
    await providerJson(baseRequest, { env: GROQ_ENV, fetchImpl: fetch });
    expect(captured[0].url).toContain("api.groq.com");
  });

  it("sigue mandando a Gemini cuando no hay proveedor declarado", async () => {
    const { fetch, captured } = respondWith({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"topics":["uno"]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
    await providerJson(
      { ...baseRequest, parts: [{ pdf: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } }] },
      { env: { GEMINI_API_KEY: "AIzaTESTKEY0123456789abcdefghij" }, fetchImpl: fetch },
    );
    expect(captured[0].url).toContain("generativelanguage.googleapis.com");
  });
});

// ---------------------------------------------------------------------------
// Espaciado por cuota
// ---------------------------------------------------------------------------

describe("espaciado de llamadas", () => {
  it("espera cuando la ventana está llena y no espera si cabe", async () => {
    let clock = 0;
    const slept: number[] = [];
    const pacer = createPacer({
      tokensPerMinute: 8000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await expect(pacer.wait(3000)).resolves.toBe(0);
    pacer.record(6000);

    const waited = await pacer.wait(3000);
    expect(waited).toBeGreaterThan(0);
    expect(slept.length).toBeGreaterThan(0);
    // La espera ha consumido la ventana: ya no queda nada contabilizado.
    expect(pacer.pending()).toBe(0);

    // Y con la ventana vacía no hay que esperar otra vez.
    await expect(pacer.wait(3000)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flujo de contenido con texto (Groq)
// ---------------------------------------------------------------------------

const textPages: PdfTextPage[] = Array.from({ length: 8 }, (_, index) => ({
  page: index + 1,
  text: `Contenido de la página ${index + 1}. `.repeat(120),
}));

const pdfWithText = {
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  pageCount: 8,
  textPages,
};

const groqDeps = (fetchImpl: FetchLike, extra: Record<string, unknown> = {}) => ({
  env: GROQ_ENV,
  fetchImpl,
  sleep: async () => {},
  nowMs: () => 0,
  ...extra,
});

describe("temas con texto troceado", () => {
  it("une los temas de varios tramos sin duplicarlos y ordena por página", async () => {
    let call = 0;
    const captured: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url, init });
      call += 1;
      const content =
        call === 1
          ? JSON.stringify({
              topics: [
                { title: "1. Primer tema", pages: [1, 2], summary: "Uno" },
                { title: "Segundo tema", pages: [3, 4], summary: "Dos" },
              ],
              notes: "El índice no es un tema.",
            })
          : JSON.stringify({
              topics: [
                { title: "Segundo tema", pages: [4, 5], summary: null },
                { title: "Tercer tema", pages: [6] },
              ],
            });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(completion(content)),
      };
    };

    const plan = await proposeTopics(
      { title: "Curso", description: null, pdf: pdfWithText },
      {},
      groqDeps(fetchImpl),
    );

    expect(captured.length).toBeGreaterThan(1); // hubo troceado
    expect(plan.topics.map((topic) => topic.title)).toEqual([
      "1. Primer tema",
      "Segundo tema",
      "Tercer tema",
    ]);
    expect(plan.topics[1].pages).toEqual([3, 4, 5]);
    expect(plan.notes).toContain("índice");
  });

  it("falla claro si el texto no se ha extraído", async () => {
    const { fetch } = respondWith(completion('{"topics":[]}'));
    const error = await failure(
      proposeTopics(
        { title: "Curso", description: null, pdf: { bytes: new Uint8Array([1]), pageCount: 3 } },
        {},
        groqDeps(fetch),
      ),
    );
    expect(error.code).toBe("AI_TEXT_NOT_EXTRACTED");
  });
});

describe("pantallas y cuestionarios con texto", () => {
  it("manda solo las páginas del tema, no el documento entero", async () => {
    const { fetch, captured } = respondWith(
      completion(JSON.stringify({ screens: [{ title: "Uno", paragraphs: ["Texto"], pages: [2] }] })),
    );

    await proposeScreens(
      { courseTitle: "Curso", topicTitle: "Tema", pages: [2], summary: null },
      pdfWithText,
      groqDeps(fetch),
    );

    const body = JSON.parse(String(captured[0].init.body)) as {
      messages: Array<{ content: string }>;
    };
    const user = body.messages[1].content;
    expect(user).toContain("[Página 2]");
    expect(user).not.toContain("[Página 3]");
  });

  it("en el examen final no repite el documento: basta el material", () => {
    const request = quizRequest(
      { subject: "Curso", questionCount: 5, allowMultiple: false, material: "Resumen del curso" },
      pdfWithText,
      { env: GROQ_ENV },
    );
    expect(request.parts).toEqual([]);

    // Con Gemini, en cambio, sigue yendo el PDF completo.
    const withGemini = quizRequest(
      { subject: "Curso", questionCount: 5, allowMultiple: false, material: "Resumen del curso" },
      pdfWithText,
      { env: { GEMINI_API_KEY: "AIzaTEST" } },
    );
    expect(withGemini.parts?.[0]?.pdf).toBeDefined();
  });
});
