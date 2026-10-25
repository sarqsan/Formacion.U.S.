import { DomainError } from "@/domain/text";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { QUIZ_DRAFT_LIMITS } from "@/domain/courses/quiz-draft";

/**
 * LECTURA DEL FORMULARIO DE CUESTIONARIOS
 * ======================================
 *
 * Sin JavaScript, como el resto de la administración: todo llega en un
 * `FormData` y se interpreta aquí. Igual que con los temas (bloque 04), la
 * regla es **lo que no llega, no existe**: una pregunta sin su campo de
 * enunciado se elimina, y las opciones se quitan marcándolas o dejando de
 * enviarlas.
 *
 * Cada cuestionario se identifica con un ámbito: `quiz:<temaId>:…` para el
 * cuestionario de un tema y `quiz:final:…` para el examen final. Sin ese
 * prefijo, dos preguntas con el mismo identificador en sitios distintos se
 * pisarían.
 *
 * Este módulo **no valida el contenido** (identificadores, longitudes,
 * respuestas correctas): eso vive en `domain/courses/quiz-draft.ts`, para que
 * la regla sea una sola y la compartan el formulario y cualquier otra vía.
 */

const OPTION_SLOTS = [1, 2, 3] as const;

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function checked(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "on" || value === "true" || value === "1";
}

export interface QuizScopeView {
  /** Preguntas guardadas hoy, con sus claves (vista de administración). */
  questions: ReadonlyArray<QuizQuestionDefinition>;
}

function parseScope(formData: FormData, scope: string, current: QuizScopeView): QuizQuestionDefinition[] {
  const prefix = `quiz:${scope}`;
  const questions: QuizQuestionDefinition[] = [];

  for (const existing of current.questions) {
    const questionPrefix = `${prefix}:question:${existing.id}`;

    // Eliminada a propósito, o su bloque ya no está en el formulario.
    if (checked(formData, `${questionPrefix}:delete`)) continue;
    if (!formData.has(`${questionPrefix}:prompt`)) continue;

    const optionIds: string[] = [];
    const optionLabels: Record<string, string> = {};
    const correctOptionIds: string[] = [];

    for (const optionId of existing.optionIds) {
      if (checked(formData, `${questionPrefix}:removeOption:${optionId}`)) continue;
      if (!formData.has(`${questionPrefix}:option:${optionId}`)) continue;

      optionIds.push(optionId);
      optionLabels[optionId] = text(formData, `${questionPrefix}:option:${optionId}`);
      if (checked(formData, `${questionPrefix}:correct:${optionId}`)) {
        correctOptionIds.push(optionId);
      }
    }

    const explanation = text(formData, `${questionPrefix}:explanation`);

    // Opción añadida en este guardado.
    const newOptionId = text(formData, `${questionPrefix}:newOptionId`);
    const newOptionLabel = text(formData, `${questionPrefix}:newOptionLabel`);
    if (newOptionId || newOptionLabel) {
      if (!newOptionId || !newOptionLabel) {
        throw new DomainError(
          "DRAFT_FORM_INVALID",
          "Para añadir una opción hay que indicar identificador y texto.",
          400,
        );
      }
      optionIds.push(newOptionId);
      optionLabels[newOptionId] = newOptionLabel;
      if (checked(formData, `${questionPrefix}:newOptionCorrect`)) {
        correctOptionIds.push(newOptionId);
      }
    }

    if (optionIds.length > QUIZ_DRAFT_LIMITS.maxOptions) {
      throw new DomainError(
        "DRAFT_FORM_INVALID",
        `Una pregunta admite como máximo ${QUIZ_DRAFT_LIMITS.maxOptions} opciones.`,
        400,
      );
    }

    const type = text(formData, `${questionPrefix}:type`);

    questions.push({
      id: existing.id,
      type: type === "multi_choice" ? "multi_choice" : "single_choice",
      optionIds,
      correctOptionIds,
      prompt: text(formData, `${questionPrefix}:prompt`),
      ...(Object.keys(optionLabels).length > 0 ? { optionLabels } : {}),
      // La explicación se guarda en las claves (solo servidor), no en el
      // documento público: aquí solo se transporta.
      ...(explanation ? { explanation } : {}),
    });
  }

  // Pregunta nueva: se exige el bloque completo o nada.
  const newId = text(formData, `${prefix}:newQuestionId`);
  const newPrompt = text(formData, `${prefix}:newQuestionPrompt`);
  if (newId || newPrompt) {
    if (!newId || !newPrompt) {
      throw new DomainError(
        "DRAFT_FORM_INVALID",
        "Para añadir una pregunta hay que indicar identificador y enunciado.",
        400,
      );
    }

    const optionIds: string[] = [];
    const optionLabels: Record<string, string> = {};
    const correctOptionIds: string[] = [];

    for (const slot of OPTION_SLOTS) {
      const optionId = text(formData, `${prefix}:newOption${slot}Id`);
      const optionLabel = text(formData, `${prefix}:newOption${slot}Label`);
      if (!optionId && !optionLabel) continue;
      if (!optionId || !optionLabel) {
        throw new DomainError(
          "DRAFT_FORM_INVALID",
          `La opción ${slot} de la pregunta nueva está a medias: indica identificador y texto.`,
          400,
        );
      }
      optionIds.push(optionId);
      optionLabels[optionId] = optionLabel;
      if (checked(formData, `${prefix}:newOption${slot}Correct`)) {
        correctOptionIds.push(optionId);
      }
    }

    const type = text(formData, `${prefix}:newQuestionType`);

    const newExplanation = text(formData, `${prefix}:newQuestionExplanation`);

    questions.push({
      id: newId,
      type: type === "multi_choice" ? "multi_choice" : "single_choice",
      optionIds,
      correctOptionIds,
      prompt: newPrompt,
      ...(Object.keys(optionLabels).length > 0 ? { optionLabels } : {}),
      ...(newExplanation ? { explanation: newExplanation } : {}),
    });
  }

  return questions;
}

export interface ParsedQuizForm {
  topicQuizzes: Record<string, QuizQuestionDefinition[]>;
  finalExam: QuizQuestionDefinition[];
}

/**
 * @param view preguntas guardadas hoy (leídas del almacén, no del formulario).
 * @throws DomainError `DRAFT_FORM_INVALID` si el formulario es incoherente.
 */
export function parseDraftQuizForm(
  formData: FormData,
  view: {
    topics: ReadonlyArray<{ id: string; quiz: ReadonlyArray<QuizQuestionDefinition> }>;
    finalExam: ReadonlyArray<QuizQuestionDefinition>;
  },
): ParsedQuizForm {
  const topicQuizzes: Record<string, QuizQuestionDefinition[]> = {};
  for (const topic of view.topics) {
    topicQuizzes[topic.id] = parseScope(formData, topic.id, { questions: topic.quiz });
  }

  return {
    topicQuizzes,
    finalExam: parseScope(formData, "final", { questions: view.finalExam }),
  };
}

/** Ruta de vuelta al editor tras guardar cuestionarios (éxito o error). */
export function quizSavedRedirect(input: {
  courseId: string;
  version: number;
  failure?: string | null;
}): string {
  const path = `/admin/cursos/${encodeURIComponent(input.courseId)}/editar?v=${input.version}`;
  return input.failure
    ? `${path}&error=${encodeURIComponent(input.failure)}`
    : `${path}&ok=cuestionarios`;
}
