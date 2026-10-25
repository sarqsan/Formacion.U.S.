import type { CourseVersionDefinition, TopicDefinition } from "@/domain/courses/content";
import { isSlug } from "@/domain/courses/content";
import { normalizeScreens } from "@/domain/courses/screens";
import { reviewDraftQuizzes } from "@/domain/courses/quiz-draft";

/**
 * BORRADOR: QUÉ SE PUEDE GUARDAR Y QUÉ FALTA PARA PUBLICAR
 * ======================================================
 *
 * Hay tres niveles de exigencia y aquí viven los dos primeros. No se mezclan
 * a propósito:
 *
 *   1. ESTRUCTURA (este fichero, `checkDraftStructure`): lo mínimo para que el
 *      documento guardado sea coherente y legible. Si falla, no se guarda.
 *   2. AVISOS (`reviewDraft`): todo lo que **impide publicar** hoy, más lo que
 *      conviene revisar aunque no bloquee. Se muestran, no bloquean el guardado.
 *   3. PUBLICACIÓN: `validateCourseVersion` (sin tocar). Es la puerta dura y
 *      sigue rechazando un curso sin temas, sin tema obligatorio con
 *      cuestionario o sin examen final.
 *
 * Consecuencia buscada: un borrador vacío o a medias **se guarda** (porque no
 * tiene ningún error de estructura) y a la vez se ve, sin ambigüedad, que no es
 * publicable.
 */

/** Límites de tamaño y forma del contenido editable. */
export const DRAFT_LIMITS = {
  courseTitle: 200,
  courseDescription: 500,
  topicTitle: 200,
  topics: 50,
  /** Tope del documento de versión: 1 MiB por documento en Firestore. */
  definitionBytes: 800 * 1024,
} as const;

export type DraftIssueSeverity = "error" | "warning";

export interface DraftIssue {
  code: string;
  message: string;
  path: string;
  severity: DraftIssueSeverity;
}

/**
 * Errores que impiden guardar.
 *
 * Todo lo que se comprueba aquí es forma, no contenido: identificadores,
 * longitudes y coherencia interna. Nada de «falta el examen final».
 */
export function checkDraftStructure(definition: CourseVersionDefinition): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const error = (code: string, message: string, path: string) =>
    issues.push({ code, message, path, severity: "error" });

  if (!isSlug(definition.courseId)) {
    error("COURSE_ID_INVALID", "Identificador de curso no válido.", "courseId");
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    error("VERSION_INVALID", "La versión debe ser un entero mayor o igual que 1.", "version");
  }

  const title = definition.title?.trim() ?? "";
  if (!title) {
    error("COURSE_TITLE_REQUIRED", "El curso necesita un título.", "title");
  } else if (title.length > DRAFT_LIMITS.courseTitle) {
    error(
      "COURSE_TITLE_TOO_LONG",
      `El título no puede pasar de ${DRAFT_LIMITS.courseTitle} caracteres.`,
      "title",
    );
  }

  if ((definition.description?.length ?? 0) > DRAFT_LIMITS.courseDescription) {
    error(
      "COURSE_DESCRIPTION_TOO_LONG",
      `La descripción no puede pasar de ${DRAFT_LIMITS.courseDescription} caracteres.`,
      "description",
    );
  }

  if (definition.topics.length > DRAFT_LIMITS.topics) {
    error(
      "COURSE_TOO_MANY_TOPICS",
      `Un curso no puede tener más de ${DRAFT_LIMITS.topics} temas.`,
      "topics",
    );
  }

  const ids = new Set<string>();
  const orders = new Set<number>();

  definition.topics.forEach((topic, index) => {
    const path = `topics[${index}]`;

    if (!isSlug(topic.id)) {
      error("TOPIC_ID_INVALID", "Identificador de tema no válido.", `${path}.id`);
    }
    if (ids.has(topic.id)) {
      error("TOPIC_ID_DUPLICATED", `Tema repetido: ${topic.id}.`, `${path}.id`);
    }
    ids.add(topic.id);

    const topicTitle = topic.title?.trim() ?? "";
    if (!topicTitle) {
      error("TOPIC_TITLE_REQUIRED", "El tema necesita un título.", `${path}.title`);
    } else if (topicTitle.length > DRAFT_LIMITS.topicTitle) {
      error(
        "TOPIC_TITLE_TOO_LONG",
        `El título del tema no puede pasar de ${DRAFT_LIMITS.topicTitle} caracteres.`,
        `${path}.title`,
      );
    }

    if (!Number.isInteger(topic.order) || topic.order < 1) {
      error("TOPIC_ORDER_INVALID", "El orden del tema debe ser un entero positivo.", `${path}.order`);
    } else if (orders.has(topic.order)) {
      error("TOPIC_ORDER_DUPLICATED", `Orden de tema repetido: ${topic.order}.`, `${path}.order`);
    }
    orders.add(topic.order);

    if (typeof topic.mandatory !== "boolean") {
      error("TOPIC_MANDATORY_INVALID", "El tema debe indicar si es obligatorio.", `${path}.mandatory`);
    }

    // Pantallas de estudio: si están, tienen que ser válidas. Una pantalla rota
    // se vería en la pantalla del alumnado, así que esto sí bloquea el guardado.
    if (topic.screens !== undefined) {
      try {
        normalizeScreens(topic.screens);
      } catch (caught) {
        error(
          "TOPIC_SCREENS_INVALID",
          `Pantallas del tema «${topic.title || topic.id}»: ${
            caught instanceof Error ? caught.message : "no son válidas"
          }`,
          `${path}.screens`,
        );
      }
    }
  });

  return issues;
}

