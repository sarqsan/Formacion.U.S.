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
