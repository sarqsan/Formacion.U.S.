import type { CourseProgress } from "@/domain/progress/course-progress";

/**
 * HISTÓRICO DE FORMACIÓN (modelo puro)
 * ====================================
 *
 * Cuando se publica una versión nueva, el progreso anterior no se borra: se
 * archiva en `progressHistory` y el alumno empieza de cero en la versión
 * vigente (ADR-010). El archivo es la prueba de qué se superó y cuándo.
 *
 * Este módulo **solo resume** un progreso archivado. No decide quién puede
 * verlo (eso es `assertCanReadProgress`) ni de dónde sale (eso es el puerto
 * `LearningStore`). Al ser puro, la demostración y Firestore comparten
 * exactamente el mismo cálculo.
 *
 * Regla que se respeta: un curso archivado puede estar **incompleto** (alguien
 * empezó la v1 y no la terminó). El resumen lo dice con `completed` en vez de
 * ocultarlo: un histórico que solo muestra los aprobados no sirve para
 * responder qué había.
 */

/** Lo mínimo que necesita el resumen de un progreso archivado. */
export interface ArchivedProgressView {
  courseId: string;
  version: number;
  mandatoryTopicIds: readonly string[];
  topics: Readonly<Record<string, { passed: boolean; bestScore: number }>>;
  finalExam: { passed: boolean; bestScore: number };
  completedAt: string | null;
  archivedAt: string | null;
}

export interface HistorySummary {
  courseId: string;
  version: number;
  /** Superó todos los temas obligatorios y el examen final. */
  completed: boolean;
  completedAt: string | null;
  /** Cuándo se archivó (al publicarse la versión siguiente). */
  archivedAt: string | null;
  topicsPassed: number;
  topicsTotal: number;
  /** Mejor resultado del examen final (0 si no llegó a hacerlo). */
  finalScore: number;
  finalExamPassed: boolean;
}

/** Resume un progreso archivado. Devuelve cifras; nunca datos de otras personas. */
export function summarizeArchived(progress: ArchivedProgressView): HistorySummary {
  const mandatory = [...new Set(progress.mandatoryTopicIds)];
  const topicsPassed = mandatory.filter((topicId) => progress.topics[topicId]?.passed).length;

  return {
    courseId: progress.courseId,
    version: progress.version,
    // `completedAt` es la fuente de verdad de la finalización; no se recalcula
    // por si un curso archivado venía de una versión con otras reglas.
    completed: progress.completedAt !== null,
    completedAt: progress.completedAt,
    archivedAt: progress.archivedAt,
    topicsPassed,
    topicsTotal: mandatory.length,
    finalScore: progress.finalExam.bestScore,
    finalExamPassed: progress.finalExam.passed,
  };
}

/**
 * Orden del historial: lo más reciente primero.
 *
 * Se ordena en memoria a propósito. La consulta a `progressHistory` filtra por
 * un solo campo (`uid`), que Firestore indexa solo; añadir `orderBy("archivedAt")`
 * exigiría un índice compuesto **nuevo**, y publicar índices es una operación
 * reservada. El volumen por persona es pequeño (una entrada por curso y versión).
 */
export function sortHistory<
  T extends {
    courseId: string;
    completedAt: string | null;
    archivedAt: string | null;
    version: number;
  },
>(entries: readonly T[]): T[] {
  const time = (entry: T) => {
    const value = entry.completedAt ?? entry.archivedAt;
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return [...entries].sort((a, b) => {
    const byDate = time(b) - time(a);
    if (byDate !== 0) return byDate;
    // Misma fecha (o ninguna): la versión más alta primero, para que el orden
    // sea determinista y no dependa del orden de lectura del almacén.
    if (a.version !== b.version) return b.version - a.version;
    return a.courseId.localeCompare(b.courseId, "es");
  });
}

/** Acepta tanto un `CourseProgress` completo como una versión recortada. */
export type ArchivedLike = ArchivedProgressView & Partial<Pick<CourseProgress, "courseId">>;
