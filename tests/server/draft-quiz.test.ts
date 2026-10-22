import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  draftEditorView,
  saveDraftAssessments,
  startDraft,
} from "@/server/courses/editor";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import {
  adminCreateCourse,
  adminDraftEditor,
  adminEnroll,
  adminSaveDraftAssessments,
  adminSaveDraftStructure,
  adminStartDraft,
  courseViewForLearner,
  coursesForLearner,
} from "@/demo/service";
import { definitionOf, resetDemoState } from "@/demo/store";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  makeDefinition,
  makeTopic,
} from "../helpers/db-doubles";

/**
 * CUESTIONARIOS DEL BORRADOR: CLAVES SEPARADAS Y VERSIÓN PUBLICADA INTACTA
 * =======================================================================
 *
 * Cada prueba corresponde a una promesa del bloque 05:
 *
 *   1. se crean y editan preguntas de un tema y del examen final;
 *   2. la clave **no** está en el documento de versión: vive en `answerKeys`;
 *   3. guardar contenido y claves es una sola operación (o las dos o ninguna);
 *   4. la pregunta eliminada no deja su respuesta correcta suelta;
 *   5. un cuestionario vacío se guarda (borrador incompleto);
 *   6. una pregunta rota no se guarda, y el mensaje dice qué pasa;
 *   7. dos guardados con la misma revisión no se pisan;
 *   8. la versión publicada y sus claves no cambian nunca;
 *   9. el alumnado no recibe ninguna respuesta correcta;
 *  10. la demo se comporta igual que el contrato con dobles.
 *
 * Aviso de alcance: dobles y demo son memoria. La transacción real de Firestore
 * no se ejecuta aquí (sin emulador ni credenciales).
 */

function question(overrides: Partial<QuizQuestionDefinition> = {}): QuizQuestionDefinition {
  return {
    id: "pregunta-1",
    type: "single_choice",
    optionIds: ["a", "b", "c"],
    correctOptionIds: ["b"],
    prompt: "¿Cuál es la respuesta correcta?",
    optionLabels: { a: "Primera", b: "Segunda", c: "Tercera" },
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryCatalogStore();
  return { store, deps: { store, now: () => FIXED_NOW } };
}

async function openDraftFromPublished(store: InMemoryCatalogStore) {
  store.seedPublished(
    makeDefinition({
      topics: [makeTopic({ id: "tema-1", order: 1 }), makeTopic({ id: "tema-2", order: 2 })],
      finalExam: [question({ id: "final-1" })],
    }),
  );
  const deps = { store, now: () => FIXED_NOW };
  const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);
  return { deps, opened };
}

function codes(issues: ReadonlyArray<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// 1 y 2. Crear, editar y guardar con las claves aparte
// ---------------------------------------------------------------------------

describe("saveDraftAssessments: guardar cuestionarios", () => {
  it("crea preguntas en un tema y guarda la clave fuera del documento de versión", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const result = await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: {
          "tema-1": [
            question({ id: "t1-1" }),
            question({ id: "t1-2", correctOptionIds: ["a"], optionIds: ["a", "b"] }),
          ],
          "tema-2": [],
        },
        finalExam: [question({ id: "final-1" })],
      },
      deps,
    );

    expect(result).toMatchObject({ version: 2, revision: opened.revision + 1 });
    expect(result.quiz).toEqual({ topics: 1, questions: 2, finalExam: 1 });

    // La versión guardada no lleva respuestas por ninguna parte.
    const version = await store.getVersion("curso-a", opened.version);
    expect(JSON.stringify(version)).not.toContain("correctOptionIds");
    expect(version?.topics.find((topic) => topic.id === "tema-1")?.quiz.map((q) => q.id)).toEqual([
      "t1-1",
      "t1-2",
    ]);

    // Las claves sí, en su documento aparte y solo para el servidor.
    const keys = await store.getAnswerKeys("curso-a", opened.version);
    expect(keys?.quizByTopic["tema-1"]).toEqual([
      { id: "t1-1", correctOptionIds: ["b"] },
      { id: "t1-2", correctOptionIds: ["a"] },
    ]);
    expect(keys?.finalExam).toEqual([{ id: "final-1", correctOptionIds: ["b"] }]);

    // Y al reconstruir la definición editable vuelven a estar unidas.
    const definition = definitionFromDocuments(version!, keys);
    expect(definition.topics[0].quiz[0]).toMatchObject({
      id: "t1-1",
      correctOptionIds: ["b"],
      optionLabels: { a: "Primera", b: "Segunda", c: "Tercera" },
    });
  });

  it("editar una pregunta conserva su identificador y el resto del contenido", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-1": [question({ id: "q-original" })] },
      },
      deps,
    );

    const afterFirst = await store.getVersion("curso-a", opened.version);
    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: afterFirst!.revision!,
        topicQuizzes: {
          "tema-1": [
            question({
              id: "q-original",
              prompt: "Enunciado corregido",
              correctOptionIds: ["c"],
            }),
          ],
        },
      },
      deps,
    );

    const keys = await store.getAnswerKeys("curso-a", opened.version);
    expect(keys?.quizByTopic["tema-1"]).toEqual([{ id: "q-original", correctOptionIds: ["c"] }]);

    const definition = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      keys,
    );
    expect(definition.topics[0].quiz[0]).toMatchObject({
      id: "q-original",
      prompt: "Enunciado corregido",
      correctOptionIds: ["c"],
    });
    // Los documentos del tema siguen donde estaban: este guardado no los toca.
    expect(definition.topics[0].documents.map((document) => document.id)).toEqual(["doc-tema-1"]);
  });

  it("los temas que no se envían conservan su cuestionario", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const before = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      await store.getAnswerKeys("curso-a", opened.version),
    );

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-2": [question({ id: "solo-tema-2" })] },
      },
      deps,
    );

    const after = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      await store.getAnswerKeys("curso-a", opened.version),
    );

    expect(after.topics[0].quiz.map((q) => q.id)).toEqual(before.topics[0].quiz.map((q) => q.id));
    expect(after.topics[1].quiz.map((q) => q.id)).toEqual(["solo-tema-2"]);
  });
});

