import { DomainError } from "@/domain/text";
import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import {
  gradeAttempt,
  type QuizQuestionDefinition,
  type SubmittedAnswer,
} from "@/domain/assessments/scoring";
import {
  areAllMandatoryTopicsPassed,
  recordFinalExamAttempt,
  recordTopicAttempt,
  type CourseProgress,
} from "@/domain/progress/course-progress";
import { isTopicFullyRead } from "@/domain/progress/reading";
import {
  mandatoryTopicsOf,
  type AnswerKeysDocument,
  type CourseVersionDocument,
} from "@/server/courses/catalog";
import type { AttemptRecord, LearningStore, StoredProgress } from "@/server/learning/store";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import type { EnrollmentStore } from "@/server/enrollments/store";
import { assertCourseAccess } from "@/server/enrollments/service";
import { loadOrInitProgress } from "@/server/learning/progress-loader";

/**
 * PRESENTACIÓN DE UNA EVALUACIÓN (corrección en servidor)
 * ======================================================
 *
 * El cliente solo envía qué opciones marcó. Aquí:
 *   1. se comprueba que el actor está activo y que el curso está publicado;
 *   2. se carga la clave de corrección desde la colección privada;
 *   3. se exige haber leído el tema antes de su cuestionario;
 *   4. se exige haber aprobado todos los temas antes del examen final;
 *   5. se corrige con el dominio (`gradeAttempt`, todo o nada);
 *   6. se guardan intento y progreso en una sola transacción.
 *
 * La respuesta NUNCA incluye las respuestas correctas: solo el resultado.
 *
 * Endpoint HTTP: pendiente (fase 4). Este servicio es la unidad que se probará
 * contra el emulador y la que evitará duplicar reglas en la interfaz.
 */

export interface SubmitAssessmentDependencies {
  catalog: CourseCatalogStore;
  learning: LearningStore;
  /** Matrículas: sin matrícula activa no hay evaluación (403). */
  enrollments: EnrollmentStore;
  now?: () => Date;
}

export interface SubmitAssessmentInput {
  actor: Actor;
  courseId: string;
  assessmentType: "topic" | "final";
  /** Obligatorio si `assessmentType === "topic"`. */
  topicId?: string;
  answers: SubmittedAnswer[];
}

export interface SubmitAssessmentResult {
  passed: boolean;
  correctCount: number;
  totalQuestions: number;
  score: number;
  incorrectQuestionIds: string[];
  unansweredQuestionIds: string[];
  /** Estado agregado del curso tras el intento. */
  courseCompleted: boolean;
  finalExamUnlocked: boolean;
}

/** Recompone el documento persistible a partir del progreso de dominio. */
function withMeta(
  progress: CourseProgress,
  base: { uid: string; documents: StoredProgress["documents"]; updatedAt: string },
): StoredProgress {
  return {
    ...progress,
    uid: base.uid,
    documents: base.documents,
    updatedAt: base.updatedAt,
  };
}

function keysToDefinitions(
  keys: Array<{ id: string; correctOptionIds: string[] }>,
  publicQuestions: Array<{ id: string; type: "single_choice" | "multi_choice"; optionIds: string[] }>,
): QuizQuestionDefinition[] {
  const publicById = new Map(publicQuestions.map((question) => [question.id, question]));

  return keys.map((key) => {
    const publicQuestion = publicById.get(key.id);
    if (!publicQuestion) {
      throw new DomainError(
        "ANSWER_KEY_MISMATCH",
        "Las claves de corrección no corresponden al cuestionario publicado.",
        500,
      );
    }
    return {
      id: key.id,
      type: publicQuestion.type,
      optionIds: publicQuestion.optionIds,
      correctOptionIds: key.correctOptionIds,
    };
  });
}

async function loadPublishedVersion(
  input: SubmitAssessmentInput,
  deps: SubmitAssessmentDependencies,
): Promise<{
  version: CourseVersionDocument;
  keys: AnswerKeysDocument;
  publishedVersion: number;
}> {
  const course = await deps.catalog.getCourse(input.courseId);
  if (!course || course.publishedVersion === null) {
    throw new DomainError(
      "COURSE_NOT_AVAILABLE",
      "El curso no existe o no tiene ninguna versión publicada.",
      404,
    );
  }

  const version = await deps.catalog.getVersion(input.courseId, course.publishedVersion);
  if (!version || version.status !== "published") {
    throw new DomainError(
      "COURSE_NOT_AVAILABLE",
      "La versión publicada del curso no está disponible.",
      409,
    );
  }

  const keys = await deps.catalog.getAnswerKeys(input.courseId, course.publishedVersion);
  if (!keys) {
    throw new DomainError(
      "ANSWER_KEYS_MISSING",
      "Faltan las claves de corrección de esta versión. Avisa a administración.",
      500,
    );
  }

  return { version, keys, publishedVersion: course.publishedVersion };
}

