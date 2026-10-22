import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { isSlug } from "@/domain/courses/content";
import type { DraftIssue } from "@/domain/courses/draft";

/**
 * CUESTIONARIOS DEL BORRADOR: QUÉ SE PUEDE GUARDAR
 * ===============================================
 *
 * Mismo criterio que la estructura del curso (ADR-023): lo que aquí falla
 * **impide guardar** porque produce un cuestionario que no se puede mostrar ni
 * corregir. Lo que aquí no se exige —que el tema obligatorio tenga preguntas,
 * que haya examen final— sigue siendo un **aviso**, no un error: un borrador a
 * medias es un estado legítimo.
 *
 * La clave de corrección (`correctOptionIds`) se valida aquí porque, si faltara
 * o apuntara a una opción inexistente, el intento del alumno sería incobrable.
 * Eso no la hace visible: viaja a `answerKeys`, nunca al documento de versión.
 *
 * No se reutiliza `validateQuizDefinition` porque esa función es la puerta de
 * corrección y lanza al primer problema con códigos 500. Aquí hacen falta
 * **todos** los problemas a la vez, con rutas y mensajes para la pantalla.
 */

export const QUIZ_DRAFT_LIMITS = {
  prompt: 500,
  optionLabel: 300,
  /** Opciones por pregunta: dos mínimo para que haya elección real. */
  minOptions: 2,
  maxOptions: 8,
  /** Preguntas por cuestionario (de tema o examen final). */
  maxQuestions: 50,
} as const;

const QUESTION_TYPES = new Set(["single_choice", "multi_choice"]);

/** Identificadores de opción: se aceptan slugs (`opcion-a`, `a`, `1`). */
export function isOptionId(value: string): boolean {
  return isSlug(value);
}

function pushError(
  issues: DraftIssue[],
  code: string,
  message: string,
  path: string,
): void {
  issues.push({ code, message, path, severity: "error" });
}

/**
 * Comprueba UNA pregunta. `path` es la ruta que verá la persona
 * (`topics[1].quiz[0]`, `finalExam[2]`).
 */
export function checkQuestionStructure(
  question: QuizQuestionDefinition,
  path: string,
): DraftIssue[] {
  const issues: DraftIssue[] = [];

  if (!isSlug(question.id)) {
    pushError(
      issues,
      "QUESTION_ID_INVALID",
      `Identificador de pregunta no válido: «${question.id}». Usa minúsculas, números y guiones.`,
      `${path}.id`,
    );
  }

  if (!QUESTION_TYPES.has(question.type)) {
    pushError(
      issues,
      "QUESTION_TYPE_INVALID",
      "Cada pregunta debe ser de respuesta única o de respuesta múltiple.",
      `${path}.type`,
    );
  }

  const prompt = question.prompt?.trim() ?? "";
  if (!prompt) {
    pushError(
      issues,
      "QUESTION_PROMPT_REQUIRED",
      "La pregunta necesita un enunciado: es lo único que ve el alumnado.",
      `${path}.prompt`,
    );
  } else if (prompt.length > QUIZ_DRAFT_LIMITS.prompt) {
    pushError(
      issues,
      "QUESTION_PROMPT_TOO_LONG",
      `El enunciado no puede pasar de ${QUIZ_DRAFT_LIMITS.prompt} caracteres.`,
      `${path}.prompt`,
    );
  }

  const optionIds = question.optionIds;
  if (optionIds.length < QUIZ_DRAFT_LIMITS.minOptions) {
    pushError(
      issues,
      "QUESTION_TOO_FEW_OPTIONS",
      `Cada pregunta necesita al menos ${QUIZ_DRAFT_LIMITS.minOptions} opciones.`,
      `${path}.optionIds`,
    );
  }
  if (optionIds.length > QUIZ_DRAFT_LIMITS.maxOptions) {
    pushError(
      issues,
      "QUESTION_TOO_MANY_OPTIONS",
      `Cada pregunta admite como máximo ${QUIZ_DRAFT_LIMITS.maxOptions} opciones.`,
      `${path}.optionIds`,
    );
  }

  const seen = new Set<string>();
  optionIds.forEach((optionId, index) => {
    if (!isOptionId(optionId)) {
      pushError(
        issues,
        "OPTION_ID_INVALID",
        `Identificador de opción no válido: «${optionId}».`,
        `${path}.optionIds[${index}]`,
      );
    }
    if (seen.has(optionId)) {
      pushError(
        issues,
        "OPTION_ID_DUPLICATED",
        `La opción «${optionId}» está repetida en la misma pregunta.`,
        `${path}.optionIds[${index}]`,
      );
    }
    seen.add(optionId);

    // El texto de la opción es opcional en el modelo (`optionLabels` no existe
    // en el contenido anterior al editor): si falta, la interfaz muestra el
    // identificador. Se avisa, no se bloquea el guardado, para no invalidar
    // contenido ya publicado. Lo que sí es un error es un texto imposible.
    const label = question.optionLabels?.[optionId]?.trim() ?? "";
    if (label.length > QUIZ_DRAFT_LIMITS.optionLabel) {
      pushError(
        issues,
        "OPTION_LABEL_TOO_LONG",
        `El texto de la opción «${optionId}» no puede pasar de ${QUIZ_DRAFT_LIMITS.optionLabel} caracteres.`,
        `${path}.optionLabels.${optionId}`,
      );
    }
  });

  if (question.correctOptionIds.length === 0) {
    pushError(
      issues,
      "QUESTION_WITHOUT_CORRECT_ANSWER",
      "Marca cuál es la respuesta correcta: sin ella el intento no se puede corregir.",
      `${path}.correctOptionIds`,
    );
  }

  const correctSeen = new Set<string>();
  question.correctOptionIds.forEach((optionId, index) => {
    if (!seen.has(optionId)) {
      pushError(
        issues,
        "QUESTION_CORRECT_UNKNOWN_OPTION",
        `Se ha marcado como correcta una opción que no existe («${optionId}»).`,
        `${path}.correctOptionIds[${index}]`,
      );
    }
    if (correctSeen.has(optionId)) {
      pushError(
        issues,
        "QUESTION_CORRECT_DUPLICATED",
        `La respuesta correcta «${optionId}» está repetida.`,
        `${path}.correctOptionIds[${index}]`,
      );
    }
    correctSeen.add(optionId);
  });

  if (
    question.type === "single_choice" &&
    question.correctOptionIds.length > 1
  ) {
    pushError(
      issues,
      "QUESTION_SINGLE_CHOICE_MULTIPLE_CORRECT",
      "Una pregunta de respuesta única solo puede tener una opción correcta.",
      `${path}.correctOptionIds`,
    );
  }

  if (question.optionLabels) {
    const unknown = Object.keys(question.optionLabels).filter(
      (optionId) => !seen.has(optionId),
    );
    if (unknown.length > 0) {
      pushError(
        issues,
        "QUESTION_LABEL_UNKNOWN_OPTION",
        `Hay texto para opciones que no existen (${unknown.join(", ")}).`,
        `${path}.optionLabels`,
      );
    }
  }

  return issues;
}

