import { beforeEach, describe, expect, it } from "vitest";
import { submitAssessment } from "@/server/assessments/service";
import { updateDraftVersion } from "@/server/courses/catalog";
import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import {
  accountCourseHistory,
  adminEnroll,
  adminProgress,
  adminPublish,
  adminRevokeEnrollment,
  courseViewForLearner,
  coursesForLearner,
  demoDeps,
  learnerCourseHistory,
  readScreen,
  screenView,
} from "@/demo/service";
import { definitionOf, demoState, resetDemoState } from "@/demo/store";

/**
 * RECORRIDO COMPLETO EN MODO DEMOSTRACIÓN
 * ======================================
 *
 * Estas pruebas recorren la misma secuencia que una persona hará delante de la
 * pantalla, pero llamando a los servicios: leer pantallas en orden, fallar y
 * repetir el cuestionario, desbloquear el examen final, matricular y revocar,
 * editar un borrador y publicar.
 *
 * Lo que NO demuestran: que Firestore guarde nada (aquí el almacén es memoria).
 */

const ADMIN: Actor = { uid: "demo-admin", role: "admin", status: "active" };
const LEARNER: Actor = { uid: "demo-alumno-1", role: "learner", status: "active" };
const COURSE = "curso-prevencion-riesgos";
const DATA_COURSE = "curso-proteccion-datos";

/**
 * Respuestas de un intento. Las correctas se toman de la definición del curso
 * (que en el servidor sí conoce la clave); las fallidas se construyen dejando
 * una opción fuera, sin reutilizar la pantalla pública.
 */
function answersFor(
  courseId: string,
  version: number,
  questions: Array<{ id: string; optionIds: string[] }>,
  correct: boolean,
) {
  const definition = definitionOf(courseId, version);
  const keys = new Map<string, string[]>();
  for (const topic of definition?.topics ?? []) {
    for (const question of topic.quiz) keys.set(question.id, question.correctOptionIds);
  }
  for (const question of definition?.finalExam ?? []) {
    keys.set(question.id, question.correctOptionIds);
  }

  return questions.map((question) => {
    const expected = keys.get(question.id) ?? [];
    const selected = correct
      ? expected
      : expected.length > 1
        ? expected.slice(0, 1)
        : [question.optionIds.find((id) => !expected.includes(id)) ?? question.optionIds[0]];

    return { questionId: question.id, selectedOptionIds: selected };
  });
}

async function readWholeTopic(courseId: string, documentId: string, pages: number) {
  for (let page = 1; page <= pages; page += 1) {
    await readScreen(LEARNER, { courseId, documentId, page });
  }
}

describe("demostración: recorrido del alumno", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("empieza con un solo curso asignado y sin progreso", async () => {
    const courses = await coursesForLearner(LEARNER);
    expect(courses.map((course) => course.courseId)).toEqual([COURSE]);
    expect(courses[0].percent).toBe(0);
    expect(courses[0].topicsTotal).toBe(2);
  });

  it("no deja leer una pantalla saltándose el orden", async () => {
    await expect(
      readScreen(LEARNER, { courseId: COURSE, documentId: "doc-riesgos", page: 2 }),
    ).rejects.toThrow(DomainError);

    await readScreen(LEARNER, { courseId: COURSE, documentId: "doc-riesgos", page: 1 });
    const view = await screenView(LEARNER, { courseId: COURSE, documentId: "doc-riesgos" });
    expect(view.page).toBe(2);
    expect(view.lastPageViewed).toBe(1);
  });

  it("cierra el cuestionario hasta terminar la lectura del tema", async () => {
    const before = await courseViewForLearner(LEARNER, COURSE);
    const topic = before.topics[0];
    expect(topic.readComplete).toBe(false);
    expect(topic.quizAvailable).toBe(false);

    await readWholeTopic(COURSE, "doc-riesgos", 3);

    const after = await courseViewForLearner(LEARNER, COURSE);
    expect(after.topics[0].readComplete).toBe(true);
    expect(after.topics[0].quizAvailable).toBe(true);
  });

  it("rechaza el examen final mientras queden temas obligatorios", async () => {
    await expect(
      submitAssessment(
        {
          actor: LEARNER,
          courseId: COURSE,
          assessmentType: "final",
          answers: [],
        },
        demoDeps(),
      ),
    ).rejects.toMatchObject({ code: "FINAL_EXAM_LOCKED" });
  });

  it("permite repetir el cuestionario hasta acertar todas las respuestas", async () => {
    await readWholeTopic(COURSE, "doc-riesgos", 3);
    const view = await courseViewForLearner(LEARNER, COURSE);
    const topic = view.topics[0];

    const failed = await submitAssessment(
      {
        actor: LEARNER,
        courseId: COURSE,
        assessmentType: "topic",
        topicId: topic.id,
        answers: answersFor(COURSE, 1, topic.questions, false),
      },
      demoDeps(),
    );
    expect(failed.passed).toBe(false);
    expect(failed.correctCount).toBeLessThan(failed.totalQuestions);

    const passed = await submitAssessment(
      {
        actor: LEARNER,
        courseId: COURSE,
        assessmentType: "topic",
        topicId: topic.id,
        answers: answersFor(COURSE, 1, topic.questions, true),
      },
      demoDeps(),
    );
    expect(passed.passed).toBe(true);
    expect(passed.finalExamUnlocked).toBe(false);

    const after = await courseViewForLearner(LEARNER, COURSE);
    expect(after.topics[0].quizPassed).toBe(true);
    expect(after.topics[0].attempts).toBe(2);
    expect(after.topics[0].bestScore).toBe(100);
  });

  it("desbloquea el examen final y marca el curso como completado", async () => {
    await readWholeTopic(COURSE, "doc-riesgos", 3);
    await readWholeTopic(COURSE, "doc-emergencias", 2);

    let view = await courseViewForLearner(LEARNER, COURSE);
    for (const topic of view.topics) {
      const result = await submitAssessment(
        {
          actor: LEARNER,
          courseId: COURSE,
          assessmentType: "topic",
          topicId: topic.id,
          answers: answersFor(COURSE, 1, topic.questions, true),
        },
        demoDeps(),
      );
      expect(result.passed).toBe(true);
    }

    view = await courseViewForLearner(LEARNER, COURSE);
    expect(view.finalExam.unlocked).toBe(true);
    expect(view.completed).toBe(false);

    const exam = await submitAssessment(
      {
        actor: LEARNER,
        courseId: COURSE,
        assessmentType: "final",
        answers: answersFor(COURSE, 1, view.finalExam.questions, true),
      },
      demoDeps(),
    );
    expect(exam.passed).toBe(true);
    expect(exam.courseCompleted).toBe(true);

    view = await courseViewForLearner(LEARNER, COURSE);
    expect(view.percent).toBe(100);
    expect(view.completed).toBe(true);
  });

  it("no deja entrar en un curso sin matrícula", async () => {
    await expect(courseViewForLearner(LEARNER, DATA_COURSE)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
  });
});