// ---------------------------------------------------------------------------
// 3 y 4. Atomicidad y claves sin restos
// ---------------------------------------------------------------------------

describe("atomicidad de contenido y claves", () => {
  it("eliminar una pregunta borra también su clave: no quedan restos", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: {
          "tema-1": [question({ id: "se-queda" }), question({ id: "se-va", correctOptionIds: ["c"] })],
        },
      },
      deps,
    );

    const revision = (await store.getVersion("curso-a", opened.version))!.revision!;

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: revision,
        topicQuizzes: { "tema-1": [question({ id: "se-queda" })] },
      },
      deps,
    );

    const keys = await store.getAnswerKeys("curso-a", opened.version);
    expect(keys?.quizByTopic["tema-1"].map((key) => key.id)).toEqual(["se-queda"]);
    expect(JSON.stringify(keys)).not.toContain("se-va");
  });

  it("si el almacén falla, no se guarda ni el contenido ni las claves", async () => {
    const { store } = setup();
    const { opened } = await openDraftFromPublished(store);
    const versionBefore = await store.getVersion("curso-a", opened.version);
    const keysBefore = await store.getAnswerKeys("curso-a", opened.version);

    const failing: CourseCatalogStore = Object.create(store);
    failing.replaceDraftContent = async () => {
      throw new DomainError("FIRESTORE_UNAVAILABLE", "La base de datos no responde.", 503);
    };

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: { "tema-1": [question({ id: "no-se-guarda" })] },
        },
        { store: failing, now: () => FIXED_NOW },
      ),
    ).rejects.toMatchObject({ code: "FIRESTORE_UNAVAILABLE" });

    expect(await store.getVersion("curso-a", opened.version)).toEqual(versionBefore);
    expect(await store.getAnswerKeys("curso-a", opened.version)).toEqual(keysBefore);
  });

  it("escribe contenido y claves en una sola operación del almacén", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);
    const before = store.draftContentWrites;

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-1": [question({ id: "una" })] },
      },
      deps,
    );

    expect(store.draftContentWrites).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// 5 y 6. Vacío permitido, roto rechazado
// ---------------------------------------------------------------------------

