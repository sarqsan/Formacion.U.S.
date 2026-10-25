import { DomainError } from "@/domain/text";

/**
 * CORRECCIÓN DE EVALUACIONES (lado servidor)
 * ==========================================
 *
 * Regla de negocio: un tema o el examen final **solo se supera cuando todas
 * las respuestas son correctas en el mismo intento**. No hay nota parcial
 * aprobatoria.
 *
 * Este módulo es el único lugar del sistema que decide si un intento está
 * aprobado. El cliente nunca envía "aprobado": envía qué opciones marcó, y
 * aquí se compara con la clave, que vive en el servidor. Las respuestas
 * correctas no deben enviarse al cliente (ver servicio de evaluación).
 */

export type QuestionType = "single_choice" | "multi_choice";

export interface QuizQuestionDefinition {
  id: string;
  type: QuestionType;
  optionIds: string[];
  correctOptionIds: string[];
  /** Texto solo a efectos de autoría; no participa en la corrección. */
  prompt?: string;
  /**
   * Texto visible de cada opción (`id` → etiqueta). Es opcional para no romper
   * el contenido ya publicado: si falta, la interfaz muestra el identificador.
   * NUNCA lleva información de cuál es la correcta.
   */
  optionLabels?: Record<string, string>;
  /**
   * Justificación de por qué la respuesta marcada es la correcta, apoyada en el
   * temario. Es **material del servidor**: explica la solución, así que se
   * guarda en `answerKeys` y nunca viaja al navegador antes de corregir
   * (`toClientQuiz` la elimina, y `assertNoAnswerLeak` falla si aparece en el
   * documento público).
   */
  explanation?: string;
}

export interface SubmittedAnswer {
  questionId: string;
  selectedOptionIds: string[];
}

export interface GradedQuestion {
  questionId: string;
  selectedOptionIds: string[];
  correct: boolean;
  unanswered: boolean;
}

export interface GradedAttempt {
  passed: boolean;
  totalQuestions: number;
  correctCount: number;
  /** 0..100, informativo (no se usa para aprobar). */
  score: number;
  incorrectQuestionIds: string[];
  unansweredQuestionIds: string[];
  perQuestion: GradedQuestion[];
}

export const MAX_EXPLANATION_CHARS = 600;

export function validateQuizDefinition(
  questions: readonly QuizQuestionDefinition[],
): void {
  if (questions.length === 0) {
    throw new DomainError(
      "QUIZ_EMPTY",
      "La evaluación no tiene preguntas.",
      500,
    );
  }

  const seen = new Set<string>();

  for (const question of questions) {
    if (!question.id || seen.has(question.id)) {
      throw new DomainError(
        "QUIZ_DUPLICATE_QUESTION",
        `Pregunta duplicada o sin identificador: «${question.id}».`,
        500,
      );
    }
    seen.add(question.id);

    if (question.optionIds.length < 2) {
      throw new DomainError(
        "QUIZ_TOO_FEW_OPTIONS",
        `La pregunta «${question.id}» debe tener al menos dos opciones.`,
        500,
      );
    }

    if (new Set(question.optionIds).size !== question.optionIds.length) {
      throw new DomainError(
        "QUIZ_DUPLICATE_OPTION",
        `La pregunta «${question.id}» repite identificadores de opción.`,
        500,
      );
    }

    if (question.correctOptionIds.length === 0) {
      throw new DomainError(
        "QUIZ_NO_CORRECT_ANSWER",
        `La pregunta «${question.id}» no tiene respuesta correcta definida.`,
        500,
      );
    }

    const optionSet = new Set(question.optionIds);
    for (const correctId of question.correctOptionIds) {
      if (!optionSet.has(correctId)) {
        throw new DomainError(
          "QUIZ_CORRECT_ANSWER_UNKNOWN_OPTION",
          `La pregunta «${question.id}» marca como correcta una opción inexistente.`,
          500,
        );
      }
    }

    if (new Set(question.correctOptionIds).size !== question.correctOptionIds.length) {
      throw new DomainError(
        "QUIZ_DUPLICATE_CORRECT_ANSWER",
        `La pregunta «${question.id}» repite respuestas correctas.`,
        500,
      );
    }

    if (question.optionLabels) {
      const unknownLabel = Object.keys(question.optionLabels).find(
        (optionId) => !question.optionIds.includes(optionId),
      );
      if (unknownLabel !== undefined) {
        throw new DomainError(
          "QUIZ_LABEL_UNKNOWN_OPTION",
          `La pregunta «${question.id}» etiqueta una opción que no existe (${unknownLabel}).`,
          500,
        );
      }
    }

    if (question.type === "single_choice" && question.correctOptionIds.length !== 1) {
      throw new DomainError(
        "QUIZ_SINGLE_CHOICE_MULTIPLE_CORRECT",
        `La pregunta «${question.id}» es de respuesta única pero tiene varias correctas.`,
        500,
      );
    }
  }
}

