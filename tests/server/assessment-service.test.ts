import { describe, expect, it } from "vitest";
import { submitAssessment } from "@/server/assessments/service";
import { initProgress } from "@/domain/progress/course-progress";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  InMemoryLearningStore,
  LEARNER,
  PENDING,
  fullyReadDocuments,
  makeDefinition,
  makeTopic,
} from "../helpers/db-doubles";
import type { StoredProgress } from "@/server/learning/store";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

function setup(
  options: { topics?: CourseVersionDefinition["topics"]; enrolled?: boolean } = {},
) {
  const catalog = new InMemoryCatalogStore();
  const learning = new InMemoryLearningStore();
  const enrollments = new InMemoryEnrollmentStore();
  const definition = makeDefinition(options.topics ? { topics: options.topics } : {});
  catalog.seedPublished(definition);

  // Fase 6: sin matrícula no hay evaluación. Por defecto, matriculado.
  if (options.enrolled !== false) enrollments.seed(LEARNER.uid, "curso-a");
  enrollments.seed(ADMIN.uid, "curso-a");

  const deps = { catalog, learning, enrollments, now: () => FIXED_NOW };

  return { catalog, learning, enrollments, deps, definition };
}

function seedProgress(
  learning: InMemoryLearningStore,
  overrides: Partial<StoredProgress> = {},
): StoredProgress {
  const base: StoredProgress = {
    ...initProgress("curso-a", 1, ["tema-1"]),
    uid: LEARNER.uid,
    documents: fullyReadDocuments("tema-1"),
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
  learning.seedProgress(base);
  return base;
}

describe("submitAssessment: acceso y contenido", () => {
  it("rechaza una cuenta pendiente de activación", async () => {
    const { deps } = setup();

    await expect(
      submitAssessment(
        {
          actor: PENDING,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("rechaza un curso inexistente o sin publicar", async () => {
    const { deps } = setup();

    await expect(
      submitAssessment(
        { actor: LEARNER, courseId: "curso-z", assessmentType: "final", answers: [] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AVAILABLE" });
  });

  it("sin matrícula no se puede evaluar, aunque el curso esté publicado", async () => {
    const { deps, learning } = setup({ enrolled: false });
    seedProgress(learning);

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED", status: 403 });
  });

  it("la matrícula en otro curso no abre este", async () => {
    const { deps, learning, enrollments } = setup({ enrolled: false });
    enrollments.seed(LEARNER.uid, "curso-b");
    seedProgress(learning);

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("una matrícula revocada a mitad de curso cierra la evaluación", async () => {
    const { deps, learning, enrollments } = setup();
    seedProgress(learning);
    enrollments.seed(LEARNER.uid, "curso-a", "revoked");

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("se puede repetir un cuestionario suspendido y se acumulan los intentos", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const failing = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["c"] }],
      },
      deps,
    );
    expect(failing.passed).toBe(false);

    const passing = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
      },
      deps,
    );
    expect(passing.passed).toBe(true);

    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.topics["tema-1"].attempts).toBe(2);
    expect(stored?.topics["tema-1"].passed).toBe(true);
    expect(stored?.topics["tema-1"].passedAt).toBe(FIXED_NOW.toISOString());
  });

  it("repetir un cuestionario ya aprobado lo deja aprobado (no se pierde el APTO)", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const good = [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }];
    await submitAssessment(
      { actor: LEARNER, courseId: "curso-a", assessmentType: "topic", topicId: "tema-1", answers: good },
      deps,
    );

    const retry = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["c"] }],
      },
      deps,
    );
    expect(retry.passed).toBe(false);

    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.topics["tema-1"].passed).toBe(true);
    expect(stored?.topics["tema-1"].attempts).toBe(2);
    expect(stored?.topics["tema-1"].bestScore).toBe(100);
  });

  it("rechaza un tema que no pertenece al curso", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-99",
          answers: [],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_NOT_IN_COURSE" });
  });

  it("exige leer el tema completo antes del cuestionario", async () => {
    const { deps, learning } = setup();
    seedProgress(learning, { documents: {} });

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_NOT_READ" });

    expect(learning.commits).toBe(0);
  });

  it("no cuenta como leído un documento a medias", async () => {
    const { deps, learning } = setup();
    seedProgress(learning, {
      documents: {
        "doc-tema-1": {
          documentId: "doc-tema-1",
          totalPages: 3,
          lastPageViewed: 2,
          completedAt: null,
        },
      },
    });

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_NOT_READ" });
  });

  it("exige el tema en los cuestionarios de tema", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    await expect(
      submitAssessment(
        { actor: LEARNER, courseId: "curso-a", assessmentType: "topic", answers: [] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_REQUIRED" });
  });
});

