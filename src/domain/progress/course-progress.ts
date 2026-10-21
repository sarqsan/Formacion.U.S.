import { DomainError } from "@/domain/text";

/**
 * PROGRESO DE CURSO (modelo puro y persistible)
 * =============================================
 *
 * Estructura ligada a UNA versión concreta del curso. Es la unidad que se
 * guarda en la base de datos y la que se recalcula siempre en el servidor:
 * el cliente nunca envía este objeto, solo pide acciones ("he respondido el
 * cuestionario del tema X con estas opciones").
 *
 * Invariantes:
 * - `completedAt` solo puede tener valor si todos los temas obligatorios están
 *   aprobados Y el examen final está aprobado.
 * - El examen final no puede aprobarse si queda algún tema obligatorio.
 */

export interface TopicProgress {
  topicId: string;
  passed: boolean;
  attempts: number;
  passedAt: string | null;
  lastAttemptAt: string | null;
  bestScore: number;
}

export interface FinalExamProgress {
  passed: boolean;
  attempts: number;
  bestScore: number;
  passedAt: string | null;
  lastAttemptAt: string | null;
}

export interface CourseProgress {
  courseId: string;
  version: number;
  mandatoryTopicIds: string[];
  topics: Record<string, TopicProgress>;
  finalExam: FinalExamProgress;
  completedAt: string | null;
}

export function initProgress(
  courseId: string,
  version: number,
  mandatoryTopicIds: readonly string[],
): CourseProgress {
  if (!courseId) {
    throw new DomainError("PROGRESS_COURSE_MISSING", "Falta el curso.", 500);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError("PROGRESS_VERSION_INVALID", "Versión de curso no válida.", 500);
  }

  const uniqueTopicIds = [...new Set(mandatoryTopicIds)];
  const topics: Record<string, TopicProgress> = {};
  for (const topicId of uniqueTopicIds) {
    topics[topicId] = {
      topicId,
      passed: false,
      attempts: 0,
      passedAt: null,
      lastAttemptAt: null,
      bestScore: 0,
    };
  }

  return {
    courseId,
    version,
    mandatoryTopicIds: uniqueTopicIds,
    topics,
    finalExam: {
      passed: false,
      attempts: 0,
      bestScore: 0,
      passedAt: null,
      lastAttemptAt: null,
    },
    completedAt: null,
  };
}

/** Reinicia el progreso para una versión nueva (el histórico lo archiva el servidor). */
export function restartForVersion(
  progress: CourseProgress,
  version: number,
  mandatoryTopicIds: readonly string[],
): CourseProgress {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError("PROGRESS_VERSION_INVALID", "Versión de curso no válida.", 500);
  }
  if (version <= progress.version) {
    throw new DomainError(
      "PROGRESS_VERSION_NOT_NEWER",
      "El reinicio de progreso solo aplica a una versión posterior.",
      500,
    );
  }
  return initProgress(progress.courseId, version, mandatoryTopicIds);
}

export function areAllMandatoryTopicsPassed(progress: CourseProgress): boolean {
  if (progress.mandatoryTopicIds.length === 0) return true;
  return progress.mandatoryTopicIds.every(
    (topicId) => progress.topics[topicId]?.passed === true,
  );
}

export function isFinalExamUnlocked(progress: CourseProgress): boolean {
  return areAllMandatoryTopicsPassed(progress);
}

export function isCourseCompleted(progress: CourseProgress): boolean {
  return areAllMandatoryTopicsPassed(progress) && progress.finalExam.passed;
}

/** Porcentaje 0..100 (temas obligatorios + examen final). */
export function completionPercent(progress: CourseProgress): number {
  const topicsTotal = progress.mandatoryTopicIds.length;
  const stepsTotal = topicsTotal + 1;
  const passedTopics = progress.mandatoryTopicIds.filter(
    (topicId) => progress.topics[topicId]?.passed === true,
  ).length;
  const examStep = progress.finalExam.passed ? 1 : 0;
  return Math.round(((passedTopics + examStep) / stepsTotal) * 100);
}

function assertMandatoryTopic(progress: CourseProgress, topicId: string): void {
  if (!progress.mandatoryTopicIds.includes(topicId)) {
    throw new DomainError(
      "TOPIC_NOT_IN_COURSE",
      "El tema indicado no pertenece a este curso.",
      404,
    );
  }
}

/**
 * Registra el resultado de un cuestionario de tema ya corregido en servidor.
 * Devuelve un objeto nuevo (no muta la entrada).
 */
export function recordTopicAttempt(
  progress: CourseProgress,
  topicId: string,
  grade: { passed: boolean; score: number },
  atIso: string,
): CourseProgress {
  assertMandatoryTopic(progress, topicId);
  assertIsoDate(atIso);

  const previous = progress.topics[topicId];
  const topics: Record<string, TopicProgress> = {
    ...progress.topics,
    [topicId]: {
      topicId,
      passed: previous.passed || grade.passed,
      attempts: previous.attempts + 1,
      passedAt: previous.passedAt ?? (grade.passed ? atIso : null),
      lastAttemptAt: atIso,
      bestScore: Math.max(previous.bestScore, grade.score),
    },
  };

  return finalize({ ...progress, topics });
}

/**
 * Registra el resultado del examen final. Exige que esté desbloqueado: la
 * comprobación se repite aquí además de en el servicio para que no exista
 * ninguna ruta que apruebe el examen sin los temas.
 */
export function recordFinalExamAttempt(
  progress: CourseProgress,
  grade: { passed: boolean; score: number },
  atIso: string,
): CourseProgress {
  assertIsoDate(atIso);

  if (!isFinalExamUnlocked(progress) && !grade.passed) {
    // Permitir intentos fallidos es inútil si no está desbloqueado; se rechaza.
    throw new DomainError(
      "FINAL_EXAM_LOCKED",
      "El examen final requiere aprobar antes todos los temas obligatorios.",
      409,
    );
  }

  if (!isFinalExamUnlocked(progress) && grade.passed) {
    throw new DomainError(
      "FINAL_EXAM_LOCKED",
      "El examen final requiere aprobar antes todos los temas obligatorios.",
      409,
    );
  }

  const finalExam: FinalExamProgress = {
    passed: progress.finalExam.passed || grade.passed,
    attempts: progress.finalExam.attempts + 1,
    bestScore: Math.max(progress.finalExam.bestScore, grade.score),
    passedAt: progress.finalExam.passedAt ?? (grade.passed ? atIso : null),
    lastAttemptAt: atIso,
  };

  return finalize({ ...progress, finalExam });
}

/** Recalcula `completedAt` para mantener la invariante del modelo. */
function finalize(progress: CourseProgress): CourseProgress {
  if (!isCourseCompleted(progress)) {
    return { ...progress, completedAt: null };
  }
  if (progress.completedAt) return progress;
  return {
    ...progress,
    completedAt: progress.finalExam.passedAt ?? progress.topics[progress.mandatoryTopicIds[0]]?.passedAt ?? null,
  };
}

function assertIsoDate(value: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new DomainError("TIMESTAMP_INVALID", "Marca de tiempo no válida.", 500);
  }
}