function sameOptionSet(selected: readonly string[], correct: readonly string[]): boolean {
  if (selected.length !== correct.length) return false;
  if (new Set(selected).size !== selected.length) return false;
  const correctSet = new Set(correct);
  return selected.every((id) => correctSet.has(id));
}

/**
 * Corrige un intento completo.
 *
 * - Exige respuesta para TODAS las preguntas (una pregunta en blanco cuenta
 *   como fallo y, por tanto, el intento no se aprueba).
 * - Rechaza respuestas a preguntas inexistentes (posible manipulación).
 * - Rechaza respuestas duplicadas para la misma pregunta.
 */
export function gradeAttempt(
  questions: readonly QuizQuestionDefinition[],
  answers: readonly SubmittedAnswer[],
): GradedAttempt {
  validateQuizDefinition(questions);

  const questionById = new Map(questions.map((q) => [q.id, q]));
  const answerByQuestion = new Map<string, string[]>();

  for (const answer of answers) {
    if (!questionById.has(answer.questionId)) {
      throw new DomainError(
        "ANSWER_UNKNOWN_QUESTION",
        "El intento contiene respuestas a preguntas que no existen.",
      );
    }
    if (answerByQuestion.has(answer.questionId)) {
      throw new DomainError(
        "ANSWER_DUPLICATED",
        "El intento contiene más de una respuesta para la misma pregunta.",
      );
    }
    answerByQuestion.set(answer.questionId, answer.selectedOptionIds);
  }

  const perQuestion: GradedQuestion[] = [];

  for (const question of questions) {
    const selected = answerByQuestion.get(question.id) ?? [];
    const optionSet = new Set(question.optionIds);

    for (const optionId of selected) {
      if (!optionSet.has(optionId)) {
        throw new DomainError(
          "ANSWER_UNKNOWN_OPTION",
          "El intento contiene opciones que no existen en la pregunta.",
        );
      }
    }

    const unanswered = selected.length === 0;
    perQuestion.push({
      questionId: question.id,
      selectedOptionIds: [...selected],
      unanswered,
      correct: !unanswered && sameOptionSet(selected, question.correctOptionIds),
    });
  }

  const correctCount = perQuestion.filter((q) => q.correct).length;
  const totalQuestions = perQuestion.length;

  return {
    passed: correctCount === totalQuestions,
    totalQuestions,
    correctCount,
    score: Math.round((correctCount / totalQuestions) * 100),
    incorrectQuestionIds: perQuestion
      .filter((q) => !q.correct && !q.unanswered)
      .map((q) => q.questionId),
    unansweredQuestionIds: perQuestion
      .filter((q) => q.unanswered)
      .map((q) => q.questionId),
    perQuestion,
  };
}

/** Sanea una definición para enviarla al cliente: sin respuestas correctas. */
export function toClientQuiz(questions: readonly QuizQuestionDefinition[]): Array<{
  id: string;
  type: QuestionType;
  optionIds: string[];
  prompt?: string;
  optionLabels?: Record<string, string>;
}> {
  return questions.map((question) => ({
    id: question.id,
    type: question.type,
    optionIds: [...question.optionIds],
    ...(question.prompt ? { prompt: question.prompt } : {}),
    // `correctOptionIds` y `explanation` se quedan fuera a propósito: las dos
    // revelan la solución.
    ...(question.optionLabels
      ? {
          optionLabels: Object.fromEntries(
            Object.entries(question.optionLabels).filter(([optionId]) =>
              question.optionIds.includes(optionId),
            ),
          ),
        }
      : {}),
  }));
}