describe("validación al guardar", () => {
  it("un cuestionario vacío se guarda y queda como aviso, no como error", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const result = await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-1": [] },
        finalExam: [],
      },
      deps,
    );

    expect(result.quiz).toEqual({ topics: 1, questions: 1, finalExam: 0 });
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining(["TOPIC_WITHOUT_QUIZ", "FINAL_EXAM_EMPTY"]),
    );
    // Y se ha guardado de verdad.
    expect((await store.getAnswerKeys("curso-a", opened.version))?.finalExam).toEqual([]);
  });

  it("una opción sin texto se guarda con aviso: no bloquea el guardado", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    // Contenido anterior al editor: opciones sin etiqueta. Debe poder guardarse.
    const result = await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: {
          "tema-1": [question({ id: "sin-texto", optionLabels: {} })],
        },
      },
      deps,
    );

    expect(codes(result.warnings)).toContain("OPTION_LABEL_MISSING");
    const versionDoc = await store.getVersion("curso-a", opened.version);
    const quiz = versionDoc?.topics.find((topic) => topic.id === "tema-1")?.quiz ?? [];
    expect(quiz.map((item) => item.id)).toEqual(["sin-texto"]);
    // La clave sí se ha escrito, aunque la etiqueta falte.
    expect(
      (await store.getAnswerKeys("curso-a", opened.version))?.quizByTopic["tema-1"].map((key) => key.id),
    ).toEqual(["sin-texto"]);
  });

  it("rechaza una pregunta sin respuesta correcta con un mensaje que se entiende", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);
    const before = await store.getVersion("curso-a", opened.version);

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: { "tema-1": [question({ id: "rota", correctOptionIds: [] })] },
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: "COURSE_QUIZ_INVALID",
      message: expect.stringContaining("respuesta correcta"),
    });

    expect(await store.getVersion("curso-a", opened.version)).toEqual(before);
  });

  it("rechaza una pregunta con una sola opción y no escribe nada", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);
    const keysBefore = await store.getAnswerKeys("curso-a", opened.version);

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: {
            "tema-1": [question({ id: "corta", optionIds: ["a"], correctOptionIds: ["a"] })],
          },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_QUIZ_INVALID" });

    expect(await store.getAnswerKeys("curso-a", opened.version)).toEqual(keysBefore);
  });

  it("rechaza un tema que no existe en esta versión", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: { "tema-fantasma": [question()] },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_NOT_FOUND", status: 404 });
  });

  it("solo un administrador activo puede guardar cuestionarios", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    await expect(
      saveDraftAssessments(
        {
          actor: LEARNER,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: { "tema-1": [question()] },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrencia
// ---------------------------------------------------------------------------

describe("concurrencia", () => {
  it("el segundo guardado con la misma revisión no pisa el primero", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-1": [question({ id: "pestana-uno" })] },
      },
      deps,
    );

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: opened.version,
          expectedRevision: opened.revision,
          topicQuizzes: { "tema-1": [question({ id: "pestana-dos" })] },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DRAFT_STALE", status: 409 });

    const keys = await store.getAnswerKeys("curso-a", opened.version);
    expect(keys?.quizByTopic["tema-1"].map((key) => key.id)).toEqual(["pestana-uno"]);
  });
});

// ---------------------------------------------------------------------------
// 8 y 9. Publicado inmutable y alumnado sin claves
// ---------------------------------------------------------------------------

describe("la versión publicada es inmutable", () => {
  it("guardar cuestionarios del borrador no cambia la publicada ni sus claves", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const publishedBefore = structuredClone(await store.getVersion("curso-a", 1));
    const keysBefore = structuredClone(await store.getAnswerKeys("curso-a", 1));

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: { "tema-1": [question({ id: "nueva", correctOptionIds: ["a"] })] },
        finalExam: [],
      },
      deps,
    );

    expect(await store.getVersion("curso-a", 1)).toEqual(publishedBefore);
    expect(await store.getAnswerKeys("curso-a", 1)).toEqual(keysBefore);
  });

  it("no se puede editar el cuestionario de una versión publicada", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    const before = await store.getAnswerKeys("curso-a", 1);

    await expect(
      saveDraftAssessments(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: 1,
          expectedRevision: 0,
          topicQuizzes: { "tema-1": [question({ id: "intrusa" })] },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "VERSION_NOT_EDITABLE", status: 409 });

    expect(await store.getAnswerKeys("curso-a", 1)).toEqual(before);
  });

  it("el alumnado recibe las preguntas sin respuestas correctas", async () => {
    resetDemoState();
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    const COURSE = "curso-prevencion-riesgos";
    await adminEnroll(demoAdmin, LEARNER.uid, COURSE);

    const view = await courseViewForLearner(LEARNER, COURSE);
    expect(view.topics.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain("correctOptionIds");

    // Y sigue igual aunque el administrador edite el borrador de la siguiente:
    const opened = await adminStartDraft(demoAdmin, COURSE);
    await adminSaveDraftAssessments(demoAdmin, {
      courseId: COURSE,
      version: opened.version,
      expectedRevision: opened.revision,
      topicQuizzes: {
        [view.topics[0].id]: [question({ id: "pregunta-no-publicada" })],
      },
    });

    const after = await courseViewForLearner(LEARNER, COURSE);
    expect(after.version).toBe(view.version);
    expect(JSON.stringify(after)).not.toContain("pregunta-no-publicada");
    expect(JSON.stringify(after)).not.toContain("correctOptionIds");
  });
});

