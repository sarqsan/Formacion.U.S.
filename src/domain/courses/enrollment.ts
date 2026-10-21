import { DomainError } from "@/domain/text";

/**
 * MATRÍCULAS (dominio)
 * ====================
 *
 * Hasta la fase 5, "curso publicado" significaba "accesible para cualquier
 * cuenta activa". Eso permitía que un alumno de un curso leyera los PDF y los
 * cuestionarios de otro. Aquí se introduce la relación explícita:
 *
 *     enrollments/{uid}_{courseId}
 *
 * Reglas de negocio:
 *   - Publicar un curso **no** matricula a nadie.
 *   - Un administrador matricula y revoca; el alumno no puede matricularse.
 *   - Revocar no borra el progreso: solo quita el acceso. Si se vuelve a
 *     matricular, el progreso sigue donde estaba.
 *   - El acceso se comprueba **siempre en el servidor** con el actor de la
 *     sesión; nunca con datos que envíe el cliente.
 *   - Denegar por defecto: sin matrícula (o con matrícula no activa) no hay
 *     acceso, aunque el curso esté publicado.
 */

export const ENROLLMENT_STATUSES = ["active", "revoked"] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export interface Enrollment {
  uid: string;
  courseId: string;
  status: EnrollmentStatus;
  /** Versión publicada en el momento de matricular; informativo. */
  version: number | null;
  enrolledAt: string;
  enrolledBy: string;
  updatedAt: string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertEnrollmentSegment(value: string, field: string): void {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    throw new DomainError(
      "ENROLLMENT_ID_INVALID",
      `Identificador no válido para la matrícula (${field}).`,
      400,
    );
  }
}

/** Id estable y predecible: una matrícula por usuario y curso. */
export function enrollmentDocId(uid: string, courseId: string): string {
  if (typeof uid !== "string" || uid.length < 6 || uid.length > 128) {
    throw new DomainError("ENROLLMENT_ID_INVALID", "Identificador de usuario no válido.", 400);
  }
  assertEnrollmentSegment(courseId, "courseId");
  return `${uid}_${courseId}`;
}

/**
 * ¿Da esta matrícula acceso al curso?
 *
 * Se exige `status === "active"` de forma explícita: cualquier otro valor
 * (incluido `undefined` o un estado inventado) deniega.
 */
export function isEnrollmentActive(
  enrollment: Pick<Enrollment, "status"> | null | undefined,
): boolean {
  return Boolean(enrollment && enrollment.status === "active");
}

/** Validación del documento tal y como se escribe en Firestore. */
export function assertValidEnrollment(value: unknown): Enrollment {
  if (typeof value !== "object" || value === null) {
    throw new DomainError("ENROLLMENT_INVALID", "Matrícula no válida.", 500);
  }
  const record = value as Record<string, unknown>;

  for (const field of ["uid", "courseId", "enrolledAt", "enrolledBy", "updatedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).trim() === "") {
      throw new DomainError(
        "ENROLLMENT_INVALID",
        `La matrícula no tiene el campo obligatorio «${field}».`,
        500,
      );
    }
  }

  if (!ENROLLMENT_STATUSES.includes(record.status as EnrollmentStatus)) {
    throw new DomainError("ENROLLMENT_INVALID", "Estado de matrícula no válido.", 500);
  }

  if (record.version !== null && !(typeof record.version === "number" && record.version >= 1)) {
    throw new DomainError("ENROLLMENT_INVALID", "Versión de matrícula no válida.", 500);
  }

  return {
    uid: record.uid as string,
    courseId: record.courseId as string,
    status: record.status as EnrollmentStatus,
    version: (record.version as number | null) ?? null,
    enrolledAt: record.enrolledAt as string,
    enrolledBy: record.enrolledBy as string,
    updatedAt: record.updatedAt as string,
  };
}