export async function submitAssessment(
  input: SubmitAssessmentInput,
  deps: SubmitAssessmentDependencies,
): Promise<SubmitAssessmentResult> {
  const actor = assertActiveAccount(input.actor);
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();

  const { version, keys, publishedVersion } = await loadPublishedVersion(input, deps);

  // Matriculación: publicar un curso NO da acceso. El administrador puede
  // corregir y revisar cualquier curso; un alumno necesita matrícula activa.
  await assertCourseAccess(actor, input.courseId, deps);

  const mandatory = mandatoryTopicsOf(version);

  // ---- progreso actual (o reinicio si cambió la versión publicada) ---------
  const loaded = await loadOrInitProgress({
    learning: deps.learning,
    uid: actor.uid,
    courseId: input.courseId,
    publishedVersion,
    mandatoryTopicIds: mandatory,
    at,
  });
  const stored: StoredProgress = loaded.progress;
  const archive: StoredProgress | null = loaded.archive;

  // ---- corrección ----------------------------------------------------------
  let attempt: AttemptRecord;
  let updated: StoredProgress;

  if (input.assessmentType === "topic") {
    const topicId = input.topicId?.trim();
    if (!topicId) {
      throw new DomainError("TOPIC_REQUIRED", "Indica el tema del cuestionario.");
    }

    const topic = version.topics.find((item) => item.id === topicId);
    if (!topic) {
      throw new DomainError("TOPIC_NOT_IN_COURSE", "El tema no pertenece al curso.", 404);
    }

    // Leer el tema es requisito para responder su cuestionario.
    const mandatoryDocuments = topic.documents.map((document) => document.id);
    if (!isTopicFullyRead(mandatoryDocuments, stored.documents)) {
      throw new DomainError(
        "TOPIC_NOT_READ",
        "Debes completar la lectura del tema antes de responder el cuestionario.",
        409,
      );
    }

    const questions = keysToDefinitions(keys.quizByTopic[topicId] ?? [], topic.quiz);
    if (questions.length === 0) {
      throw new DomainError(
        "QUIZ_NOT_AVAILABLE",
        "Este tema no tiene cuestionario disponible.",
        409,
      );
    }

    const graded = gradeAttempt(questions, input.answers);

    attempt = {
      uid: actor.uid,
      courseId: input.courseId,
      version: publishedVersion,
      assessmentType: "topic",
      topicId,
      answers: input.answers.map((answer) => ({
        questionId: answer.questionId,
        selectedOptionIds: [...answer.selectedOptionIds],
      })),
      passed: graded.passed,
      correctCount: graded.correctCount,
      totalQuestions: graded.totalQuestions,
      score: graded.score,
      at,
      gradedBy: "server",
    };

    // Solo los temas obligatorios participan en el progreso. Un tema opcional
    // con cuestionario se corrige y se registra el intento, sin afectar al
    // desbloqueo del examen final.
    const tracked = stored.mandatoryTopicIds.includes(topicId);
    const progressed = tracked
      ? recordTopicAttempt(stored, topicId, { passed: graded.passed, score: graded.score }, at)
      : stored;

    updated = withMeta(progressed, {
      uid: actor.uid,
      documents: stored.documents,
      updatedAt: at,
    });

    await deps.learning.commitAttempt({ attempt, progress: updated, archive });

    return {
      passed: graded.passed,
      correctCount: graded.correctCount,
      totalQuestions: graded.totalQuestions,
      score: graded.score,
      incorrectQuestionIds: graded.incorrectQuestionIds,
      unansweredQuestionIds: graded.unansweredQuestionIds,
      courseCompleted: updated.completedAt !== null,
      finalExamUnlocked: areAllMandatoryTopicsPassed(updated),
    };
  }

  // ---- examen final --------------------------------------------------------
  if (!areAllMandatoryTopicsPassed(stored)) {
    throw new DomainError(
      "FINAL_EXAM_LOCKED",
      "El examen final requiere aprobar antes todos los temas obligatorios.",
      409,
    );
  }

  const questions = keysToDefinitions(keys.finalExam, version.finalExam);
  if (questions.length === 0) {
    throw new DomainError("EXAM_NOT_AVAILABLE", "El examen final no está disponible.", 409);
  }

  const graded = gradeAttempt(questions, input.answers);

  attempt = {
    uid: actor.uid,
    courseId: input.courseId,
    version: publishedVersion,
    assessmentType: "final",
    topicId: null,
    answers: input.answers.map((answer) => ({
      questionId: answer.questionId,
      selectedOptionIds: [...answer.selectedOptionIds],
    })),
    passed: graded.passed,
    correctCount: graded.correctCount,
    totalQuestions: graded.totalQuestions,
    score: graded.score,
    at,
    gradedBy: "server",
  };

  const progressed = recordFinalExamAttempt(
    stored,
    { passed: graded.passed, score: graded.score },
    at,
  );
  updated = withMeta(progressed, {
    uid: actor.uid,
    documents: stored.documents,
    updatedAt: at,
  });

  await deps.learning.commitAttempt({ attempt, progress: updated, archive });

  return {
    passed: graded.passed,
    correctCount: graded.correctCount,
    totalQuestions: graded.totalQuestions,
    score: graded.score,
    incorrectQuestionIds: graded.incorrectQuestionIds,
    unansweredQuestionIds: graded.unansweredQuestionIds,
    courseCompleted: updated.completedAt !== null,
    finalExamUnlocked: true,
  };
}
