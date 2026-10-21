"use client";

import Link from "next/link";
import { useActionState } from "react";
import { submitQuizAction, type QuizResult } from "@/app/actions/demo";
import type { PublicQuestion } from "@/server/courses/catalog";

const INITIAL: QuizResult = { status: "idle" };

/**
 * Cuestionario de tema o examen final.
 *
 * El formulario solo envía **qué opciones se marcaron**. No envía ni conoce la
 * respuesta correcta: el resultado que se muestra viene del servidor.
 */
export function QuizForm({
  courseId,
  assessmentType,
  topicId,
  questions,
  submitLabel,
  passed,
}: {
  courseId: string;
  assessmentType: "topic" | "final";
  topicId?: string;
  questions: PublicQuestion[];
  submitLabel: string;
  passed: boolean;
}) {
  const [state, formAction, pending] = useActionState(submitQuizAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="assessmentType" value={assessmentType} />
      {topicId ? <input type="hidden" name="topicId" value={topicId} /> : null}

      {questions.map((question, index) => (
        <fieldset key={question.id} className="question">
          <input type="hidden" name="questionId" value={question.id} />
          <legend className="text-sm font-semibold">
            {index + 1}. {question.prompt ?? question.id}
          </legend>
          <p className="muted mt-1 text-xs">
            {question.type === "multi_choice"
              ? "Puede haber más de una opción correcta."
              : "Elige una opción."}
          </p>

          <div className="option-list">
            {question.optionIds.map((optionId) => (
              <label key={optionId} className="option">
                <input
                  type={question.type === "multi_choice" ? "checkbox" : "radio"}
                  name={`q:${question.id}`}
                  value={optionId}
                  required={question.type !== "multi_choice"}
                />
                <span>{question.optionLabels?.[optionId] ?? optionId}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      {state.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" ? (
        <div className={state.passed ? "alert alert-ok" : "alert alert-warn"} role="status">
          <p className="font-semibold">{state.message}</p>
          <p className="mt-1">
            {state.correctCount} de {state.totalQuestions} correctas · {state.score}%
            {state.incorrectQuestionIds && state.incorrectQuestionIds.length > 0
              ? ` · revisa: ${state.incorrectQuestionIds
                  .map((id) => {
                    const index = questions.findIndex((question) => question.id === id);
                    return index >= 0 ? `pregunta ${index + 1}` : id;
                  })
                  .join(", ")}`
              : ""}
          </p>
          {state.courseCompleted ? (
            <p className="mt-2 font-semibold">
              Curso completado. Puedes seguir repasando el temario cuando quieras.
            </p>
          ) : null}
          {state.passed && state.finalExamUnlocked && assessmentType === "topic" ? (
            <p className="mt-2">Tema superado. Los intentos que quieras no cuestan nada.</p>
          ) : null}
          {state.passed ? (
            <p className="mt-2">
              <Link href={`/cursos/${courseId}`} className="underline">
                Volver al temario
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Corrigiendo…" : passed ? "Repetir intento" : submitLabel}
        </button>
        <Link href={`/cursos/${courseId}`} className="btn btn-secondary">
          Volver al curso
        </Link>
        <span className="muted text-xs">
          Se corrige en el servidor con la clave privada del curso.
        </span>
      </div>
    </form>
  );
}