describe("demostración: administración", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("matricula, muestra el progreso y revoca sin borrar datos", async () => {
    await adminEnroll(ADMIN, "demo-alumno-1", DATA_COURSE);

    const courses = await coursesForLearner(LEARNER);
    expect(courses.map((course) => course.courseId)).toContain(DATA_COURSE);

    await readWholeTopic(DATA_COURSE, "doc-datos", 2);
    const rows = await adminProgress();
    const row = rows.find((item) => item.uid === LEARNER.uid && item.courseId === DATA_COURSE);
    expect(row?.pending).toContain("Datos personales: principios básicos");

    await adminRevokeEnrollment(ADMIN, "demo-alumno-1", DATA_COURSE);
    await expect(courseViewForLearner(LEARNER, DATA_COURSE)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });

    // El progreso sigue guardado: al reactivar, la lectura no se pierde.
    const stored = demoState().progress.get("demo-alumno-1_curso-proteccion-datos");
    expect(stored?.documents["doc-datos"].lastPageViewed).toBe(2);

    await adminEnroll(ADMIN, "demo-alumno-1", DATA_COURSE);
    const again = await courseViewForLearner(LEARNER, DATA_COURSE);
    expect(again.topics[0].documents[0].read).toBe(true);
  });

  it("edita un borrador y publica una versión nueva que reinicia el progreso", async () => {
    const definition = definitionOf(DATA_COURSE, 2);
    expect(definition).not.toBeNull();

    await updateDraftVersion(
      {
        actor: ADMIN,
        definition: { ...definition!, title: "Protección de datos (v2 revisada)" },
      },
      demoDeps(),
    );

    await adminEnroll(ADMIN, "demo-alumno-1", DATA_COURSE);
    await readWholeTopic(DATA_COURSE, "doc-datos", 2);

    const beforePublish = await courseViewForLearner(LEARNER, DATA_COURSE);
    expect(beforePublish.version).toBe(1);

    await adminPublish(ADMIN, DATA_COURSE, 2);

    const afterPublish = await courseViewForLearner(LEARNER, DATA_COURSE);
    expect(afterPublish.version).toBe(2);
    expect(afterPublish.title).toBe("Protección de datos (v2 revisada)");
    // Versión nueva ⇒ se repite desde cero (el histórico no se borra).
    expect(afterPublish.topics[0].documents[0].lastPageViewed).toBe(0);
    expect(afterPublish.topics.map((topic) => topic.id)).toEqual(["datos-basicos", "soportes"]);
  });

  it("no permite publicar una versión que no es la siguiente", async () => {
    await expect(adminPublish(ADMIN, DATA_COURSE, 2)).resolves.toMatchObject({ version: 2 });
    await expect(adminPublish(ADMIN, DATA_COURSE, 2)).rejects.toThrow(DomainError);
  });

  it("un alumno no puede publicar ni matricular", async () => {
    await expect(adminPublish(LEARNER, DATA_COURSE, 2)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminEnroll(LEARNER, "demo-alumno-2", DATA_COURSE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

/**
 * HISTORIAL DE FORMACIÓN (bloque 10)
 * ==================================
 *
 * La promesa del panel es que al publicarse una versión nueva «se repite desde
 * el principio sin perder el histórico». Antes de este bloque era falsa en la
 * demostración: el archivo se calculaba y se descartaba (`void archive`). Estas
 * pruebas fijan el comportamiento correcto de punta a punta con los servicios.
 */
describe("demostración: historial de formación", () => {
  beforeEach(() => {
    resetDemoState();
  });

  const OTHER_LEARNER: Actor = { uid: "demo-alumno-2", role: "learner", status: "active" };

  async function completeDataV1() {
    await adminEnroll(ADMIN, LEARNER.uid, DATA_COURSE);
    await readWholeTopic(DATA_COURSE, "doc-datos", 2);

    const view = await courseViewForLearner(LEARNER, DATA_COURSE);
    const topic = view.topics[0];
    const topicResult = await submitAssessment(
      {
        actor: LEARNER,
        courseId: DATA_COURSE,
        assessmentType: "topic",
        topicId: topic.id,
        answers: answersFor(DATA_COURSE, 1, topic.questions, true),
      },
      demoDeps(),
    );
    expect(topicResult.passed).toBe(true);

    const unlocked = await courseViewForLearner(LEARNER, DATA_COURSE);
    const exam = await submitAssessment(
      {
        actor: LEARNER,
        courseId: DATA_COURSE,
        assessmentType: "final",
        answers: answersFor(DATA_COURSE, 1, unlocked.finalExam.questions, true),
      },
      demoDeps(),
    );
    expect(exam.courseCompleted).toBe(true);
  }

  async function publishDataV2() {
    const definition = definitionOf(DATA_COURSE, 2);
    expect(definition).not.toBeNull();
    await updateDraftVersion(
      {
        actor: ADMIN,
        definition: { ...definition!, title: "Protección de datos (v2 revisada)" },
      },
      demoDeps(),
    );
    await adminPublish(ADMIN, DATA_COURSE, 2);
  }

  it("no archiva nada mientras la versión cursada sigue siendo la publicada", async () => {
    await completeDataV1();

    await expect(learnerCourseHistory(LEARNER)).resolves.toEqual({ entries: [], unresolved: 0 });
  });

  it("conserva la versión completada al publicarse una nueva y empezar de cero", async () => {
    await completeDataV1();
    await publishDataV2();

    // El progreso vivo vuelve a cero en la versión 2…
    const restarted = await courseViewForLearner(LEARNER, DATA_COURSE);
    expect(restarted.version).toBe(2);
    expect(restarted.completed).toBe(false);
    expect(restarted.topics[0].documents[0].lastPageViewed).toBe(0);

    // …y el histórico sigue vacío hasta que se vuelve a tocar el curso: el
    // archivo es perezoso, igual que en Firestore.
    expect((await learnerCourseHistory(LEARNER)).entries).toEqual([]);

    await readScreen(LEARNER, { courseId: DATA_COURSE, documentId: "doc-datos", page: 1 });

    const history = await learnerCourseHistory(LEARNER);
    expect(history.unresolved).toBe(0);
    expect(history.entries).toEqual([
      expect.objectContaining({
        courseId: DATA_COURSE,
        courseTitle: "Protección de datos y confidencialidad",
        version: 1,
        completed: true,
        topicsPassed: 1,
        topicsTotal: 1,
        finalExamPassed: true,
        finalScore: 100,
        supersededBy: 2,
      }),
    ]);
    expect(history.entries[0].completedAt).not.toBeNull();
    expect(history.entries[0].archivedAt).not.toBeNull();
  });

  it("archiva también lo que quedó a medias, sin disfrazarlo de completado", async () => {
    await adminEnroll(ADMIN, OTHER_LEARNER.uid, DATA_COURSE);
    await readScreen(OTHER_LEARNER, { courseId: DATA_COURSE, documentId: "doc-datos", page: 1 });

    await publishDataV2();
    await readScreen(OTHER_LEARNER, { courseId: DATA_COURSE, documentId: "doc-datos", page: 1 });

    const history = await learnerCourseHistory(OTHER_LEARNER);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      courseId: DATA_COURSE,
      version: 1,
      completed: false,
      completedAt: null,
      topicsPassed: 0,
      topicsTotal: 1,
      supersededBy: 2,
    });
  });

  it("administración puede consultar el histórico de una persona; otra persona no", async () => {
    await completeDataV1();
    await publishDataV2();
    await readScreen(LEARNER, { courseId: DATA_COURSE, documentId: "doc-datos", page: 1 });

    const asAdmin = await accountCourseHistory(ADMIN, LEARNER.uid);
    expect(asAdmin.entries).toHaveLength(1);

    await expect(accountCourseHistory(OTHER_LEARNER, LEARNER.uid)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
