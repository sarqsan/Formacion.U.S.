import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import {
  SOURCE_TOPIC_ID,
  generateFinalExam,
  generateTopicQuiz,
  generateTopicScreens,
  proposeDraftTopics,
  startAiCourse,
  type AiFlowDependencies,
} from "@/server/courses/ai-flow";
import { publishCourseVersion } from "@/server/courses/catalog";
import type { FetchLike } from "@/server/ai/gemini";
import { definitionFromDocuments } from "@/server/courses/definition";
import { ADMIN, FIXED_NOW, InMemoryCatalogStore, LEARNER } from "../helpers/db-doubles";
import { InMemoryPdfDocumentStore } from "../helpers/document-double";

/**
 * «CREAR CURSO CON IA» DE PUNTA A PUNTA (con almacenes en memoria)
 * ===============================================================
 *
 * Recorre el camino real del encargo sin salir a Internet: sube un PDF, deja
 * que un Gemini simulado proponga temas, genere pantallas, un cuestionario y el
 * examen final, y comprueba qué queda escrito.
 *
 * Lo que sí demuestra:
 *
 *   · el flujo escribe en el borrador de verdad (temas, documento, pantallas,
 *     preguntas) y **no** publica;
 *   · las respuestas correctas y sus explicaciones van a `answerKeys` y no al
 *     documento de versión;
 *   · regenerar reemplaza el destino y no duplica;
 *   · un fallo de Gemini deja el borrador intacto (misma revisión, mismo
 *     contenido);
 *   · una revisión obsoleta se rechaza con `DRAFT_STALE`.
 *
 * Lo que NO demuestra: que Gemini real devuelva esto, ni que Firestore escriba
 * igual. El primero exige `GEMINI_API_KEY`; el segundo, el emulador (bloqueado
 * en este entorno).
 */

function fakePdf(): Uint8Array {
  const body = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n";
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) bytes[index] = body.charCodeAt(index);
  return bytes;
}

const TOPICS_JSON = {
  topics: [
    { title: "Marco legal", pages: [1, 2], summary: "Normas que aplican." },
    { title: "Evaluación de riesgos", pages: [3, 4], summary: "Cómo se evalúa el riesgo." },
  ],
  notes: "La portada no se ha asignado a ningún tema.",
};

const SCREENS_JSON = {
  screens: [
    {
      title: "Qué dice la norma",
      paragraphs: ["La norma obliga a evaluar los riesgos de cada puesto."],
      bullets: ["Obligación del empresario"],
      pages: [1],
    },
    {
      title: "Paso a paso",
      paragraphs: ["Se identifican los peligros y se valora la exposición."],
      bullets: ["Identificar", "Valorar"],
      pages: [3],
    },
  ],
};

const QUIZ_JSON = {
  questions: [
    {
      prompt: "¿Qué se identifica primero al evaluar un riesgo?",
      type: "single_choice",
      options: [
        { text: "Los peligros del puesto", correct: true },
        { text: "El presupuesto anual", correct: false },
        { text: "La plantilla completa", correct: false },
      ],
      explanation: "El documento indica que se empieza identificando los peligros del puesto.",
    },
    {
      prompt: "¿Qué dos cosas se combinan para valorar un riesgo?",
      type: "multi_choice",
      options: [
        { text: "Probabilidad", correct: true },
        { text: "Severidad", correct: true },
        { text: "Antigüedad", correct: false },
      ],
      explanation: "La valoración combina probabilidad y severidad, según el tema.",
    },
  ],
};

interface Fake {
  fetch: FetchLike;
  calls: Array<{ mode: string; prompt: string; hasPdf: boolean }>;
  failNext: boolean;
}

function fakeGemini(): Fake {
  const state: Fake = {
    calls: [],
    failNext: false,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body) as {
        contents: Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }>;
      };
      const parts = body.contents[0].parts;
      const prompt = (parts[0]?.text ?? "") + "\n" + (parts[1]?.text ?? "");
      const hasPdf = parts.some((part) => Boolean(part.inlineData));
      const mode = prompt.includes("divide el documento en temas")
        ? "topics"
        : prompt.includes("secuencia de pantallas")
          ? "screens"
          : "quiz";

      state.calls.push({ mode, prompt, hasPdf });

      if (state.failNext) {
        state.failNext = false;
        return { ok: false, status: 503, text: async () => "{}" };
      }

      const payload = mode === "topics" ? TOPICS_JSON : mode === "screens" ? SCREENS_JSON : QUIZ_JSON;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [
              { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(payload) }] } },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
          }),
      };
    },
  };
  return state;
}

