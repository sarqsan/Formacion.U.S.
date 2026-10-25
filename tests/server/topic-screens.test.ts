import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import type { StoredProgress } from "@/server/learning/store";
import { toAnswerKeys, toPublicVersion, type CourseVersionDocument } from "@/server/courses/catalog";
import {
  courseViewForLearner,
  readTopicScreen,
  screensReadingView,
  type LearnerDependencies,
} from "@/server/portal/learner";
import { FIXED_NOW, InMemoryCatalogStore, InMemoryLearningStore } from "../helpers/db-doubles";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * PANTALLAS DE ESTUDIO EN EL PORTAL DEL ALUMNO
 * ============================================
 *
 * El contenido generado con IA se estudia **como el resto del temario**: pantalla
 * a pantalla, en orden, con el progreso guardado en el servidor. Esta batería
 * fija las cuatro reglas que no pueden quedar al criterio del navegador:
 *
 *   1. no se puede saltar a una pantalla que no toca (409);
 *   2. abrir no es leer: el progreso solo avanza con la acción explícita;
 *   3. al llegar a la última, el tema queda estudiado y el cuestionario se abre;
 *   4. un administrador puede revisar, pero su lectura no se guarda.
 */

const LEARNER: Actor = { uid: "alumno-1", role: "learner", status: "active" };
const ADMIN: Actor = { uid: "admin-1", role: "admin", status: "active" };
const COURSE = "curso-pantallas";

function publishedVersion(): CourseVersionDocument {
  const definition = {
    courseId: COURSE,
    version: 1,
    title: "Curso con pantallas",
    description: "Prueba",
    topics: [
      {
        id: "tema-uno",
        title: "Tema uno",
        order: 1,
        mandatory: true,
        documents: [],
        quiz: [
          {
            id: "q1",
            type: "single_choice" as const,
            optionIds: ["a", "b"],
            correctOptionIds: ["a"],
            prompt: "¿Cuál es la correcta?",
            optionLabels: { a: "Sí", b: "No" },
            explanation: "La opción a es la correcta según el tema.",
          },
        ],
        screens: [
          {
            id: "pantalla-1",
            title: "Primera",
            paragraphs: ["Primera pantalla del tema."],
            bullets: ["Uno"],
            pages: [1],
          },
          {
            id: "pantalla-2",
            title: "Segunda",
            paragraphs: ["Segunda pantalla del tema."],
            bullets: [],
            pages: [2],
          },
          {
            id: "pantalla-3",
            title: "Tercera",
            paragraphs: ["Tercera pantalla del tema."],
            bullets: [],
            pages: [3],
          },
        ],
      },
    ],
    finalExam: [],
  };

  const version = toPublicVersion(definition, {
    createdAt: FIXED_NOW.toISOString(),
    createdBy: "admin-1",
    status: "published",
  });
  version.revision = 1;
  return version;
}

async function setup(actor: Actor = LEARNER) {
  const catalog = new InMemoryCatalogStore();
  const learning = new InMemoryLearningStore();
  const enrollments = new InMemoryEnrollmentStore();
  const version = publishedVersion();
  const answerKeys = toAnswerKeys(
    {
      courseId: COURSE,
      version: 1,
      title: "Curso con pantallas",
      description: "Prueba",
      topics: [
        {
          id: "tema-uno",
          title: "Tema uno",
          order: 1,
          mandatory: true,
          documents: [],
          quiz: [
            {
              id: "q1",
              type: "single_choice",
              optionIds: ["a", "b"],
              correctOptionIds: ["a"],
              prompt: "¿Cuál es la correcta?",
              optionLabels: { a: "Sí", b: "No" },
              explanation: "La opción a es la correcta según el tema.",
            },
          ],
          screens: version.topics[0].screens,
        },
      ],
      finalExam: [],
    },
    { createdAt: FIXED_NOW.toISOString() },
  );

  catalog.courses.set(COURSE, {
    courseId: COURSE,
    title: "Curso con pantallas",
    publishedVersion: 1,
    lastDraftVersion: null,
  });
  catalog.versions.set(`${COURSE}@1`, version);
  catalog.keys.set(`${COURSE}@1`, answerKeys);
  catalog.documents = version.topics.flatMap((topic) => topic.documents);

  await enrollments.upsert({
    uid: actor.uid,
    courseId: COURSE,
    status: "active",
    version: 1,
    enrolledAt: FIXED_NOW.toISOString(),
    enrolledBy: "admin-1",
    updatedAt: FIXED_NOW.toISOString(),
  });

  const deps: LearnerDependencies = {
    catalog,
    enrollments,
    learning,
    now: () => FIXED_NOW,
  };

  return { deps, catalog, learning };
}

function screensProgress(learning: InMemoryLearningStore): StoredProgress["documents"][string] | null {
  const stored = [...learning.progress.values()][0];
  return stored?.documents["screens_tema-uno"] ?? null;
}

