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

function modelsFetch(
  models: string[],
  status = 200,
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
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
  return { fetch: fetchImpl, calls };
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

  it("no comprueba nada si se pide solo la configuración", async () => {
    const { fetch, calls } = modelsFetch(["gemini-2.5-flash"]);
    const status = await geminiStatus({ env: ENV, fetchImpl: fetch, now: () => NOW, probe: false });
    expect(calls).toHaveLength(0);
    expect(status.configured).toBe(true);
    expect(status.reachable).toBeNull();
    expect(status.message).toContain("No se ha comprobado");
  });
});
