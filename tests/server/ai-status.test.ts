import { beforeEach, describe, expect, it } from "vitest";
import { geminiStatus, resetGeminiStatusCache } from "@/server/ai/status";
import type { FetchLike } from "@/server/ai/gemini";

/**
 * ESTADO DE LA CONEXIÓN CON GEMINI
 * ================================
 *
 * Lo que ve el administrador antes de pulsar «generar»: si hay clave, qué
 * modelo se usará y si la cuenta responde. Nunca la clave. La comprobación es
 * barata (catálogo de modelos) y se cachea para no golpear la API en cada
 * visita.
 *
 * Sin clave no se llama a la red: la aplicación sigue funcionando y la pantalla
 * lo dice.
 */

const KEY = "AIzaTEST_0123456789abcdefghijklmnop";
const ENV = { GEMINI_API_KEY: KEY };
const NOW = new Date("2026-03-01T10:00:00.000Z");

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
}

function modelsFetch(
  models: string[],
  status = 200,
): { fetch: FetchLike; calls: string[]; inits: Call[] } {
  const calls: string[] = [];
  const inits: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    inits.push({ url, init });
    return {
      ok: status === 200,
      status,
      text: async () =>
        status === 200
          ? JSON.stringify({
              models: models.map((name) => ({
                name: `models/${name}`,
                supportedGenerationMethods: ["generateContent"],
              })),
            })
          : JSON.stringify({ error: { message: "denegado" } }),
    };
  };
  return { fetch: fetchImpl, calls, inits };
}

beforeEach(() => {
  resetGeminiStatusCache();
});

describe("geminiStatus", () => {
  it("sin clave no consulta la red y lo explica sin alarmar", async () => {
    const { fetch, calls } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({ env: {}, fetchImpl: fetch, now: () => NOW });

    expect(calls).toHaveLength(0);
    expect(status.configured).toBe(false);
    expect(status.reachable).toBeNull();
    expect(status.message).toContain("GEMINI_API_KEY");
  });

  it("con clave y modelo disponible informa de conexión correcta", async () => {
    const { fetch, calls } = modelsFetch(["gemini-2.5-flash", "gemini-2.5-pro"]);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/models?pageSize=200");
    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.modelAvailable).toBe(true);
    expect(status.model).toBe("gemini-2.5-flash");
    expect(status.checkedAt).toBe(NOW.toISOString());
    expect(status.message).toContain("gemini-2.5-flash");
  });

  it("avisa si la cuenta no ofrece el modelo configurado y lista alternativas", async () => {
    const { fetch } = modelsFetch(["gemini-2.5-pro", "gemini-2.5-flash-lite"]);
    const status = await geminiStatus({
      env: { ...ENV, GEMINI_MODEL: "gemini-inesistente" },
      fetchImpl: fetch,
      now: () => NOW,
    });

    expect(status.reachable).toBe(true);
    expect(status.modelAvailable).toBe(false);
    expect(status.message).toContain("gemini-inesistente");
    expect(status.message).toContain("gemini-2.5-pro");
  });

  it("distingue credenciales rechazadas de red caída, sin filtrar la clave", async () => {
    const rejected = modelsFetch([], 403);
    const status = await geminiStatus({ env: ENV, fetchImpl: rejected.fetch, now: () => NOW });
    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(false);
    expect(status.message).toContain("401/403");
    expect(status.message).not.toContain(KEY);

    resetGeminiStatusCache();
    const offline: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const down = await geminiStatus({ env: ENV, fetchImpl: offline, now: () => NOW });
    expect(down.reachable).toBe(false);
    expect(down.message).toContain("No se pudo conectar");
    expect(down.message).not.toContain(KEY);
  });

  it("cachea el resultado y solo repite la llamada si se fuerza", async () => {
    const { fetch, calls } = modelsFetch(["gemini-2.5-flash"]);

    await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });
    const cached = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });
    expect(calls).toHaveLength(1);
    expect(cached.reachable).toBe(true);

    await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW, force: true });
    expect(calls).toHaveLength(2);
  });

  it("consulta el catálogo con GET y sin cuerpo, como exige la API oficial", async () => {
    // Regresión: la petición llevaba `body: ""` y la plataforma la rechazaba con
    // «Request with GET/HEAD method cannot have body», así que la comprobación
    // de salud nunca llegaba a Gemini.
    const { fetch, inits } = modelsFetch(["gemini-2.5-flash"]);
    await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });

    expect(inits).toHaveLength(1);
    const [{ url, init }] = inits;
    expect(init.method).toBe("GET");
    expect("body" in init).toBe(false);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200");
    expect(init.headers["x-goog-api-key"]).toBe(KEY);
    // La clave viaja en cabecera: no puede quedar escrita en la URL.
    expect(url).not.toContain(KEY);
  });

  it("construye una Request real válida (la misma que usa el servidor)", async () => {
    // La prueba anterior usa un doble; esta pasa la petición por el constructor
    // real, que es donde el cuerpo en un GET explota. Sin red de por medio.
    const { fetch, inits } = modelsFetch(["gemini-2.5-flash"]);
    await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });

    const [{ url, init }] = inits;
    expect(() => new Request(url, init as RequestInit)).not.toThrow();
    // Y deja constancia de que un GET con cuerpo sí sería rechazado: es el fallo
    // que se corrigió, no una precaución teórica.
    expect(() => new Request(url, { method: "GET", body: "" })).toThrow(/cannot have body/i);
  });

  it("informa de un error HTTP sin cuerpo útil sin filtrar la clave", async () => {
    const { fetch } = modelsFetch([], 500);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(false);
    expect(status.modelAvailable).toBeNull();
    expect(status.message).toContain("HTTP 500");
    expect(status.message).not.toContain(KEY);
  });

  it("no comprueba nada si se pide solo la configuración", async () => {
    const { fetch, calls } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW, probe: false });
    expect(calls).toHaveLength(0);
    expect(status.configured).toBe(true);
    expect(status.reachable).toBeNull();
    expect(status.message).toContain("No se ha comprobado");
  });
});