/**
 * Avisos para el editor: lo que hoy impediría publicar, más lo que conviene
 * mirar. Nunca bloquean el guardado.
 *
 * Los que salen de `validateCourseVersion` se calculan con esa misma función
 * (no se duplica la regla): si mañana cambia la puerta de publicación, el
 * editor lo refleja sin tocar nada.
 */
export function reviewDraft(
  definition: CourseVersionDefinition,
  publishIssues: ReadonlyArray<{ code: string; message: string; path: string }>,
): DraftIssue[] {
  const warnings: DraftIssue[] = publishIssues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
    severity: "warning",
  }));

  const has = (code: string) => warnings.some((issue) => issue.code === code);

  if (definition.topics.length === 0 && !has("COURSE_NO_TOPICS")) {
    warnings.push({
      code: "COURSE_NO_TOPICS",
      message: "El curso todavía no tiene temas.",
      path: "topics",
      severity: "warning",
    });
  }

  definition.topics.forEach((topic, index) => {
    // Un tema se estudia por sus pantallas o por sus PDF. Sin ninguna de las
    // dos cosas no hay nada que leer, y el cuestionario quedaría accesible sin
    // haber estudiado nada: se avisa aquí y la publicación lo impide.
    if (topic.documents.length === 0 && (topic.screens?.length ?? 0) === 0) {
      warnings.push({
        code: "TOPIC_WITHOUT_DOCUMENTS",
        message: `El tema «${topic.title || topic.id}» no tiene ningún documento ni pantallas de estudio.`,
        path: `topics[${index}].documents`,
        severity: "warning",
      });
    }
    if (topic.quiz.length === 0) {
      warnings.push({
        code: "TOPIC_WITHOUT_QUIZ",
        message: `El tema «${topic.title || topic.id}» todavía no tiene cuestionario.`,
        path: `topics[${index}].quiz`,
        severity: "warning",
      });
    }
  });

  if (definition.finalExam.length === 0) {
    warnings.push({
      code: "FINAL_EXAM_EMPTY",
      message: "Todavía no hay examen final.",
      path: "finalExam",
      severity: "warning",
    });
  }

  // Calidad de los cuestionarios (opciones sin texto): se avisa, no se bloquea.
  warnings.push(...reviewDraftQuizzes(definition.topics, definition.finalExam));

  return warnings;
}

/**
 * Orden determinista 1..n.
 *
 * Se ordena por el orden pedido y, en caso de empate, por identificador: dos
 * guardados con los mismos datos producen exactamente el mismo documento, sin
 * depender del orden en que llegaron los campos del formulario.
 */
export function normalizeTopicOrder<T extends Pick<TopicDefinition, "id" | "order">>(
  topics: readonly T[],
): T[] {
  return [...topics]
    .sort((a, b) => {
      const orderA = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    })
    .map((topic, index) => ({ ...topic, order: index + 1 }));
}

/** Tamaño real del documento que se va a escribir (UTF-8, no longitud de cadena). */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