describe("submitAssessment: corrección en servidor", () => {
  it("aprueba solo con todas las respuestas correctas", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
      },
      deps,
    );

    expect(result.passed).toBe(true);
    expect(result.correctCount).toBe(1);
    expect(result.totalQuestions).toBe(1);
    expect(result.finalExamUnlocked).toBe(true);

    expect(learning.attempts).toHaveLength(1);
    expect(learning.attempts[0]).toMatchObject({
      uid: LEARNER.uid,
      assessmentType: "topic",
      topicId: "tema-1",
      passed: true,
      gradedBy: "server",
      version: 1,
    });
  });

  it("suspende con una respuesta incorrecta y no desbloquea el examen", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["c"] }],
      },
      deps,
    );

    expect(result.passed).toBe(false);
    expect(result.correctCount).toBe(0);
    expect(result.incorrectQuestionIds).toEqual(["q-tema-1"]);
    expect(result.finalExamUnlocked).toBe(false);

    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.topics["tema-1"].passed).toBe(false);
    expect(stored?.topics["tema-1"].attempts).toBe(1);
  });

  it("trata una pregunta sin responder como no superada", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [],
      },
      deps,
    );

    expect(result.passed).toBe(false);
    expect(result.unansweredQuestionIds).toEqual(["q-tema-1"]);
  });

  it("nunca devuelve las respuestas correctas al cliente", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["c"] }],
      },
      deps,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("correctOptionIds");
    expect(serialized).not.toContain("correctOption");
    // Ni siquiera en el caso de fallo se dice cuál era la buena.
    expect(Object.keys(result).sort()).toEqual([
      "correctCount",
      "courseCompleted",
      "finalExamUnlocked",
      "incorrectQuestionIds",
      "passed",
      "score",
      "totalQuestions",
      "unansweredQuestionIds",
    ]);
    // El intento guardado tampoco tiene claves: guarda lo que marcó el usuario.
    expect(JSON.stringify(learning.attempts[0])).not.toContain("correctOptionIds");
  });

  it("rechaza opciones que no existen en la pregunta (no las ignora en silencio)", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["z"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ANSWER_UNKNOWN_OPTION" });

    expect(learning.commits).toBe(0);
  });

  it("detecta claves que no corresponden al cuestionario publicado", async () => {
    const { deps, learning, catalog } = setup();
    seedProgress(learning);
    catalog.keys.set("curso-a@1", {
      courseId: "curso-a",
      version: 1,
      quizByTopic: { "tema-1": [{ id: "pregunta-fantasma", correctOptionIds: ["a"] }] },
      finalExam: [{ id: "q-final", correctOptionIds: ["b"] }],
      createdAt: FIXED_NOW.toISOString(),
    });

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ANSWER_KEY_MISMATCH" });
  });
});

