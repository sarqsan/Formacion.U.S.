import type { Enrollment } from "@/domain/courses/enrollment";

/**
 * MATRÍCULAS (puerto de persistencia)
 * ==================================
 *
 *   enrollments/{uid}_{courseId}
 *
 * El cliente puede leer **solo su** matrícula (para saber qué cursos ve), pero
 * nunca escribirla. La escritura es exclusiva del servidor, tras comprobar que
 * el actor es administrador.
 */
export interface EnrollmentStore {
  get(uid: string, courseId: string): Promise<Enrollment | null>;

  /** Escritura atómica: crea o reactiva la matrícula. Idempotente. */
  upsert(enrollment: Enrollment): Promise<void>;

  /** Revoca sin borrar el histórico de progreso. */
  revoke(input: {
    uid: string;
    courseId: string;
    revokedAt: string;
    revokedBy: string;
  }): Promise<void>;

  listByUser(uid: string): Promise<Enrollment[]>;
  listByCourse(courseId: string): Promise<Enrollment[]>;
}