/**
 * DIAGNÓSTICO DEL PROVEEDOR
 * ========================
 *
 * Incidencia real (25/10/2026): en producción convivían la clave de Google y la
 * de Groq, el asistente seguía usando Gemini y la pantalla no daba ninguna pista
 * de por qué. El estado ahora publica **qué claves ve el servidor** (solo
 * booleanos) y si el proveedor está forzado, para que la pantalla pueda decir
 * exactamente qué falta.
 */
describe("diagnóstico del proveedor", () => {
  const GROQ_KEY = "gsk_TESTKEY0123456789abcdefghijklmnop";

  it("con solo la clave de Google usa Gemini y lo dice", async () => {
    const { fetch } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });

    expect(status.provider).toBe("gemini");
    expect(status.diagnostics).toEqual({ keys: { groq: false, gemini: true }, declared: null });
  });

  it("con las dos claves y sin AI_PROVIDER usa Groq", async () => {
    const { fetch } = modelsFetch(["openai/gpt-oss-120b"]);
    const status = await geminiStatus({
      env: { ...ENV, GROQ_API_KEY: GROQ_KEY },
      fetchImpl: fetch,
      now: () => NOW,
    });

    expect(status.provider).toBe("groq");
    expect(status.diagnostics.keys).toEqual({ groq: true, gemini: true });
    expect(status.diagnostics.declared).toBeNull();
  });

  it("AI_PROVIDER=gemini manda aunque exista la clave de Groq", async () => {
    const { fetch } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({
      env: { ...ENV, GROQ_API_KEY: GROQ_KEY, AI_PROVIDER: "gemini" },
      fetchImpl: fetch,
      now: () => NOW,
    });

    expect(status.provider).toBe("gemini");
    expect(status.diagnostics.declared).toBe("gemini");
  });

  it("nunca publica el valor de una clave", async () => {
    const { fetch } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW });
    expect(JSON.stringify(status)).not.toContain(KEY);
  });
});
