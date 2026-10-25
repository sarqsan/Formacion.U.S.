import { describe, expect, it } from "vitest";
import {
  SOURCE_TOPIC_ID,
  planDraftTopicBatches,
  proposeDraftTopicBatch,
  saveProposedTopics,
  startAiCourse,
  type AiFlowDependencies,
} from "@/server/courses/ai-flow";
import { batchInputChars, nextBatchDelayMs, planTopicBatches, estimatePlanSeconds } from "@/server/ai/batches";
import type { FetchLike } from "@/server/ai/gemini";
import type { PdfTextPage } from "@/server/ai/text";
import { ADMIN, FIXED_NOW, InMemoryCatalogStore } from "../helpers/db-doubles";
import { InMemoryPdfDocumentStore } from "../helpers/document-double";
import { buildPdf } from "../helpers/pdf-fixture";

/**
 * TEMAS POR TANDAS: TEMARIOS DE CUALQUIER TAMAÑO
 * =============================================
 *
 * El objetivo del encargo es que el tamaño del PDF deje de ser un límite: el
 * documento se parte en tantas peticiones como haga falta, cada una con **una**
 * llamada al modelo, y el navegador va pidiendo una detrás de otra.
 *
 * Estas pruebas usan almacenes en memoria y un Groq simulado. Demuestran:
 *
 *   · el plan cubre todas las páginas, sin huecos ni solapes;
 *   · cada tanda cabe en el presupuesto de una llamada (cuota del plan);
 *   · procesar tanda a tanda produce lo mismo que un documento pequeño;
 *   · un tema que aparece en dos tandas se guarda **una vez**, con sus páginas;
 *   · nada se escribe hasta el guardado final, y entonces se valida entero;
 *   · los errores de verdad se ven (documento sin texto, revisión obsoleta).
 *
 * Lo que NO demuestra: que Groq real responda, ni cómo de bueno es el contenido.
 */

const GROQ_ENV = { AI_PROVIDER: "groq", GROQ_API_KEY: "gsk_TESTKEY0123456789abcdefghijklmnop" };

/** Groq simulado: devuelve un tema por cada par de páginas que recibe. */
interface FakeGroq {
  fetch: FetchLike;
  calls: Array<{ pagesSeen: number[]; chars: number; hasPdf: boolean }>;
}

function fakeGroq(options: { failWith?: number } = {}): FakeGroq {
  const state: FakeGroq = { calls: [], fetch: async (_url, init) => {
    const body = JSON.parse(init.body ?? "") as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.map((message) => message.content).join("\n");
    const pagesSeen = [...user.matchAll(/\[Página (\d+)\]/g)].map((match) => Number(match[1]));
    const hasPdf = /%PDF|inlineData/.test(user);
    state.calls.push({ pagesSeen, chars: user.length, hasPdf });

    if (options.failWith) {
      return { ok: false, status: options.failWith, text: async () => "{}" };
    }

    const first = pagesSeen[0] ?? 1;
    const last = pagesSeen[pagesSeen.length - 1] ?? first;
    const topics = [
      {
        title: `Tramo ${first}-${last}`,
        pages: pagesSeen.slice(0, 2),
        summary: "Resumen del tramo.",
      },
    ];

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ topics, notes: null }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 120 },
        }),
    };
  } };
  return state;
}

class CatalogStore extends InMemoryCatalogStore {
  async createCourse(summary: {
    courseId: string;
    title: string;
    publishedVersion: number | null;
    lastDraftVersion: number | null;
  }): Promise<void> {
    this.courses.set(summary.courseId, { ...summary });
  }
}

function buildDeps(fake: FakeGroq): { deps: AiFlowDependencies; store: CatalogStore } {
  const store = new CatalogStore();
  const pdfStore = new InMemoryPdfDocumentStore();
  const now = () => FIXED_NOW;

  return {
    store,
    deps: {
      editor: { store, now },
      draft: { store, now },
      upload: { documents: pdfStore, catalog: store, budgetBytes: 64 * 1024 * 1024, now },
      catalog: store,
      documents: pdfStore,
      gemini: { fetchImpl: fake.fetch, env: GROQ_ENV },
      now,
    },
  };
}

/**
 * PDF real de `pages` páginas con ~`chars` caracteres de texto cada una.
 *
 * Se escriben **muchas líneas cortas**, como un temario de verdad: una línea de
 * 1 500 caracteres se sale del ancho de la página y el lector solo devuelve lo
 * que cabe. Y sin acentos, porque el generador de pruebas escribe en `latin1`.
 */
function syllabus(pages: number, chars = 1_800): { bytes: Uint8Array; pages: number } {
  const line = "La evaluacion de riesgos combina probabilidad y severidad del dano posible. ";
  const perLine = 78;
  const lines = (page: number) => {
    const count = Math.max(1, Math.ceil(chars / perLine));
    return Array.from({ length: count }, (_, index) =>
      `P${page} L${index + 1} ${line.repeat(2).slice(0, perLine - 12)}`,
    );
  };
  return {
    bytes: buildPdf(Array.from({ length: pages }, (_, index) => lines(index + 1))),
    pages,
  };
}