/**
 * Comprueba un cuestionario completo (el de un tema o el examen final).
 *
 * Un cuestionario **vacío es válido**: se está escribiendo. Lo que no se admite
 * es un cuestionario con preguntas rotas o repetidas.
 */
export function checkQuizStructure(
  questions: readonly QuizQuestionDefinition[],
  path: string,
): DraftIssue[] {
  const issues: DraftIssue[] = [];

  if (questions.length > QUIZ_DRAFT_LIMITS.maxQuestions) {
    pushError(
      issues,
      "QUIZ_TOO_MANY_QUESTIONS",
      `Un cuestionario admite como máximo ${QUIZ_DRAFT_LIMITS.maxQuestions} preguntas.`,
      path,
    );
  }

  const ids = new Set<string>();
  questions.forEach((question, index) => {
    if (ids.has(question.id)) {
      pushError(
        issues,
        "QUESTION_ID_DUPLICATED",
        `Pregunta repetida: «${question.id}».`,
        `${path}[${index}].id`,
      );
    }
    ids.add(question.id);
    issues.push(...checkQuestionStructure(question, `${path}[${index}]`));
  });

  return issues;
}

/** Todas las preguntas del borrador: cada tema y el examen final. */
export function checkDraftQuizzes(
  topics: ReadonlyArray<{ id: string; quiz: QuizQuestionDefinition[] }>,
  finalExam: readonly QuizQuestionDefinition[],
): DraftIssue[] {
  return [
    ...topics.flatMap((topic, index) =>
      checkQuizStructure(topic.quiz, `topics[${index}].quiz`),
    ),
    ...checkQuizStructure(finalExam, "finalExam"),
  ];
}

/**
 * Avisos de calidad de los cuestionarios: no impiden guardar ni publicar, pero
 * se muestran en el editor. Hoy, opciones sin texto (el alumnado vería su
 * identificador).
 */
export function reviewQuizLabels(
  questions: ReadonlyArray<QuizQuestionDefinition>,
  path: string,
): DraftIssue[] {
  const issues: DraftIssue[] = [];

  questions.forEach((question, index) => {
    for (const optionId of question.optionIds) {
      if (!question.optionLabels?.[optionId]?.trim()) {
        issues.push({
          code: "OPTION_LABEL_MISSING",
          message: `La pregunta «${question.prompt || question.id}» tiene una opción sin texto (${optionId}): el alumnado verá el identificador.`,
          path: `${path}[${index}].optionLabels.${optionId}`,
          severity: "warning",
        });
      }
    }
  });

  return issues;
}

/** Avisos de todos los cuestionarios del borrador (temas y examen final). */
export function reviewDraftQuizzes(
  topics: ReadonlyArray<{ id: string; quiz: QuizQuestionDefinition[] }>,
  finalExam: readonly QuizQuestionDefinition[],
): DraftIssue[] {
  return [
    ...topics.flatMap((topic, index) => reviewQuizLabels(topic.quiz, `topics[${index}].quiz`)),
    ...reviewQuizLabels(finalExam, "finalExam"),
  ];
}

/** Cuenta de preguntas y de respuestas correctas, para la ficha del editor. */
export function quizSummary(
  questions: readonly QuizQuestionDefinition[],
): { questions: number; options: number } {
  return {
    questions: questions.length,
    options: questions.reduce((sum, question) => sum + question.optionIds.length, 0),
  };
}