// ---------------------------------------------------------------------------
// 10. Paridad demo ↔ dobles
// ---------------------------------------------------------------------------

describe("equivalencia demo ↔ contrato real", () => {
  beforeEach(() => {
    resetDemoState();
  });

  const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };

  it("la demo guarda el mismo contenido y las mismas claves que el doble", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const edited = [question({ id: "comun", correctOptionIds: ["a"], optionIds: ["a", "b"] })];
    const viaDoble = await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        // El curso de los dobles tiene dos temas: se vacía el segundo para que
        // la forma coincida con la del curso de la demo.
        topicQuizzes: { "tema-1": edited, "tema-2": [] },
        finalExam: [question({ id: "final-doble" })],
      },
      deps,
    );

    await adminCreateCourse(demoAdmin, { courseId: "curso-demo-quiz", title: "Curso demo" });
    const demoOpen = await adminStartDraft(demoAdmin, "curso-demo-quiz");
    // El curso demo nace sin temas: se crean por el servicio de estructura.
    await adminSaveDraftStructure(demoAdmin, {
      courseId: "curso-demo-quiz",
      version: demoOpen.version,
      expectedRevision: demoOpen.revision,
      structure: {
        title: "Curso demo",
        topics: [{ id: "tema-1", title: "Tema uno", order: 1, mandatory: true }],
      },
    });

    const demoView = await adminDraftEditor("curso-demo-quiz", demoOpen.version);
    const viaDemo = await adminSaveDraftAssessments(demoAdmin, {
      courseId: "curso-demo-quiz",
      version: demoOpen.version,
      expectedRevision: demoView!.revision,
      topicQuizzes: { "tema-1": edited },
      finalExam: [question({ id: "final-doble" })],
    });

    // Los recuentos son los mismos; los avisos dependen del resto del curso
    // (documentos, temas), que aquí es distinto a propósito, así que no se
    // comparan: lo que se compara es lo que se guarda.
    expect(viaDemo.quiz).toEqual(viaDoble.quiz);

    // El contenido recuperable coincide campo a campo.
    const demoDefinition = definitionOf("curso-demo-quiz", demoOpen.version);
    const dobleDefinition = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      await store.getAnswerKeys("curso-a", opened.version),
    );
    expect(demoDefinition?.topics[0].quiz).toEqual(dobleDefinition.topics[0].quiz);
    expect(demoDefinition?.finalExam).toEqual(dobleDefinition.finalExam);

    // Y la vista del editor incluye las claves (es de administración).
    const view = await adminDraftEditor("curso-demo-quiz", demoOpen.version);
    expect(view?.topics[0].quiz[0].correctOptionIds).toEqual(["a"]);
    expect(view?.finalExam[0].id).toBe("final-doble");
  });

  it("la vista del editor y el servicio acuerdan la revisión", async () => {
    const { store, deps } = setup();
    const { opened } = await openDraftFromPublished(store);

    const view = draftEditorView({
      course: (await store.getCourse("curso-a"))!,
      version: (await store.getVersion("curso-a", opened.version))!,
      definition: definitionFromDocuments(
        (await store.getVersion("curso-a", opened.version))!,
        await store.getAnswerKeys("curso-a", opened.version),
      ),
    });

    const saved = await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: view.revision,
        topicQuizzes: { "tema-1": [question()] },
      },
      deps,
    );

    expect(saved.revision).toBe(view.revision + 1);
  });
});

// ---------------------------------------------------------------------------
// El catálogo del alumnado no cambia con los cuestionarios del borrador
// ---------------------------------------------------------------------------

describe("catálogo del alumnado", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("un curso con solo borrador no entra en el catálogo aunque tenga cuestionarios", async () => {
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    await adminCreateCourse(demoAdmin, { courseId: "curso-quiz-borrador", title: "Solo borrador" });
    const opened = await adminStartDraft(demoAdmin, "curso-quiz-borrador");

    await adminSaveDraftAssessments(demoAdmin, {
      courseId: "curso-quiz-borrador",
      version: opened.version,
      expectedRevision: opened.revision,
      finalExam: [question({ id: "final-borrador" })],
    });

    const catalog = await coursesForLearner(LEARNER);
    expect(catalog.map((course) => course.courseId)).not.toContain("curso-quiz-borrador");
  });
});