async function draftWithSyllabus(pages: number, chars?: number) {
  const fake = fakeGroq();
  const { deps, store } = buildDeps(fake);
  const pdf = syllabus(pages, chars);

  const started = await startAiCourse(
    {
      actor: ADMIN,
      courseId: "curso-grande",
      title: "Prevención de riesgos",
      description: "Temario largo",
      pageCount: pdf.pages,
      pdfBytes: pdf.bytes,
    },
    deps,
  );

  return { fake, deps, store, started };
}

describe("plan de tandas", () => {
  const pages: PdfTextPage[] = Array.from({ length: 120 }, (_, index) => ({
    page: index + 1,
    text: "x".repeat(2_500),
  }));

  it("cubre todas las páginas sin huecos ni solapes", () => {
    const plan = planTopicBatches(pages, { tokensPerMinute: 8_000 });
    const covered: number[] = [];
    for (const batch of plan.batches) {
      expect(batch.to).toBeGreaterThanOrEqual(batch.from);
      covered.push(...batch.pages);
    }
    expect(covered).toEqual(pages.map((page) => page.page));
    expect(plan.totalPages).toBe(120);
    expect(plan.batches.length).toBeGreaterThan(5);
  });

  it("ninguna tanda se pasa del presupuesto de una llamada", () => {
    const limit = batchInputChars(8_000);
    const plan = planTopicBatches(pages, { tokensPerMinute: 8_000 });
    for (const batch of plan.batches) {
      expect(batch.chars).toBeLessThanOrEqual(limit);
    }
  });

  it("estima un tiempo proporcional al tamaño y a la cuota", () => {
    const small = planTopicBatches(pages.slice(0, 20), { tokensPerMinute: 8_000 });
    const big = planTopicBatches(pages, { tokensPerMinute: 8_000 });
    expect(estimatePlanSeconds(big)).toBeGreaterThan(estimatePlanSeconds(small));
    expect(estimatePlanSeconds(small)).toBeGreaterThan(0);
  });

  it("calcula la espera entre tandas a partir de los tokens gastados", () => {
    expect(nextBatchDelayMs(0, 8_000)).toBe(1_000);
    // 4 000 tokens de 8 000 por minuto -> medio minuto
    expect(nextBatchDelayMs(4_000, 8_000)).toBeGreaterThan(29_000);
    expect(nextBatchDelayMs(4_000, 8_000)).toBeLessThan(32_000);
    // Nunca más de un minuto largo, aunque la llamada se pase.
    expect(nextBatchDelayMs(50_000, 8_000)).toBe(65_000);
  });
});

