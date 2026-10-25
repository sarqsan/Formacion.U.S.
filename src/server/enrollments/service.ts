import { DomainError } from "@/domain/text";
import { assertAdmin, isUsable, type Actor } from "@/domain/auth/authorization";
import {
  assertEnrollmentSegment,
  enrollmentDocId,
  isEnrollmentActive,
  type Enrollment,
} from "@/domain/courses/enrollment";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import type { EnrollmentStore } from "@/server/enrollments/store";

/**
 * MATRÍCULAS (servicios)
 * ======================
 *
 *   · matricular y revocar: solo administradores activos.
 *   · comprobar acceso: cualquier actor, contra la base de datos.
 *
 * `assertCourseAccess` es la única puerta que deben usar los servicios que
 * sirven contenido de un curso. No acepta un `courseId` "de confianza" del
 * cliente sin comprobarlo: si no hay matrícula activa, deniega.
 */

export interface EnrollmentDependencies {
  enrollments: EnrollmentStore;
  catalog: CourseCatalogStore;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Consulta de acceso
// ---------------------------------------------------------------------------

/**
 * ¿Tiene este actor acceso a este curso?
 *
 * Un administrador entra en cualquier curso (gestiona el contenido). Cualquier
 * otro rol necesita matrícula **activa**. Un curso sin publicar no es accesible
 * para un alumno aunque tenga matrícula: no hay contenido que estudiar.
 */
export async function hasCourseAccess(
  actor: Actor,
  courseId: string,
  deps: Pick<EnrollmentDependencies, "enrollments" | "catalog">,
): Promise<boolean> {
  // Cinturón y tirantes: el actor llega de `requireActor`, que ya descarta
  // cuentas no activas, pero aquí no se da por bueno ningún actor que no lo sea.
  if (!isUsable(actor)) return false;
  if (actor.role === "admin") return true;

  const enrollment = await deps.enrollments.get(actor.uid, courseId);
  if (!isEnrollmentActive(enrollment)) return false;

  const course = await deps.catalog.getCourse(courseId);
  return Boolean(course && course.publishedVersion !== null);
}

/**
 * Deniega por defecto. Lanza 403 con un mensaje que **no revela** si el curso
 * existe, si está publicado ni cuántos alumnos tiene: un no matriculado no debe
 * poder enumerar cursos.
 */
export async function assertCourseAccess(
  actor: Actor,
  courseId: string,
  deps: Pick<EnrollmentDependencies, "enrollments" | "catalog">,
): Promise<void> {
  if (await hasCourseAccess(actor, courseId, deps)) return;

  throw new DomainError(
    "COURSE_NOT_AUTHORIZED",
    "No tienes acceso a este curso. Si crees que es un error, avisa a administración.",
    403,
  );
}

// ---------------------------------------------------------------------------
// Altas y bajas (administración)
// ---------------------------------------------------------------------------

export interface EnrollInput {
  actor: Actor;
  uid: string;
  courseId: string;
}

export async function enrollStudent(
  input: EnrollInput,
  deps: EnrollmentDependencies,
): Promise<Enrollment> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();

  assertEnrollmentSegment(input.courseId, "courseId");
  enrollmentDocId(input.uid, input.courseId);

  const course = await deps.catalog.getCourse(input.courseId);
  if (!course) {
    throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
  }

  const existing = await deps.enrollments.get(input.uid, input.courseId);

  const enrollment: Enrollment = {
    uid: input.uid,
    courseId: input.courseId,
    // Matricular a quien ya estaba activo es idempotente: no cambia fechas.
    status: "active",
    version: course.publishedVersion,
    enrolledAt: existing?.enrolledAt ?? at,
    enrolledBy: existing?.enrolledBy ?? admin.uid,
    updatedAt: at,
  };

  await deps.enrollments.upsert(enrollment);
  return enrollment;
}

export async function revokeEnrollment(
  input: EnrollInput,
  deps: EnrollmentDependencies,
): Promise<void> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();

  assertEnrollmentSegment(input.courseId, "courseId");
  const existing = await deps.enrollments.get(input.uid, input.courseId);
  if (!existing) {
    throw new DomainError("ENROLLMENT_NOT_FOUND", "Esa matrícula no existe.", 404);
  }

  await deps.enrollments.revoke({
    uid: input.uid,
    courseId: input.courseId,
    revokedAt: now.toISOString(),
    revokedBy: admin.uid,
  });
}

/**
 * Matriculación en bloque.
 *
 * Motivo concreto: `/admin/matriculas` matriculaba de una en una, así que dar de
 * alta a un curso entero eran decenas de clics con su espera entre cada uno.
 *
 * Propiedades:
 *
 *   · **Un solo `assertAdmin`** para todo el lote, y luego el mismo
 *     `enrollStudent` de siempre para cada persona: no hay una segunda versión
 *     de la regla de matriculación que pueda desviarse.
 *   · **Idempotente**: quien ya estaba matriculado no cambia de fecha ni
 *     duplica nada; se informa aparte de cuántas eran nuevas.
 *   · **Nunca falla en silencio ni a medias sin decirlo**: si una persona
 *     concreta falla, se recoge el motivo y se sigue con el resto. El resumen
 *     dice exactamente qué pasó con cada una.
 *   · **No vacía ni revoca nada**: matricular de más no quita matrículas.
 */
export interface BulkEnrollResult {
  courseId: string;
  /** Personas distintas recibidas (tras quitar huecos y repetidos). */
  requested: number;
  /** Se han matriculado ahora. */
  enrolled: string[];
  /** Ya estaban activas: no se ha tocado nada. */
  already: string[];
  failed: Array<{ uid: string; message: string }>;
}

/** Tope defensivo: un lote gigante no debe tumbar la función desplegada. */
export const MAX_BULK_ENROLL = 500;

export async function enrollMany(
  input: { actor: Actor; courseId: string; uids: readonly unknown[] },
  deps: EnrollmentDependencies,
): Promise<BulkEnrollResult> {
  const admin = assertAdmin(input.actor);
  assertEnrollmentSegment(input.courseId, "courseId");

  const course = await deps.catalog.getCourse(input.courseId);
  if (!course) {
    throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
  }

  const uids = [
    ...new Set(
      input.uids
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0),
    ),
  ];

  if (uids.length === 0) {
    throw new DomainError("ENROLLMENT_NOTHING_TO_DO", "No hay ninguna persona que matricular.", 400);
  }
  if (uids.length > MAX_BULK_ENROLL) {
    throw new DomainError(
      "ENROLLMENT_TOO_LARGE",
      `Como máximo se pueden matricular ${MAX_BULK_ENROLL} personas de una vez.`,
      400,
    );
  }

  const result: BulkEnrollResult = {
    courseId: input.courseId,
    requested: uids.length,
    enrolled: [],
    already: [],
    failed: [],
  };

  for (const uid of uids) {
    const existing = await deps.enrollments.get(uid, input.courseId);
    if (existing && isEnrollmentActive(existing)) {
      result.already.push(uid);
      continue;
    }

    try {
      await enrollStudent({ actor: admin, uid, courseId: input.courseId }, deps);
      result.enrolled.push(uid);
    } catch (error) {
      result.failed.push({
        uid,
        message:
          error instanceof DomainError
            ? error.message
            : "No se ha podido matricular a esta persona.",
      });
    }
  }

  return result;
}
