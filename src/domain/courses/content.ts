import { DomainError } from "@/domain/text";
import {
  validateQuizDefinition,
  type QuizQuestionDefinition,
} from "@/domain/assessments/scoring";

/**
 * MODELO DE CONTENIDO (autoría del administrador)
 * ==============================================
 *
 * Un curso publicado es INMUTABLE. Editar contenido significa crear una
 * versión nueva en borrador y publicarla, lo que obliga a repetir el curso.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface TopicDocumentDefinition {
  id: string;
  title: string;
  /** Nº de páginas conocido al subir el PDF; base del control secuencial. */
  pageCount: number;
}

export interface TopicDefinition {
  id: string;
  title: string;
  /** Orden de presentación (1..n), sin huecos ni repetidos. */
  order: number;
  /** Si es false, no bloquea el examen final. */
  mandatory: boolean;
  documents: TopicDocumentDefinition[];
  /** Cuestionario del tema; obligatorio si el tema es obligatorio. */
  quiz: QuizQuestionDefinition[];
}

export interface CourseVersionDefinition {
  courseId: string;
  version: number;
  title: string;
  description?: string;
  topics: TopicDefinition[];
  finalExam: QuizQuestionDefinition[];
}

export interface ContentIssue {
  code: string;
  message: string;
  path: string;
}

/**
 * Valida el contenido de una versión y devuelve TODOS los problemas de una vez
 * (el panel de administración los muestra juntos en lugar de uno por intento).
 */
export function validateCourseVersion(definition: CourseVersionDefinition): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const add = (code: string, message: string, path: string) =>
    issues.push({ code, message, path });

  if (!SLUG_PATTERN.test(definition.courseId)) {
    add("COURSE_ID_INVALID", "Identificador de curso no válido.", "courseId");
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    add("VERSION_INVALID", "La versión debe ser un entero mayor o igual que 1.", "version");
  }
  if (!definition.title?.trim()) {
    add("COURSE_TITLE_REQUIRED", "El curso necesita un título.", "title");
  }

  if (definition.topics.length === 0) {
    add("COURSE_NO_TOPICS", "El curso debe tener al menos un tema.", "topics");
  }

  const topicIds = new Set<string>();
  const orders = new Set<number>();
  const documentIds = new Set<string>();
  let mandatoryCount = 0;

  definition.topics.forEach((topic, index) => {
    const path = `topics[${index}]`;

    if (!SLUG_PATTERN.test(topic.id)) {
      add("TOPIC_ID_INVALID", "Identificador de tema no válido.", `${path}.id`);
    }
    if (topicIds.has(topic.id)) {
      add("TOPIC_ID_DUPLICATED", `Tema repetido: ${topic.id}.`, `${path}.id`);
    }
    topicIds.add(topic.id);

    if (!topic.title?.trim()) {
      add("TOPIC_TITLE_REQUIRED", "El tema necesita un título.", `${path}.title`);
    }

    if (!Number.isInteger(topic.order) || topic.order < 1) {
      add("TOPIC_ORDER_INVALID", "El orden del tema debe ser un entero mayor o igual que 1.", `${path}.order`);
    } else if (orders.has(topic.order)) {
      add("TOPIC_ORDER_DUPLICATED", `Orden de tema repetido: ${topic.order}.`, `${path}.order`);
    }
    orders.add(topic.order);

    if (topic.mandatory) mandatoryCount += 1;

    topic.documents.forEach((document, documentIndex) => {
      const documentPath = `${path}.documents[${documentIndex}]`;
      if (!SLUG_PATTERN.test(document.id)) {
        add("DOCUMENT_ID_INVALID", "Identificador de documento no válido.", `${documentPath}.id`);
      }
      if (documentIds.has(document.id)) {
        add("DOCUMENT_ID_DUPLICATED", `Documento repetido: ${document.id}.`, `${documentPath}.id`);
      }
      documentIds.add(document.id);
      if (!document.title?.trim()) {
        add("DOCUMENT_TITLE_REQUIRED", "El documento necesita un título.", `${documentPath}.title`);
      }
      if (!Number.isInteger(document.pageCount) || document.pageCount < 1) {
        add(
          "DOCUMENT_PAGE_COUNT_INVALID",
          "El documento debe indicar un número de páginas válido.",
          `${documentPath}.pageCount`,
        );
      }
    });

    if (topic.mandatory && topic.quiz.length === 0) {
      add("TOPIC_QUIZ_REQUIRED", "Un tema obligatorio debe tener cuestionario.", `${path}.quiz`);
    }

    if (topic.quiz.length > 0) {
      try {
        validateQuizDefinition(topic.quiz);
      } catch (error) {
        add(
          "TOPIC_QUIZ_INVALID",
          error instanceof DomainError ? error.message : "Cuestionario no válido.",
          `${path}.quiz`,
        );
      }
    }
  });

  if (definition.topics.length > 0 && mandatoryCount === 0) {
    add("COURSE_NO_MANDATORY_TOPICS", "Debe haber al menos un tema obligatorio.", "topics");
  }

  // Órdenes sin huecos ni repeticiones: exactamente 1..n.
  const sortedOrders = [...orders]
    .filter((order) => Number.isInteger(order) && order >= 1)
    .sort((a, b) => a - b);

  for (let index = 0; index < definition.topics.length; index += 1) {
    if (sortedOrders[index] !== index + 1) {
      add(
        "TOPIC_ORDER_GAP",
        `El orden de temas debe ser consecutivo desde 1 (falta el ${index + 1}).`,
        "topics",
      );
      break;
    }
  }

  if (definition.finalExam.length === 0) {
    add("FINAL_EXAM_REQUIRED", "El curso necesita un examen final.", "finalExam");
  } else {
    try {
      validateQuizDefinition(definition.finalExam);
    } catch (error) {
      add(
        "FINAL_EXAM_INVALID",
        error instanceof DomainError ? error.message : "Examen final no válido.",
        "finalExam",
      );
    }
  }

  return issues;
}

export function assertValidCourseVersion(definition: CourseVersionDefinition): void {
  const issues = validateCourseVersion(definition);
  if (issues.length > 0) {
    throw new DomainError("COURSE_CONTENT_INVALID", issues[0].message, 400, { issues });
  }
}

export function mandatoryTopicIds(definition: CourseVersionDefinition): string[] {
  return [...definition.topics]
    .filter((topic) => topic.mandatory)
    .sort((a, b) => a.order - b.order)
    .map((topic) => topic.id);
}

export function orderedTopics(definition: CourseVersionDefinition): TopicDefinition[] {
  return [...definition.topics].sort((a, b) => a.order - b.order);
}