describe("screensReadingView", () => {
  it("abre la primera pantalla y no avanza el progreso al abrirla", async () => {
    const { deps, learning } = await setup();
    const view = await screensReadingView(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno" });

    expect(view.kind).toBe("screens");
    expect(view.screen.id).toBe("pantalla-1");
    expect(view.totalScreens).toBe(3);
    expect(view.lastViewed).toBe(0);
    expect(view.finished).toBe(false);
    expect(learning.progress.size).toBe(0);
  });

  it("no deja saltar a una pantalla posterior (se queda en la permitida)", async () => {
    const { deps } = await setup();
    const view = await screensReadingView(deps, LEARNER, {
      courseId: COURSE,
      topicId: "tema-uno",
      screen: 3,
    });
    expect(view.screenNumber).toBe(1);
  });

  it("niega el acceso a quien no está matriculado", async () => {
    const { deps } = await setup({ uid: "otro", role: "learner", status: "active" });
    await expect(
      screensReadingView(deps, { uid: "sin-matricula", role: "learner", status: "active" }, {
        courseId: COURSE,
        topicId: "tema-uno",
      }),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("dice claramente que un tema no tiene pantallas", async () => {
    const { deps, catalog } = await setup();
    const version = catalog.versions.get(`${COURSE}@1`)!;
    version.topics.push({
      id: "tema-dos",
      title: "Tema sin pantallas",
      order: 2,
      mandatory: false,
      documents: [{ id: "doc-x", title: "PDF", pageCount: 2 }],
      quiz: [],
    });

    await expect(
      screensReadingView(deps, LEARNER, { courseId: COURSE, topicId: "tema-dos" }),
    ).rejects.toMatchObject({ code: "TOPIC_SCREENS_EMPTY" });
  });
});

describe("readTopicScreen", () => {
  it("registra en orden y completa el tema al llegar a la última", async () => {
    const { deps, learning } = await setup();

    const first = await readTopicScreen(deps, LEARNER, {
      courseId: COURSE,
      topicId: "tema-uno",
      screen: 1,
    });
    expect(first.nextScreen).toBe(2);
    expect(first.finished).toBe(false);
    expect(screensProgress(learning)?.lastPageViewed).toBe(1);

    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 2 });
    const last = await readTopicScreen(deps, LEARNER, {
      courseId: COURSE,
      topicId: "tema-uno",
      screen: 3,
    });

    expect(last.finished).toBe(true);
    const stored = screensProgress(learning);
    expect(stored?.totalPages).toBe(3);
    expect(stored?.lastPageViewed).toBe(3);
    expect(stored?.completedAt).toBe(FIXED_NOW.toISOString());
  });

  it("rechaza una pantalla fuera de orden en lugar de guardarla", async () => {
    const { deps, learning } = await setup();
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 1 });

    await expect(
      readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 3 }),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_ORDER" });

    expect(screensProgress(learning)?.lastPageViewed).toBe(1);
  });

  it("volver a leer una pantalla ya vista no retrocede el progreso", async () => {
    const { deps, learning } = await setup();
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 1 });
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 2 });
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 1 });

    expect(screensProgress(learning)?.lastPageViewed).toBe(2);
  });

  it("el administrador puede revisar, pero no escribe progreso", async () => {
    const { deps, learning } = await setup();
    const result = await readTopicScreen(deps, ADMIN, {
      courseId: COURSE,
      topicId: "tema-uno",
      screen: 1,
    });
    expect(result.nextScreen).toBe(2);
    expect(learning.progress.size).toBe(0);
  });
});

describe("vista del curso y desbloqueo del cuestionario", () => {
  it("con pantallas, el cuestionario se abre al terminar el tema (no antes)", async () => {
    const { deps } = await setup();

    let view = await courseViewForLearner(deps, LEARNER, COURSE);
    let topic = view.topics[0];
    expect(topic.screens).toEqual({ available: true, total: 3, lastViewed: 0, completed: false });
    expect(topic.readComplete).toBe(false);
    expect(topic.quizAvailable).toBe(false);

    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 1 });
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 2 });

    view = await courseViewForLearner(deps, LEARNER, COURSE);
    topic = view.topics[0];
    expect(topic.screens.lastViewed).toBe(2);
    expect(topic.readComplete).toBe(false);

    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 3 });

    view = await courseViewForLearner(deps, LEARNER, COURSE);
    topic = view.topics[0];
    expect(topic.screens.completed).toBe(true);
    expect(topic.readComplete).toBe(true);
    expect(topic.quizAvailable).toBe(true);
  });

  it("el progreso de las pantallas no se mezcla con el de ningún documento", async () => {
    const { deps, learning } = await setup();
    await readTopicScreen(deps, LEARNER, { courseId: COURSE, topicId: "tema-uno", screen: 1 });

    const stored = [...learning.progress.values()][0];
    expect(Object.keys(stored.documents)).toEqual(["screens_tema-uno"]);
  });

  it("un tema con documentos y pantallas se abre por cualquiera de los dos caminos", async () => {
    const { deps, catalog, learning } = await setup();
    const version = catalog.versions.get(`${COURSE}@1`)!;
    version.topics[0].documents = [{ id: "doc-1", title: "PDF", pageCount: 2 }];

    // Leyendo el documento entero, el tema queda estudiado aunque las pantallas
    // estén a medias.
    const stored = {
      courseId: COURSE,
      version: 1,
      uid: LEARNER.uid,
      mandatoryTopicIds: ["tema-uno"],
      topics: {
        "tema-uno": {
          topicId: "tema-uno",
          passed: false,
          attempts: 0,
          passedAt: null,
          lastAttemptAt: null,
          bestScore: 0,
        },
      },
      finalExam: {
        passed: false,
        attempts: 0,
        bestScore: 0,
        passedAt: null,
        lastAttemptAt: null,
      },
      completedAt: null,
      documents: {
        "doc-1": {
          documentId: "doc-1",
          totalPages: 2,
          lastPageViewed: 2,
          completedAt: FIXED_NOW.toISOString(),
        },
      },
      updatedAt: FIXED_NOW.toISOString(),
    } as StoredProgress;
    learning.progress.set(`${LEARNER.uid}@${COURSE}`, stored);

    const view = await courseViewForLearner(deps, LEARNER, COURSE);
    expect(view.topics[0].readComplete).toBe(true);
    expect(view.topics[0].quizAvailable).toBe(true);
    expect(view.topics[0].screens.completed).toBe(false);
  });
});
