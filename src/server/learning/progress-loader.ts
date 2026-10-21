import { initProgress, restartForVersion } from "@/domain/progress/course-progress";
import { requiresNewCompletion } from "@/domain/courses/versioning";
import type { LearningStore, StoredProgress } from "@/server/learning/store";

/**
 * CARGA DEL PROGRESO DE UN CURSO (compartido)
 * ==========================================
 *
 * Lo usan la corrección de evaluaciones y la lectura de PDF. Antes cada
 * servicio tenía su copia de esta lógica; unificarla evita que se comporten
 * distinto ante el mismo caso, que es justo lo que ocurre al publicar una
 * versión nueva.
 *
 * Si la versión publicada es mayor que la del progreso guardado:
 *   · se devuelve el progreso antiguo como `archive` (para el histórico),
 *   · se devuelve un progreso nuevo a cero para la versión publicada.
 *
 * El llamante decide cuándo persistir; aquí no se escribe nada.
 */
export async function loadOrInitProgress(input: {
  learning: LearningStore;
  uid: string;
  courseId: string;
  publishedVersion: number;
  mandatoryTopicIds: readonly string[];
  at: string;
}): Promise<{ progress: StoredProgress; archive: StoredProgress | null }> {
  const stored = await input.learning.getProgress(input.uid, input.courseId);

  if (!stored) {
    return {
      progress: {
        ...initProgress(input.courseId, input.publishedVersion, input.mandatoryTopicIds),
        uid: input.uid,
        documents: {},
        updatedAt: input.at,
      },
      archive: null,
    };
  }

  if (requiresNewCompletion(stored.version, input.publishedVersion)) {
    return {
      progress: {
        ...restartForVersion(stored, input.publishedVersion, input.mandatoryTopicIds),
        uid: input.uid,
        documents: {},
        updatedAt: input.at,
      },
      archive: stored,
    };
  }

  return { progress: stored, archive: null };
}