describe("submitAssessment: examen final", () => {
  it("está bloqueado hasta aprobar todos los temas obligatorios", async () => {
    const { deps, learning } = setup();
    seedProgress(learning);

    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "final",
          answers: [{ questionId: "q-final", selectedOptionIds: ["b"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "FINAL_EXAM_LOCKED" });

    expect(learning.commits).toBe(0);
  });

  it("al aprobarlo completa el curso", async () => {
    const { deps, learning } = setup();
    seedProgress(learning, {
      topics: {
        "tema-1": {
          topicId: "tema-1",
          passed: true,
          attempts: 1,
          passedAt: FIXED_NOW.toISOString(),
          lastAttemptAt: FIXED_NOW.toISOString(),
          bestScore: 100,
        },
      },
    });

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "final",
        answers: [{ questionId: "q-final", selectedOptionIds: ["b"] }],
      },
      deps,
    );

    expect(result.passed).toBe(true);
    expect(result.courseCompleted).toBe(true);

    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.finalExam.passed).toBe(true);
    expect(stored?.completedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("suspenderlo no completa el curso y guarda el intento", async () => {
    const { deps, learning } = setup();
    seedProgress(learning, {
      topics: {
        "tema-1": {
          topicId: "tema-1",
          passed: true,
          attempts: 1,
          passedAt: FIXED_NOW.toISOString(),
          lastAttemptAt: FIXED_NOW.toISOString(),
          bestScore: 100,
        },
      },
    });

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "final",
        answers: [{ questionId: "q-final", selectedOptionIds: ["a"] }],
      },
      deps,
    );

    expect(result.passed).toBe(false);
    expect(result.courseCompleted).toBe(false);
    expect((await learning.getProgress(LEARNER.uid, "curso-a"))?.completedAt).toBeNull();
    expect(learning.attempts).toHaveLength(1);
  });

  it("los temas opcionales se corrigen pero no cuentan para el examen final", async () => {
    const { deps, learning } = setup({
      topics: [
        makeTopic({ id: "tema-1", order: 1 }),
        makeTopic({ id: "tema-2", order: 2, mandatory: false }),
      ],
    });
    seedProgress(learning, {
      documents: { ...fullyReadDocuments("tema-1"), ...fullyReadDocuments("tema-2") },
    });

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-2",
        answers: [{ questionId: "q-tema-2", selectedOptionIds: ["a"] }],
      },
      deps,
    );

    expect(result.passed).toBe(true);
    // Se registra el intento, pero el progreso del curso no lo incorpora.
    expect(learning.attempts).toHaveLength(1);
    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.topics["tema-2"]).toBeUndefined();
    expect(result.finalExamUnlocked).toBe(false);
  });
});

describe("submitAssessment: cambio de versión", () => {
  it("archiva el progreso de la versión anterior y reinicia", async () => {
    const { deps, learning, catalog } = setup();
    seedProgress(learning, {
      topics: {
        "tema-1": {
          topicId: "tema-1",
          passed: true,
          attempts: 2,
          passedAt: FIXED_NOW.toISOString(),
          lastAttemptAt: FIXED_NOW.toISOString(),
          bestScore: 100,
        },
      },
    });

    // Se publica la v2. El tema no tiene documentos a propósito: así la prueba
    // del reinicio no depende del endpoint de lectura de páginas (que aún no
    // existe) y se comprueba exactamente lo que toca: archivar y empezar de cero.
    catalog.seedPublished(
      makeDefinition({
        version: 2,
        topics: [makeTopic({ id: "tema-1", order: 1, documents: [] })],
      }),
    );

    const result = await submitAssessment(
      {
        actor: LEARNER,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
      },
      deps,
    );

    // El progreso de v1 queda archivado, no borrado.
    const archived = learning.archive.get(`${LEARNER.uid}@curso-a@v1`);
    expect(archived?.version).toBe(1);
    expect(archived?.topics["tema-1"].passed).toBe(true);

    const current = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(current?.version).toBe(2);
    expect(current?.topics["tema-1"].attempts).toBe(1);
    expect(learning.attempts.at(-1)?.version).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("tras el cambio de versión hay que volver a leer el tema", async () => {
    const { deps, learning, catalog } = setup();
    seedProgress(learning);

    catalog.seedPublished(makeDefinition({ version: 2 }));

    // La lectura de la v2 no existe todavía: el cuestionario debe seguir
    // bloqueado en lugar de heredar la lectura de la v1.
    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: "curso-a",
          assessmentType: "topic",
          topicId: "tema-1",
          answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOPIC_NOT_READ" });

    expect(learning.commits).toBe(0);
  });

  it("el mismo usuario administrador también cursa (no hay rol fijo por endpoint)", async () => {
    const { deps, learning } = setup();
    seedProgress(learning, { uid: ADMIN.uid });

    const result = await submitAssessment(
      {
        actor: ADMIN,
        courseId: "curso-a",
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-tema-1", selectedOptionIds: ["a"] }],
      },
      deps,
    );

    expect(result.passed).toBe(true);
    expect(learning.attempts[0].uid).toBe(ADMIN.uid);
  });
});
