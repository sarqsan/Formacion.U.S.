import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import { isSlug } from "@/domain/courses/content";
import type { CourseVersionStatus } from "@/domain/courses/versioning";

/**
 * ELIMINAR UN CURSO
 * =================
 *
 * Borrar un curso es la única operación del panel que destruye datos, así que
 * está escrita al revés que las demás: primero comprueba **todas** las razones
 * para no borrar y solo después borra. Las reglas:
 *
 *   · solo administración;
 *   · hay que escribir el identificador del curso para confirmar (un botón
 *     «eliminar» al lado del título se pulsa por error; un campo de texto con
 *     el identificador, no);
 *   · **nunca** un curso con una versión publicada o archivada: eso es
 *     contenido que personas han cursado y del que cuelgan progreso, intentos y
 *     certificados. Un curso publicado se deja de ofrecer, no se borra;
 *   · **nunca** si hay matrículas, progreso, intentos o certificados, aunque el
 *     curso esté en borrador: borrarlo dejaría documentos huérfanos apuntando a
 *     un curso que ya no existe.
 *
 * Lo que sí se borra, y de una vez: la ficha del curso, sus versiones en
 * borrador, sus claves de corrección y los PDF que solo usaba este curso (con
 * sus fragmentos y devolviendo el espacio a la cuota). Nada queda a medias.
 *
 * El borrado se anota en el registro de actividad: la operación desaparece los
 * datos, no el rastro de que alguien los borró.
 */

/** Ficha mínima para decidir; no hace falta el contenido. */
export interface DeletableCourse {
  courseId: string;
  title: string;
  publishedVersion: number | null;
  lastDraftVersion: number | null;
}

/** Lo que el servicio necesita del almacén. */
export interface CourseDeletionStore {
  getCourse(courseId: string): Promise<DeletableCourse | null>;
  /** Versiones con su estado: publicada o archivada bloquea el borrado. */
  listVersions(courseId: string): Promise<Array<{ version: number; status: CourseVersionStatus }>>;
  /** Documentos de cualquier versión y tema del curso. */
  listCourseDocumentIds(courseId: string): Promise<string[]>;
  countEnrollments(courseId: string): Promise<number>;
  countProgress(courseId: string): Promise<number>;
  countAttempts(courseId: string): Promise<number>;
  countCertificates(courseId: string): Promise<number>;
  /**
   * Borra la ficha, sus versiones, sus claves y sus documentos.
   *
   * Contrato: si algo falla a mitad, **no** deja el curso apuntando a versiones
   * que ya no existen ni fragmentos sin metadatos; el adaptador borra por lotes
   * y la ficha del curso va la última, para que un fallo deje un curso
   * borrable de nuevo y no un fantasma.
   */
  deleteCourse(input: {
    courseId: string;
    versions: number[];
    documentIds: string[];
  }): Promise<void>;
}

export interface CourseDeletionAudit {
  record(event: {
    type: "course_deleted";
    actorUid: string;
    at: string;
    courseId: string;
    courseTitle: string;
    versions: number;
    documents: number;
  }): Promise<void>;
}

export interface CourseDeletionDependencies {
  store: CourseDeletionStore;
  audit?: CourseDeletionAudit;
  now?: () => Date;
}

export interface DeleteCourseInput {
  actor: Actor;
  courseId: string;
  /** Lo que la persona escribió en el campo de confirmación. */
  confirmation: string;
}

export interface DeleteCourseResult {
  courseId: string;
  versions: number;
  documents: number;
}

/**
 * Borra un curso en borrador y todo lo que colgaba solo de él.
 *
 * Devuelve cuántas versiones y documentos se han borrado, que es lo que la
 * pantalla necesita para decir «hecho» sin adornos.
 */
export async function deleteCourse(
  input: DeleteCourseInput,
  deps: CourseDeletionDependencies,
): Promise<DeleteCourseResult> {
  const admin = assertAdmin(input.actor);

  const courseId = input.courseId.trim();
  if (!isSlug(courseId)) {
    throw new DomainError("COURSE_ID_INVALID", "Identificador de curso no válido.", 400);
  }

  // Confirmación escrita: se compara con el identificador ya normalizado. Un
  // espacio de más no invalida; una palabra distinta, sí.
  if (input.confirmation.trim() !== courseId) {
    throw new DomainError(
      "COURSE_DELETE_CONFIRMATION",
      `Para eliminar el curso, escribe su identificador exacto («${courseId}») en el campo de confirmación.`,
      400,
    );
  }

  const course = await deps.store.getCourse(courseId);
  if (!course) {
    throw new DomainError("COURSE_NOT_FOUND", "Ese curso no existe.", 404);
  }

  const versions = await deps.store.listVersions(courseId);
  const published =
    course.publishedVersion !== null || versions.some((version) => version.status !== "draft");
  if (published) {
    throw new DomainError(
      "COURSE_DELETE_PUBLISHED",
      "Este curso tiene una versión publicada o archivada: hay personas que lo han cursado y de él cuelgan progreso, intentos y certificados. No se puede eliminar. Para dejar de ofrecerlo, retíralo del catálogo con una versión nueva.",
      409,
    );
  }

  const [enrollments, progress, attempts, certificates] = await Promise.all([
    deps.store.countEnrollments(courseId),
    deps.store.countProgress(courseId),
    deps.store.countAttempts(courseId),
    deps.store.countCertificates(courseId),
  ]);

  if (enrollments > 0) {
    throw new DomainError(
      "COURSE_DELETE_ENROLLED",
      "Hay personas matriculadas en este curso, aunque no esté publicado. Anula antes sus matrículas: borrar el curso las dejaría apuntando a algo inexistente.",
      409,
    );
  }

  if (progress > 0 || attempts > 0 || certificates > 0) {
    throw new DomainError(
      "COURSE_DELETE_IN_USE",
      "Este curso tiene progreso, intentos o certificados asociados. No se puede eliminar: el histórico del alumnado quedaría roto.",
      409,
    );
  }

  const documentIds = await deps.store.listCourseDocumentIds(courseId);
  const versionNumbers = versions.map((version) => version.version);

  await deps.store.deleteCourse({ courseId, versions: versionNumbers, documentIds });

  if (deps.audit) {
    const at = (deps.now?.() ?? new Date()).toISOString();
    await deps.audit.record({
      type: "course_deleted",
      actorUid: admin.uid,
      at,
      courseId,
      courseTitle: course.title,
      versions: versionNumbers.length,
      documents: documentIds.length,
    });
  }

  return {
    courseId,
    versions: versionNumbers.length,
    documents: documentIds.length,
  };
}