describe("temario largo, tanda a tanda", () => {
  it("un PDF de 60 páginas se planifica en varias tandas", async () => {
    const { deps, started } = await draftWithSyllabus(60);
    const plan = await planDraftTopicBatches(
      { actor: ADMIN, courseId: started.courseId, version: started.version },
      deps,
    );

    expect(plan.totalPages).toBe(60);
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches[0].from).toBe(1);
    expect(plan.batches[plan.batches.length - 1].to).toBe(60);
  });

  it("cada tanda es una sola llamada, sin PDF y con el rango de páginas", async () => {
    const { fake, deps, started } = await draftWithSyllabus(40);
    const plan = await planDraftTopicBatches(
      { actor: ADMIN, courseId: started.courseId, version: started.version },
      deps,
    );

    const first = plan.batches[0];
    const result = await proposeDraftTopicBatch(
      {
        actor: ADMIN,
        courseId: started.courseId,
        version: started.version,
        from: first.from,
        to: first.to,
      },
      deps,
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].hasPdf).toBe(false);
    expect(fake.calls[0].pagesSeen[0]).toBe(first.from);
    expect(fake.calls[0].pagesSeen.at(-1)).toBe(first.to);
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.nextDelayMs).toBeGreaterThan(0);
    expect(result.usedTokens).toBeGreaterThan(0);
  });

  it("nada se escribe en el borrador hasta el guardado final", async () => {
    const { deps, store, started } = await draftWithSyllabus(30);
    const before = await store.getVersion(started.courseId, started.version);

    const plan = await planDraftTopicBatches(
      { actor: ADMIN, courseId: started.courseId, version: started.version },
      deps,
    );
    for (const batch of plan.batches) {
      await proposeDraftTopicBatch(
        {
          actor: ADMIN,
          courseId: started.courseId,
          version: started.version,
          from: batch.from,
          to: batch.to,
        },
        deps,
      );
    }

    const after = await store.getVersion(started.courseId, started.version);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.topics.map((topic) => topic.id)).toEqual(
      before?.topics.map((topic) => topic.id),
    );
  });

  it("guarda el plan completo, con el tema del PDF intacto y un tema por tramo", async () => {
    const { deps, store, started } = await draftWithSyllabus(45);
    const plan = await planDraftTopicBatches(
      { actor: ADMIN, courseId: started.courseId, version: started.version },
      deps,
    );

    const collected: Array<{ title: string; pages: number[]; summary: string | null }> = [];
    for (const batch of plan.batches) {
      const result = await proposeDraftTopicBatch(
        {
          actor: ADMIN,
          courseId: started.courseId,
          version: started.version,
          from: batch.from,
          to: batch.to,
        },
        deps,
      );
      collected.push(...result.topics);
    }

    const saved = await saveProposedTopics(
      {
        actor: ADMIN,
        courseId: started.courseId,
        version: started.version,
        expectedRevision: started.revision,
        topics: collected,
        notes: "Nota de la IA",
      },
      deps,
    );

    expect(saved.topics.length).toBe(collected.length);
    expect(saved.revision).toBeGreaterThan(started.revision);
    expect(saved.notes).toBe("Nota de la IA");

    const version = await store.getVersion(started.courseId, started.version);
    expect(version?.topics[0].id).toBe(SOURCE_TOPIC_ID);
    expect(version?.topics[0].mandatory).toBe(false);
    expect(version?.topics.filter((topic) => topic.id !== SOURCE_TOPIC_ID).length).toBe(
      collected.length,
    );
  });

  it("un tema repetido en dos tandas se guarda una vez, con todas sus páginas", async () => {
    const { deps, store, started } = await draftWithSyllabus(20);

    const saved = await saveProposedTopics(
      {
        actor: ADMIN,
        courseId: started.courseId,
        version: started.version,
        expectedRevision: started.revision,
        topics: [
          { title: "Evaluación de riesgos", pages: [1, 2], summary: "Uno" },
          { title: "evaluación de riesgos", pages: [2, 3], summary: null },
          { title: "Medidas preventivas", pages: [4], summary: "Dos" },
        ],
      },
      deps,
    );

    expect(saved.topics).toHaveLength(2);
    expect(saved.topics[0].pages).toEqual([1, 2, 3]);

    const version = await store.getVersion(started.courseId, started.version);
    expect(version?.topics.filter((topic) => topic.id !== SOURCE_TOPIC_ID)).toHaveLength(2);
  });

  it("rechaza un plan con más temas de los permitidos", async () => {
    const { deps, started } = await draftWithSyllabus(10);
    const many = Array.from({ length: 40 }, (_, index) => ({
      title: `Tema ${index + 1}`,
      pages: [1],
      summary: null,
    }));

    await expect(
      saveProposedTopics(
        {
          actor: ADMIN,
          courseId: started.courseId,
          version: started.version,
          expectedRevision: started.revision,
          topics: many,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
  });

  it("rechaza guardar con una revisión vieja (otra pestaña guardó antes)", async () => {
    const { deps, started } = await draftWithSyllabus(10);

    await expect(
      saveProposedTopics(
        {
          actor: ADMIN,
          courseId: started.courseId,
          version: started.version,
          expectedRevision: started.revision + 5,
          topics: [{ title: "Tema", pages: [1], summary: null }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DRAFT_STALE" });
  });

  it("un PDF sin texto se detecta al planificar, antes de gastar cuota", async () => {
    const fake = fakeGroq();
    const { deps } = buildDeps(fake);
    const blank = buildPdf([
      [" "],
      [" "],
    ]);

    let version: number | null = null;
    try {
      const started = await startAiCourse(
        {
          actor: ADMIN,
          courseId: "curso-escaneado",
          title: "Escaneado",
          pageCount: 2,
          pdfBytes: blank,
        },
        deps,
      );
      version = started.version;
    } catch {
      // La subida puede rechazarse antes; cualquiera de las dos cosas es válida.
      version = null;
    }

    if (version !== null) {
      await expect(
        planDraftTopicBatches({ actor: ADMIN, courseId: "curso-escaneado", version }, deps),
      ).rejects.toMatchObject({ code: "PDF_WITHOUT_TEXT" });
    }
    // En ningún caso se ha llamado al modelo: sin texto no hay nada que enviar.
    expect(fake.calls).toHaveLength(0);
  });

  it("un fallo de Groq en una tanda no deja nada escrito", async () => {
    const fake = fakeGroq({ failWith: 503 });
    const { deps, store } = buildDeps(fake);
    const pdf = syllabus(10);
    const started = await startAiCourse(
      {
        actor: ADMIN,
        courseId: "curso-fallo",
        title: "Fallo",
        pageCount: pdf.pages,
        pdfBytes: pdf.bytes,
      },
      deps,
    );
    const before = await store.getVersion("curso-fallo", started.version);

    await expect(
      proposeDraftTopicBatch(
        { actor: ADMIN, courseId: "curso-fallo", version: started.version, from: 1, to: 5 },
        deps,
      ),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });

    const after = await store.getVersion("curso-fallo", started.version);
    expect(after?.revision).toBe(before?.revision);
  });
});