class CombinedStore extends InMemoryCatalogStore {
  async createCourse(summary: {
    courseId: string;
    title: string;
    publishedVersion: number | null;
    lastDraftVersion: number | null;
  }): Promise<void> {
    if (this.courses.has(summary.courseId)) {
      throw new DomainError("COURSE_ALREADY_EXISTS", "Ya existe ese curso.", 409);
    }
    this.courses.set(summary.courseId, { ...summary });
  }
}

function buildDeps(fake: Fake): {
  deps: AiFlowDependencies;
  store: CombinedStore;
  pdfStore: InMemoryPdfDocumentStore;
} {
  const store = new CombinedStore();
  const pdfStore = new InMemoryPdfDocumentStore();
  const now = () => FIXED_NOW;

  return {
    store,
    pdfStore,
    deps: {
      editor: { store, now },
      draft: { store, now },
      upload: { documents: pdfStore, catalog: store, budgetBytes: 64 * 1024 * 1024, now },
      catalog: store,
      documents: pdfStore,
      gemini: { fetchImpl: fake.fetch, env: { GEMINI_API_KEY: "AIzaTEST_0123456789abcdef" } },
      now,
    },
  };
}

afterEach(() => {
  // Nada global que limpiar: cada prueba construye sus almacenes.
});

describe("startAiCourse", () => {
  it("crea el curso, el borrador, el tema del PDF y sube el documento", async () => {
    const fake = fakeGemini();
    const { deps, store, pdfStore } = buildDeps(fake);

    const started = await startAiCourse(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        title: "Curso con IA",
        description: "Prueba",
        pageCount: 4,
        pdfBytes: fakePdf(),
      },
      deps,
    );

    expect(started.courseId).toBe("curso-ia");
    expect(started.version).toBe(1);
    expect(started.revision).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(0);

    const course = await store.getCourse("curso-ia");
    expect(course?.lastDraftVersion).toBe(1);
    expect(course?.publishedVersion).toBeNull();

    const version = await store.getVersion("curso-ia", 1);
    expect(version?.status).toBe("draft");
    expect(version?.topics).toHaveLength(1);
    expect(version?.topics[0].id).toBe(SOURCE_TOPIC_ID);
    expect(version?.topics[0].mandatory).toBe(false);
    expect(version?.topics[0].documents).toHaveLength(1);
    expect(version?.topics[0].documents[0].id).toBe(started.documentId);

    const meta = await pdfStore.getMeta(started.documentId);
    expect(meta?.state).toBe("active");
    expect(meta?.courseId).toBe("curso-ia");
  });

  it("no deja crear dos cursos con el mismo identificador", async () => {
    const fake = fakeGemini();
    const { deps } = buildDeps(fake);
    const input = {
      actor: ADMIN,
      courseId: "curso-ia",
      title: "Curso con IA",
      pageCount: 4,
      pdfBytes: fakePdf(),
    };

    await startAiCourse(input, deps);
    await expect(startAiCourse(input, deps)).rejects.toMatchObject({
      code: "COURSE_ALREADY_EXISTS",
    });
  });

  it("rechaza un PDF mayor de 4 MB sin crear nada (límite de la petición en el despliegue)", async () => {
    const fake = fakeGemini();
    const { deps, store } = buildDeps(fake);

    // Vercel corta las peticiones a funciones en 4,5 MB con un 413 que no llega
    // al código: el asistente se queda por debajo (4 MiB) y lo dice antes.
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    const header = "%PDF-1.7\n";
    for (let index = 0; index < header.length; index += 1) big[index] = header.charCodeAt(index);

    await expect(
      startAiCourse(
        {
          actor: ADMIN,
          courseId: "curso-grande",
          title: "Curso grande",
          pageCount: 200,
          pdfBytes: big,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "PDF_TOO_LARGE_FOR_WIZARD", status: 413 });

    expect(await store.getCourse("curso-grande")).toBeNull();
  });

  it("rechaza un fichero que no es PDF sin crear nada", async () => {
    const fake = fakeGemini();
    const { deps, store } = buildDeps(fake);

    await expect(
      startAiCourse(
        {
          actor: ADMIN,
          courseId: "curso-falso",
          title: "Falso",
          pageCount: 2,
          pdfBytes: new Uint8Array([1, 2, 3, 4, 5]),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(DomainError);

    expect(await store.getCourse("curso-falso")).toBeNull();
  });
});

describe("recorrido completo", () => {
  it("temas → pantallas → cuestionario → examen final, sin publicar", async () => {
    const fake = fakeGemini();
    const { deps, store } = buildDeps(fake);

    const started = await startAiCourse(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        title: "Prevención de riesgos",
        description: "Curso de prueba",
        pageCount: 4,
        pdfBytes: fakePdf(),
      },
      deps,
    );

    // ---- Paso 2: temas ----
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );

    expect(proposal.topics.map((topic) => topic.id)).toEqual([
      "marco-legal",
      "evaluacion-de-riesgos",
    ]);
    expect(proposal.topics[0].pages).toEqual([1, 2]);
    expect(proposal.notes).toContain("portada");
    expect(fake.calls[0].mode).toBe("topics");
    expect(fake.calls[0].hasPdf).toBe(true);

    let version = await store.getVersion("curso-ia", 1);
    expect(version?.topics.map((topic) => topic.id)).toEqual([
      SOURCE_TOPIC_ID,
      "marco-legal",
      "evaluacion-de-riesgos",
    ]);
    // El tema del PDF conserva su documento al reescribir la estructura.
    expect(version?.topics[0].documents).toHaveLength(1);

    // ---- Paso 3: pantallas de un tema ----
    const screens = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: proposal.revision,
        topicId: "marco-legal",
      },
      deps,
    );

    expect(screens.screens).toHaveLength(2);
    expect(screens.screens[0].id).toBe("pantalla-1");
    expect(screens.screens[0].pages).toEqual([1]);

    version = await store.getVersion("curso-ia", 1);
    const legal = version?.topics.find((topic) => topic.id === "marco-legal");
    expect(legal?.screens).toHaveLength(2);
    expect(legal?.screens?.[1].bullets).toEqual(["Identificar", "Valorar"]);

    // ---- Paso 4: cuestionario del tema ----
    const quiz = await generateTopicQuiz(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: screens.revision,
        topicId: "marco-legal",
        questionCount: 5,
        allowMultiple: true,
      },
      deps,
    );

    expect(quiz.questions).toHaveLength(2);
    expect(quiz.questions[0].correctOptionIds).toEqual(["a"]);

    version = await store.getVersion("curso-ia", 1);
    const keys = await store.getAnswerKeys("curso-ia", 1);

    // Las preguntas están en el contenido; la clave y la explicación, no.
    expect(version?.topics.find((topic) => topic.id === "marco-legal")?.quiz).toHaveLength(2);
    const serialized = JSON.stringify(version);
    expect(serialized).not.toContain("correctOptionIds");
    expect(serialized).not.toContain("explanation");
    expect(keys?.quizByTopic["marco-legal"]).toEqual([
      {
        id: "q1",
        correctOptionIds: ["a"],
        explanation: expect.stringContaining("peligros"),
      },
      { id: "q2", correctOptionIds: ["a", "b"], explanation: expect.stringContaining("probabilidad") },
    ]);

    // ---- Paso 4: examen final (necesita pantallas de algún tema) ----
    const finalExam = await generateFinalExam(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: quiz.revision,
        questionCount: 10,
        allowMultiple: true,
      },
      deps,
    );
    expect(finalExam.questions).toHaveLength(2);
    expect(finalExam.topicId).toBeNull();

    // ---- Nada se ha publicado ----
    const course = await store.getCourse("curso-ia");
    expect(course?.publishedVersion).toBeNull();
    expect((await store.listVersions("curso-ia")).every((item) => item.status === "draft")).toBe(true);
  });

  it("regenerar un tema reemplaza sus pantallas y no toca los demás temas", async () => {
    const fake = fakeGemini();
    const { deps, store } = buildDeps(fake);

    const started = await startAiCourse(
      { actor: ADMIN, courseId: "curso-ia", title: "Curso", pageCount: 4, pdfBytes: fakePdf() },
      deps,
    );
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );
    const first = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: proposal.revision,
        topicId: "marco-legal",
      },
      deps,
    );
    const other = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: first.revision,
        topicId: "evaluacion-de-riesgos",
      },
      deps,
    );
    // Corrección manual del segundo tema: no la puede borrar una regeneración
    // del primero.
    const keysBefore = await store.getAnswerKeys("curso-ia", 1);

    const again = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: other.revision,
        topicId: "marco-legal",
      },
      deps,
    );

    const version = await store.getVersion("curso-ia", 1);
    expect(version?.topics.find((topic) => topic.id === "marco-legal")?.screens).toHaveLength(2);
    expect(version?.topics.find((topic) => topic.id === "evaluacion-de-riesgos")?.screens).toHaveLength(2);
    expect(again.revision).toBeGreaterThan(other.revision);
    expect(await store.getAnswerKeys("curso-ia", 1)).toEqual(keysBefore);
  });

  it("si Gemini falla, el borrador queda como estaba y se puede reintentar", async () => {
    const fake = fakeGemini();
    const { deps, store } = buildDeps(fake);

    const started = await startAiCourse(
      { actor: ADMIN, courseId: "curso-ia", title: "Curso", pageCount: 4, pdfBytes: fakePdf() },
      deps,
    );
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );

    const before = await store.getVersion("curso-ia", 1);
    fake.failNext = true;

    const error = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: proposal.revision,
        topicId: "marco-legal",
      },
      deps,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("AI_UNAVAILABLE");
    expect(await store.getVersion("curso-ia", 1)).toEqual(before);

    // Reintento con la misma revisión: no duplica nada.
    const retry = await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: proposal.revision,
        topicId: "marco-legal",
      },
      deps,
    );
    const version = await store.getVersion("curso-ia", 1);
    expect(version?.topics.find((topic) => topic.id === "marco-legal")?.screens).toHaveLength(2);
    expect(retry.revision).toBe(proposal.revision + 1);
  });

  it("rechaza una revisión obsoleta en vez de pisar correcciones", async () => {
    const fake = fakeGemini();
    const { deps } = buildDeps(fake);

    const started = await startAiCourse(
      { actor: ADMIN, courseId: "curso-ia", title: "Curso", pageCount: 4, pdfBytes: fakePdf() },
      deps,
    );
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );

    await generateTopicScreens(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: proposal.revision,
        topicId: "marco-legal",
      },
      deps,
    );

    await expect(
      generateTopicScreens(
        {
          actor: ADMIN,
          courseId: "curso-ia",
          version: 1,
          expectedRevision: proposal.revision,
          topicId: "marco-legal",
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DRAFT_STALE" });
  });

  it("no genera cuestionario de un tema sin pantallas y no genera examen sin material", async () => {
    const fake = fakeGemini();
    const { deps } = buildDeps(fake);

    const started = await startAiCourse(
      { actor: ADMIN, courseId: "curso-ia", title: "Curso", pageCount: 4, pdfBytes: fakePdf() },
      deps,
    );
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );

    await expect(
      generateTopicQuiz(
        {
          actor: ADMIN,
          courseId: "curso-ia",
          version: 1,
          expectedRevision: proposal.revision,
          topicId: "marco-legal",
          questionCount: 5,
          allowMultiple: false,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "SCREENS_REQUIRED" });

    await expect(
      generateFinalExam(
        {
          actor: ADMIN,
          courseId: "curso-ia",
          version: 1,
          expectedRevision: proposal.revision,
          questionCount: 10,
          allowMultiple: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "SCREENS_REQUIRED" });
  });

  it("el resultado se publica con el flujo de siempre y el alumnado ve las pantallas", async () => {
    const fake = fakeGemini();
    const { deps, store, pdfStore } = buildDeps(fake);

    const started = await startAiCourse(
      { actor: ADMIN, courseId: "curso-ia", title: "Curso", pageCount: 4, pdfBytes: fakePdf() },
      deps,
    );
    const proposal = await proposeDraftTopics(
      { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: started.revision },
      deps,
    );

    let revision = proposal.revision;
    for (const topicId of ["marco-legal", "evaluacion-de-riesgos"]) {
      const screens = await generateTopicScreens(
        { actor: ADMIN, courseId: "curso-ia", version: 1, expectedRevision: revision, topicId },
        deps,
      );
      revision = screens.revision;
      const quiz = await generateTopicQuiz(
        {
          actor: ADMIN,
          courseId: "curso-ia",
          version: 1,
          expectedRevision: revision,
          topicId,
          questionCount: 5,
          allowMultiple: true,
        },
        deps,
      );
      revision = quiz.revision;
    }
    const finalExam = await generateFinalExam(
      {
        actor: ADMIN,
        courseId: "curso-ia",
        version: 1,
        expectedRevision: revision,
        questionCount: 5,
        allowMultiple: true,
      },
      deps,
    );
    revision = finalExam.revision;
    expect(revision).toBeGreaterThan(0);

    // El tema del PDF no tiene cuestionario: si fuera obligatorio, bloquearía
    // el examen final para siempre. Se publica como opcional.
    const published = await publishCourseVersion(
      { actor: ADMIN, courseId: "curso-ia", version: 1 },
      { store, documents: pdfStore },
    );
    expect(published.version).toBe(1);

    const version = await store.getVersion("curso-ia", 1);
    const keys = await store.getAnswerKeys("curso-ia", 1);
    const definition = definitionFromDocuments(version!, keys);
    const legal = definition.topics.find((topic) => topic.id === "marco-legal");
    expect(legal?.screens).toHaveLength(2);
    expect(legal?.quiz[0].correctOptionIds).toEqual(["a"]);
    expect(legal?.quiz[0].explanation).toContain("peligros");

    // El contenido público no lleva claves ni explicaciones.
    const publicVersion = JSON.stringify(version);
    expect(publicVersion).not.toContain("correctOptionIds");
    expect(publicVersion).not.toContain("explanation");

    // Y el alumnado no es quien decide: sin matrícula no hay lectura.
    expect(LEARNER.role).toBe("learner");
  });
});
