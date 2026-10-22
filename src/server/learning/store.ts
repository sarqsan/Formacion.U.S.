import type { CourseProgress } from "@/domain/progress/course-progress";
import type { DocumentReadProgress } from "@/domain/progress/reading";

/**
 * PROGRESO E INTENTOS (puertos)
 * =============================
 *
 * Un único documento de progreso por usuario y curso:
 *
 *   progress/{uid}_{courseId}
 *
 * Contiene el estado de la versión que el usuario está cursando. Cuando se
 * publica una versión nueva, el documento antiguo se archiva en
 * `progressHistory/{uid}_{courseId}_v{n}` y se empieza uno nuevo. Así se
 * cumple "una versión nueva obliga a repetir el curso" sin perder historial.
 *
 * Los intentos (`attempts`) son inmutables: son la prueba de qué contestó el
 * usuario y cómo se corrigió. Nunca se actualizan ni se borran desde la
 * aplicación.
 */

export interface StoredProgress extends CourseProgress {
  uid: string;
  /** Documentos leídos, por id de documento (control secuencial). */
  documents: Record<string, DocumentReadProgress>;
  updatedAt: string;
}

/**
 * Progreso de una versión anterior, tal y como quedó archivado.
 *
 * `archivedAt` lo pone el almacén al mover el documento (es la fecha en que se
 * publicó la versión siguiente, no la de la última actividad).
 */
export interface ArchivedProgress extends StoredProgress {
  archivedAt: string | null;
}

export interface AttemptRecord {
  uid: string;
  courseId: string;
  version: number;
  assessmentType: "topic" | "final";
  topicId: string | null;
  answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
  passed: boolean;
  correctCount: number;
  totalQuestions: number;
  score: number;
  at: string;
  /** Siempre "server": recuerda que la corrección no vino del cliente. */
  gradedBy: "server";
}

export interface LearningStore {
  getProgress(uid: string, courseId: string): Promise<StoredProgress | null>;

  /**
   * Escritura atómica del intento y del progreso resultante.
   * Si hay que archivar una versión anterior, se hace en la misma transacción.
   */
  commitAttempt(input: {
    attempt: AttemptRecord;
    progress: StoredProgress;
    archive: StoredProgress | null;
  }): Promise<void>;

  /**
   * Guarda el progreso. Si `archive` no es nulo, archiva el progreso anterior
   * en la misma operación (lectura de PDF tras publicarse una versión nueva).
   */
  saveProgress(progress: StoredProgress, archive?: StoredProgress | null): Promise<void>;

  listProgressByCourse(
    courseId: string,
    version: number,
  ): Promise<Array<Pick<StoredProgress, "uid" | "completedAt" | "version">>>;

  listProgressByUser(uid: string): Promise<StoredProgress[]>;

  /**
   * Histórico de versiones anteriores de un usuario, de todas sus formaciones.
   *
   * Contrato: devuelve lo archivado, **incluido lo que quedó a medias** (un
   * histórico que solo muestra aprobados no responde «qué había»). Sin orden
   * garantizado por la implementación: el orden lo fija `sortHistory`, para que
   * Firestore y la demostración se comporten igual sin depender de un índice
   * compuesto.
   */
  listArchivedProgress(uid: string): Promise<ArchivedProgress[]>;

  listAttemptsByUser(uid: string): Promise<AttemptRecord[]>;

  listAttemptsByCourse(courseId: string, version: number): Promise<AttemptRecord[]>;
}
