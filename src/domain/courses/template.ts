import { DomainError } from "@/domain/text";
import { isSlug, type CourseVersionDefinition, type TopicDefinition } from "@/domain/courses/content";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";

/**
 * PLANTILLAS DE CURSO
 * ===================
 *
 * Un curso se crea **vacío**: existe el curso, no existe ninguna versión. La
 * primera versión se guardará como borrador en un bloque posterior, y hasta
 * entonces no hay nada que publicar ni que validar.
 *
 * De ahí las dos piezas de este módulo:
 *
 *   - `emptyCourseDefinition`: la definición mínima (sin temas, sin examen) que
 *     el editor usará como punto de partida. **No valida para publicar**: eso
 *     es deliberado. El borrador incompleto es un estado legítimo y se guarda
 *     sin problema; la puerta de publicación sigue siendo
 *     `validateCourseVersion`, que no se ha relajado.
 *   - `cloneVersionAsDraft`: copia **profunda** de una versión para preparar la
 *     siguiente. No comparte ni un array ni un objeto con el original (editarla
 *     no puede tocar lo publicado) y no arrastra fechas ni autoría: los
 *     metadatos de la copia los fija `draftMetadata` con el reloj y el actor de
 *     la operación actual.
 *
 * Invariante que sostienen las pruebas: modificar la copia no cambia el
 * original, ni al revés, en ningún nivel de anidamiento.
 */

export const EMPTY_COURSE_TEMPLATE = "empty" as const;

export type CourseTemplateId = typeof EMPTY_COURSE_TEMPLATE;

export interface EmptyCourseDefinitionInput {
  courseId: string;
  title: string;
  description?: string;
  /** Número de versión que tendrá el borrador; por defecto, la 1. */
  version?: number;
}

/**
 * Definición inicial de un curso sin contenido.
 *
 * `version` vale 1 salvo que se indique otra (un curso que ya tuvo versiones
 * empieza su borrador en la siguiente). **No se persiste aquí**: crear el curso
 * no crea ninguna versión; guardar el borrador es otra operación.
 */
export function emptyCourseDefinition(input: EmptyCourseDefinitionInput): CourseVersionDefinition {
  const courseId = input.courseId.trim();
  const title = input.title.trim();

  if (!isSlug(courseId)) {
    throw new DomainError(
      "COURSE_ID_INVALID",
      "El identificador del curso solo admite minúsculas, números y guiones (máximo 64 caracteres).",
      400,
    );
  }
  if (!title) {
    throw new DomainError("COURSE_TITLE_REQUIRED", "El curso necesita un título.", 400);
  }

  const description = input.description?.trim();
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      "VERSION_INVALID",
      "La versión debe ser un entero mayor o igual que 1.",
      400,
    );
  }

  return {
    courseId,
    version,
    title,
    ...(description ? { description } : {}),
    topics: [],
    finalExam: [],
  };
}

export interface DraftMetadata {
  status: "draft";
  createdAt: string;
  createdBy: string;
  publishedAt: null;
  publishedBy: null;
}

/**
 * Metadatos de un borrador nuevo.
 *
 * Nunca se copian de la versión de origen: una versión nueva se creó ahora, por
 * quien está operando ahora, y no está publicada.
 */
export function draftMetadata(now: Date, actorUid: string): DraftMetadata {
  if (!actorUid) {
    throw new DomainError("UNAUTHENTICATED", "Sesión no válida.", 401);
  }
  return {
    status: "draft",
    createdAt: now.toISOString(),
    createdBy: actorUid,
    publishedAt: null,
    publishedBy: null,
  };
}

export interface CloneVersionInput {
  /** Número de la versión nueva (la siguiente libre). */
  version: number;
  /** Título de la copia; por defecto, el del origen. */
  title?: string;
  /** Curso destino; por defecto, el del origen (clonar dentro del mismo curso). */
  courseId?: string;
}

/** Copia profunda de una pregunta. Nunca devuelve el mismo objeto. */
function cloneQuestion(question: QuizQuestionDefinition): QuizQuestionDefinition {
  return {
    id: question.id,
    type: question.type,
    optionIds: [...question.optionIds],
    correctOptionIds: [...question.correctOptionIds],
    ...(question.prompt === undefined ? {} : { prompt: question.prompt }),
    ...(question.optionLabels === undefined
      ? {}
      : { optionLabels: { ...question.optionLabels } }),
  };
}

function cloneTopic(topic: TopicDefinition): TopicDefinition {
  return {
    id: topic.id,
    title: topic.title,
    order: topic.order,
    mandatory: topic.mandatory,
    documents: topic.documents.map((document) => ({ ...document })),
    quiz: topic.quiz.map(cloneQuestion),
  };
}

/**
 * Copia una definición para preparar un borrador nuevo.
 *
 * Es una reconstrucción campo a campo, no un `structuredClone` genérico: así el
 * compilador obliga a revisar el clon cuando se añada un campo nuevo a la
 * definición. Esa es justo la clase de olvido que compartiría referencias.
 */
export function cloneVersionAsDraft(
  source: CourseVersionDefinition,
  input: CloneVersionInput,
): CourseVersionDefinition {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new DomainError(
      "VERSION_INVALID",
      "La versión debe ser un entero mayor o igual que 1.",
      400,
    );
  }

  const courseId = (input.courseId ?? source.courseId).trim();
  if (!isSlug(courseId)) {
    throw new DomainError("COURSE_ID_INVALID", "Identificador de curso no válido.", 400);
  }

  const title = (input.title ?? source.title).trim();

  return {
    courseId,
    version: input.version,
    title,
    ...(source.description === undefined ? {} : { description: source.description }),
    topics: source.topics.map(cloneTopic),
    finalExam: source.finalExam.map(cloneQuestion),
  };
}
