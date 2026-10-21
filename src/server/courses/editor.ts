import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  EMPTY_COURSE_TEMPLATE,
  emptyCourseDefinition,
  type CourseTemplateId,
} from "@/domain/courses/template";
import type { CourseSummary } from "@/server/courses/catalog";

/**
 * CREACIÓN DE CURSOS (cimientos del ciclo de vida)
 * ================================================
 *
 * Un curso recién creado es un curso **sin versiones**:
 *
 *   courses/{courseId} = { publishedVersion: null, lastDraftVersion: null, … }
 *
 * No se crea una versión ficticia y no se exige que el curso tenga contenido ni
 * que esté publicado: eso llegará al guardar el primer borrador (bloque
 * posterior). Crear es solo reservar la ficha del curso con su identificador.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO HAY TRANSACCIÓN NI LOTE
 * ---------------------------------------------------------------------------
 * Crear un curso escribe **un único documento**. Una escritura individual en
 * Firestore ya es atómica: o entra entera o no entra. No hay estado intermedio
 * posible, así que una transacción no aportaría nada y un lote tampoco.
 *
 * Lo que sí hay que garantizar es que crear **no sobrescriba** un curso que ya
 * existe (perdería su contenido y su historial). Para eso el adaptador usa
 * `DocumentReference.create()`, que falla con ALREADY_EXISTS si el documento
 * existe, y traduce el error a `COURSE_ALREADY_EXISTS` (409). Con `set()` una
 * segunda petición concurrente habría reemplazado el curso.
 *
 * Cuando un bloque posterior cree la versión 1 junto con el curso, serán dos
 * escrituras y ahí sí hará falta una transacción: se decidirá con la misma
 * regla (leer antes de escribir, sin dejar el curso apuntando a algo que no
 * existe).
 */

/** Puerto de persistencia: solo lo que la creación necesita. */
export interface CourseEditorStore {
  /** Crea la ficha del curso. Si ya existe, falla con `COURSE_ALREADY_EXISTS`. */
  createCourse(summary: CourseSummary & { createdAt: string; createdBy: string }): Promise<void>;
  getCourse(courseId: string): Promise<CourseSummary | null>;
}

export interface CourseEditorDependencies {
  store: CourseEditorStore;
  now?: () => Date;
}

export interface CreateCourseInput {
  courseId: string;
  title: string;
  description?: string;
  /** Solo se admite la plantilla vacía; el tipo deja sitio a las siguientes. */
  template?: CourseTemplateId;
  actor: Actor;
}

export interface CreateCourseResult {
  courseId: string;
  title: string;
  publishedVersion: null;
  lastDraftVersion: null;
}

/**
 * Crea un curso vacío a partir de una plantilla.
 *
 * Solo administradores. El identificador se valida con la misma regla que usa
 * la validación de contenido (`isSlug`), para no poder crear un curso que
 * después ninguna versión podría guardar.
 */
export async function createCourse(
  input: CreateCourseInput,
  deps: CourseEditorDependencies,
): Promise<CreateCourseResult> {
  const admin = assertAdmin(input.actor);

  const template = input.template ?? EMPTY_COURSE_TEMPLATE;
  if (template !== EMPTY_COURSE_TEMPLATE) {
    throw new DomainError(
      "COURSE_TEMPLATE_UNKNOWN",
      "Esa plantilla de curso no existe.",
      400,
    );
  }

  // La plantilla vacía valida el identificador y el título (y nada más: no
  // exige temas ni examen, porque no es una definición publicable).
  const definition = emptyCourseDefinition({
    courseId: input.courseId,
    title: input.title,
    description: input.description,
  });

  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();

  const summary: CourseSummary & { createdAt: string; createdBy: string } = {
    courseId: definition.courseId,
    title: definition.title,
    publishedVersion: null,
    lastDraftVersion: null,
    createdAt,
    createdBy: admin.uid,
  };

  await deps.store.createCourse(summary);

  return {
    courseId: summary.courseId,
    title: summary.title,
    publishedVersion: null,
    lastDraftVersion: null,
  };
}
