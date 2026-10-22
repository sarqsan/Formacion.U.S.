import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { QUIZ_DRAFT_LIMITS } from "@/domain/courses/quiz-draft";

/**
 * CAMPOS DE UN CUESTIONARIO (tema o examen final)
 * ==============================================
 *
 * Componente de servidor, sin JavaScript de cliente: cada campo se envía en el
 * formulario y `server/courses/quiz-form.ts` lo traduce de vuelta. Se usa dos
 * veces en el editor: una por tema y otra para el examen final, cambiando solo
 * el `scope` (el identificador del tema, o `final`).
 *
 * Se muestran las respuestas correctas porque esta pantalla es de
 * administración; el alumnado recibe `PublicQuestion`, que no las tiene. Aun
 * así, la clave **no se guarda en la versión**: se escribe en `answerKeys`, un
 * documento solo-servidor.
 */

const OPTION_SLOTS = [1, 2, 3] as const;

export interface QuizFieldsProps {
  /** Identificador del cuestionario: `final` o el id del tema. */
  scope: string;
  questions: ReadonlyArray<QuizQuestionDefinition>;
  /** Texto que explica de qué cuestionario se trata. */
  hint?: string;
}

export function QuizFields({ scope, questions, hint }: QuizFieldsProps) {
  const prefix = `quiz:${scope}`;

  return (
    <div className="space-y-3">
      {hint ? <p className="muted text-xs">{hint}</p> : null}

      {questions.length === 0 ? (
        <p className="muted text-xs">Todavía no hay preguntas en este cuestionario.</p>
      ) : null}

      {questions.map((question, index) => (
        <fieldset
          key={question.id}
          className="rounded-lg border border-[var(--line)] p-3"
        >
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
            Pregunta {index + 1} · <span className="mono">{question.id}</span>
          </legend>

          <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
            <div>
              <label className="label" htmlFor={`${prefix}:question:${question.id}:prompt`}>
                Enunciado
              </label>
              <input
                id={`${prefix}:question:${question.id}:prompt`}
                name={`${prefix}:question:${question.id}:prompt`}
                className="input"
                defaultValue={question.prompt ?? ""}
                maxLength={QUIZ_DRAFT_LIMITS.prompt}
              />
            </div>
            <div>
              <label className="label" htmlFor={`${prefix}:question:${question.id}:type`}>
                Tipo
              </label>
              <select
                id={`${prefix}:question:${question.id}:type`}
                name={`${prefix}:question:${question.id}:type`}
                className="input"
                defaultValue={question.type}
              >
                <option value="single_choice">Respuesta única</option>
                <option value="multi_choice">Respuesta múltiple</option>
              </select>
            </div>
          </div>

          <div className="mt-2 space-y-1">
            {question.optionIds.map((optionId) => (
              <div
                key={optionId}
                className="grid gap-1 sm:grid-cols-[1fr_auto_auto] sm:items-center"
              >
                <div>
                  <label
                    className="label"
                    htmlFor={`${prefix}:question:${question.id}:option:${optionId}`}
                  >
                    Opción <span className="mono">{optionId}</span>
                  </label>
                  <input
                    id={`${prefix}:question:${question.id}:option:${optionId}`}
                    name={`${prefix}:question:${question.id}:option:${optionId}`}
                    className="input"
                    defaultValue={question.optionLabels?.[optionId] ?? ""}
                    maxLength={QUIZ_DRAFT_LIMITS.optionLabel}
                  />
                </div>
                <label className="flex items-center gap-1 text-xs sm:mt-4">
                  <input
                    type="checkbox"
                    name={`${prefix}:question:${question.id}:correct:${optionId}`}
                    defaultChecked={question.correctOptionIds.includes(optionId)}
                  />
                  Correcta
                </label>
                <label className="flex items-center gap-1 text-xs muted sm:mt-4">
                  <input
                    type="checkbox"
                    name={`${prefix}:question:${question.id}:removeOption:${optionId}`}
                  />
                  Quitar
                </label>
              </div>
            ))}
          </div>

          <div className="mt-2 grid gap-1 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label
                className="label"
                htmlFor={`${prefix}:question:${question.id}:newOptionId`}
              >
                Nueva opción · identificador
              </label>
              <input
                id={`${prefix}:question:${question.id}:newOptionId`}
                name={`${prefix}:question:${question.id}:newOptionId`}
                className="input mono"
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                maxLength={64}
                autoComplete="off"
              />
            </div>
            <div>
              <label
                className="label"
                htmlFor={`${prefix}:question:${question.id}:newOptionLabel`}
              >
                Texto
              </label>
              <input
                id={`${prefix}:question:${question.id}:newOptionLabel`}
                name={`${prefix}:question:${question.id}:newOptionLabel`}
                className="input"
                maxLength={QUIZ_DRAFT_LIMITS.optionLabel}
              />
            </div>
            <label className="flex items-center gap-1 pb-2 text-xs">
              <input
                type="checkbox"
                name={`${prefix}:question:${question.id}:newOptionCorrect`}
              />
              Correcta
            </label>
          </div>

          <label className="mt-2 flex items-center gap-2 text-xs muted">
            <input type="checkbox" name={`${prefix}:question:${question.id}:delete`} />
            Eliminar la pregunta de este borrador
          </label>
        </fieldset>
      ))}

      <fieldset className="rounded-lg border border-dashed border-[var(--line)] p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
          Añadir una pregunta
        </legend>

        <div className="grid gap-2 sm:grid-cols-[12rem_1fr_9rem]">
          <div>
            <label className="label" htmlFor={`${prefix}:newQuestionId`}>
              Identificador
            </label>
            <input
              id={`${prefix}:newQuestionId`}
              name={`${prefix}:newQuestionId`}
              className="input mono"
              pattern="[a-z0-9][a-z0-9-]{0,63}"
              maxLength={64}
              placeholder="pregunta-4"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="label" htmlFor={`${prefix}:newQuestionPrompt`}>
              Enunciado
            </label>
            <input
              id={`${prefix}:newQuestionPrompt`}
              name={`${prefix}:newQuestionPrompt`}
              className="input"
              maxLength={QUIZ_DRAFT_LIMITS.prompt}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${prefix}:newQuestionType`}>
              Tipo
            </label>
            <select
              id={`${prefix}:newQuestionType`}
              name={`${prefix}:newQuestionType`}
              className="input"
              defaultValue="single_choice"
            >
              <option value="single_choice">Respuesta única</option>
              <option value="multi_choice">Respuesta múltiple</option>
            </select>
          </div>
        </div>

        <div className="mt-2 space-y-1">
          {OPTION_SLOTS.map((slot) => (
            <div
              key={slot}
              className="grid gap-1 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
            >
              <div>
                <label className="label" htmlFor={`${prefix}:newOption${slot}Id`}>
                  Opción {slot} · identificador
                </label>
                <input
                  id={`${prefix}:newOption${slot}Id`}
                  name={`${prefix}:newOption${slot}Id`}
                  className="input mono"
                  pattern="[a-z0-9][a-z0-9-]{0,63}"
                  maxLength={64}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="label" htmlFor={`${prefix}:newOption${slot}Label`}>
                  Texto
                </label>
                <input
                  id={`${prefix}:newOption${slot}Label`}
                  name={`${prefix}:newOption${slot}Label`}
                  className="input"
                  maxLength={QUIZ_DRAFT_LIMITS.optionLabel}
                />
              </div>
              <label className="flex items-center gap-1 pb-2 text-xs">
                <input type="checkbox" name={`${prefix}:newOption${slot}Correct`} />
                Correcta
              </label>
            </div>
          ))}
        </div>

        <p className="muted mt-2 text-xs">
          Cada pregunta necesita al menos dos opciones y una respuesta correcta
          (una sola si es de respuesta única). Se pueden añadir más opciones
          después, dentro de cada pregunta.
        </p>
      </fieldset>
    </div>
  );
}
