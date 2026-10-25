import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminDraftEditor, aiConnectionStatus } from "@/server/portal";
import { MAX_AI_UPLOAD_BYTES } from "@/server/ai/config";
import { TopicsBatchRunner } from "./topics-batch-runner";
import {
  checkAiConnectionAction,
  generateFinalExamAction,
  generateQuizAction,
  generateScreensAction,
  proposeTopicsAction,
  saveScreensAction,
} from "@/app/actions/ai";

export const dynamic = "force-dynamic";

/**
 * CREAR CURSO CON IA · PASOS 2 A 5
 * ================================
 *
 * Una sola pantalla con el recorrido completo sobre el **borrador real**:
 *
 *   2. temas          proponer con IA · editar a mano en el editor de siempre
 *   3. pantallas      generar por tema · corregirlas aquí, campo a campo
 *   4. cuestionarios  generar por tema y el examen final · editar en el editor
 *   5. revisión       lo que falta para publicar · publicar con el flujo normal
 *
 * Todo lo que se guarda pasa por los servicios del editor, así que las reglas
 * (topes, páginas que existen en el PDF, respuestas correctas en servidor) son
 * las mismas que al escribir a mano. La IA no publica.
 */

function okMessage(ok: string | undefined): string | null {
  if (!ok) return null;
  if (ok.startsWith("temas-")) return `La IA ha propuesto ${ok.slice(6)} tema(s). Revísalos antes de seguir.`;
  if (ok.startsWith("pantallas-guardadas-")) return `Pantallas guardadas: ${ok.slice(21)} en total.`;
  if (ok.startsWith("pantallas-")) return `Pantallas generadas: ${ok.slice(10)}. Revísalas y corrígelas si hace falta.`;
  if (ok.startsWith("cuestionario-")) return "Cuestionario generado y guardado. Revísalo antes de publicar.";
  if (ok.startsWith("examen-")) return `Examen final generado: ${ok.slice(7)} preguntas.`;
  if (ok === "creado") return "Curso creado con su borrador y el PDF guardado.";
  return ok;
}

export default async function AiCourseWizardPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{
    v?: string;
    paso?: string;
    ok?: string;
    error?: string;
    nota?: string;
    comprobado?: string;
  }>;
}) {
  const { courseId } = await params;
  const { v, paso, ok, error, nota, comprobado } = await searchParams;

  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const requested = Number(v);
  const view = await adminDraftEditor(
    session.actor,
    courseId,
    Number.isFinite(requested) && requested > 0 ? requested : undefined,
  );

  if (!view) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-6">
          <h1 className="page-title">Ese curso no tiene borrador</h1>
          <p className="lead mt-2 text-sm">
            Abre un borrador desde la ficha del curso o empieza uno nuevo con IA.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/admin/cursos/${courseId}`} className="btn btn-secondary">
              Ir al curso
            </Link>
            <Link href="/admin/cursos/ia" className="btn btn-primary">
              Crear con IA
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const status = await aiConnectionStatus();
  const readOnly = view.status !== "draft";
  const editorHref = `/admin/cursos/${courseId}/editar?v=${view.version}`;
  const base = `/admin/cursos/${encodeURIComponent(courseId)}/ia`;
  const currentStep = paso ?? "2";

  const sourceTopic = view.topics.find((topic) => topic.id === "temario");
  const hasPdf = view.topics.some((topic) => topic.documentList.length > 0);
  const contentTopics = view.topics.filter((topic) => topic.id !== "temario");

  const steps = [
    { id: "2", label: "2 · Temas" },
    { id: "3", label: "3 · Pantallas" },
    { id: "4", label: "4 · Cuestionarios" },
    { id: "5", label: "5 · Revisión" },
  ];

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        /{" "}
        <Link href="/admin/cursos" className="underline">
          Cursos
        </Link>{" "}
        /{" "}
        <Link href={`/admin/cursos/${courseId}`} className="underline">
          {view.courseTitle}
        </Link>{" "}
        / <span>Crear con IA</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Borrador v{view.version} · revisión {view.revision}</p>
          <h1 className="page-title mt-1">{view.title}</h1>
          <p className="muted mt-1 text-sm">
            {view.topics.length} tema(s) · {view.topics.reduce((sum, topic) => sum + topic.screens.length, 0)}{" "}
            pantalla(s) ·{" "}
            {view.topics.reduce((sum, topic) => sum + topic.questions, 0)} pregunta(s) de tema ·{" "}
            {view.finalExamQuestions} del examen final
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={editorHref} className="btn btn-secondary">
            Editor completo
          </Link>
          <Link href={`/admin/cursos/${courseId}?v=${view.version}`} className="btn btn-secondary">
            Ficha del curso
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {steps.map((step) => (
          <Link
            key={step.id}
            href={`${base}?v=${view.version}&paso=${step.id}`}
            className={`pill ${currentStep === step.id ? "pill-info" : "pill-off"}`}
          >
            {step.label}
          </Link>
        ))}
        <span className={`pill ${status.configured ? "pill-ok" : "pill-warn"}`}>
          {status.providerLabel}: {status.configured ? status.model : "sin clave"}
        </span>
      </div>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {ok ? <p className="alert alert-ok">{okMessage(ok)}</p> : null}
      {nota ? (
        <p className="alert alert-warn text-sm">
          <strong>Nota de la IA:</strong> {nota}
        </p>
      ) : null}
      {comprobado ? <p className="alert alert-ok text-sm">{comprobado}</p> : null}
      {readOnly ? (
        <p className="alert alert-warn">
          Esta versión no es un borrador ({view.status}): no se puede modificar. Prepara la
          siguiente desde la ficha del curso.
        </p>
      ) : null}

      {!status.configured ? (
        <p className="alert alert-warn text-sm">
          Sin <span className="mono">{status.provider === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY"}</span> no se
          puede generar contenido con IA.
          Puedes seguir trabajando a mano en el editor completo: nada de lo ya hecho se pierde.
        </p>
      ) : null}

      {status.provider === "groq" ? (
        <p className="alert alert-warn text-sm">
          Con Groq y su plan gratuito la generación va por tandas, para no chocar con el límite de
          8 000 tokens por minuto: <strong>cada paso puede tardar entre uno y tres minutos</strong>.
          No cierres la pestaña; el borrador no cambia hasta que la respuesta llega entera.
        </p>
      ) : null}

      {!hasPdf ? (
        <p className="alert alert-warn text-sm">
          Este borrador no tiene el PDF del temario. Súbelo primero{" "}
          <Link href={editorHref} className="underline">
            en el editor
          </Link>{" "}
          (máximo {Math.round(MAX_AI_UPLOAD_BYTES / (1024 * 1024))} MB en este asistente): la IA
          trabaja siempre sobre ese documento.
        </p>
      ) : null}

      {status.provider === "gemini" && !status.diagnostics.keys.groq ? (
        <p className="alert alert-warn text-sm">
          <strong>Falta GROQ_API_KEY en el servidor</strong> y por eso se usa Google Gemini. Añade
          la variable en Vercel → Settings → Environment Variables (entorno <strong>Production</strong>)
          y vuelve a desplegar. Detalle: <code>docs/IA-Y-DATOS.md</code> §6.
        </p>
      ) : null}

      <form action={checkAiConnectionAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="returnTo" value={`${base}?v=${view.version}&paso=${currentStep}`} />
        <button type="submit" className="btn btn-secondary btn-sm">
          Comprobar conexión con {status.providerLabel}
        </button>
        <span className="muted text-xs">{status.message}</span>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Paso 2 · temas                                                    */}
      {/* ---------------------------------------------------------------- */}
      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">Paso 2 · Temas del curso</h2>
          <p className="muted mt-1 text-xs leading-relaxed">
            La IA propone el reparto del PDF en temas y localiza cada uno en sus páginas. Añadir,
            renombrar, reordenar o eliminar se hace con el editor de siempre; lo que ya esté escrito
            no se borra al volver aquí.
          </p>
        </div>

        <ul className="space-y-1.5 text-sm">
          {view.topics.map((topic) => {
            const pages = [...new Set(topic.screens.flatMap((screen) => screen.pages))].sort((a, b) => a - b);
            return (
              <li key={topic.id} className="flex flex-wrap items-center gap-2">
                <span className="pill pill-off">{topic.order}</span>
                <span>{topic.title}</span>
                {topic.id === "temario" ? (
                  <span className="pill pill-info">
                    PDF · {topic.documentList.reduce((sum, doc) => sum + doc.pageCount, 0)} págs.
                  </span>
                ) : (
                  <span className="pill pill-off">{topic.mandatory ? "obligatorio" : "opcional"}</span>
                )}
                <span className="muted text-xs">
                  {topic.screens.length} pantalla(s) · {topic.questions} pregunta(s)
                  {pages.length > 0 ? ` · páginas ${pages.join(", ")}` : ""}
                </span>
              </li>
            );
          })}
        </ul>

        {sourceTopic && !sourceTopic.mandatory ? (
          <p className="muted text-xs leading-relaxed">
            El tema «{sourceTopic.title}» guarda el PDF y es opcional a propósito: no tiene
            cuestionario, y un tema obligatorio sin preguntas nunca se podría superar.
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-2">
          {status.provider === "groq" ? (
            /*
             * Con Groq la propuesta va por tandas: el navegador pide una parte
             * del temario cada vez y ve el avance. Así cabe un PDF de cualquier
             * tamaño sin acercarse al corte de 300 s de la plataforma.
             */
            <TopicsBatchRunner
              courseId={courseId}
              version={view.version}
              revision={view.revision}
              disabled={readOnly || !status.configured || !hasPdf}
            />
          ) : (
            <form action={proposeTopicsAction}>
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="version" value={view.version} />
              <input type="hidden" name="revision" value={view.revision} />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={readOnly || !status.configured || !hasPdf}
              >
                {view.topics.length > 1 ? "Volver a proponer temas" : "Proponer temas con IA"}
              </button>
            </form>
          )}
          <Link href={editorHref} className="btn btn-secondary btn-sm">
            Editar temas a mano
          </Link>
        </div>
        <p className="muted text-xs leading-relaxed">
          Volver a proponer reemplaza los temas generados por IA (no el del PDF). Si ya has escrito
          pantallas o cuestionarios en ellos, conviene continuar desde el editor.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Paso 3 · pantallas                                                */}
      {/* ---------------------------------------------------------------- */}
      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">Paso 3 · Pantallas de estudio</h2>
          <p className="muted mt-1 text-xs leading-relaxed">
            Se generan por tema, sobre las páginas del PDF que le corresponden, y se convierten en
            el material real de estudio (no en un JSON): el alumnado las leerá pantalla a pantalla y
            el progreso se guarda en el servidor.
          </p>
        </div>

        {contentTopics.length === 0 ? (
          <p className="muted text-sm">
            Todavía no hay temas de contenido. Propón los temas primero (paso 2).
          </p>
        ) : (
          <form action={saveScreensAction} className="space-y-4">
            <input type="hidden" name="courseId" value={courseId} />
            <input type="hidden" name="version" value={view.version} />
            <input type="hidden" name="revision" value={view.revision} />

            {view.topics.map((topic) => (
              <fieldset key={topic.id} className="rounded-lg border border-[var(--line)] p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
                  {topic.title} · {topic.screens.length} pantalla(s)
                  {topic.id === "temario" ? " · PDF" : ""}
                </legend>

                <input type="hidden" name={`pantallas:${topic.id}:count`} value={topic.screens.length} />

                {topic.screens.length === 0 ? (
                  <p className="muted text-xs">
                    Sin pantallas todavía.{" "}
                    {topic.id === "temario"
                      ? "El tema del PDF no necesita pantallas: su contenido es el documento."
                      : "Genera las pantallas con IA o escríbelas en el editor."}
                  </p>
                ) : null}

                {topic.screens.map((screen, index) => {
                  const prefix = `pantallas:${topic.id}:${index}`;
                  return (
                    <div key={screen.id} className="mt-3 space-y-2 border-t border-[var(--line)] pt-3 first:mt-0 first:border-0 first:pt-0">
                      <input type="hidden" name={`${prefix}:id`} value={screen.id} />
                      <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                        <div>
                          <label className="label" htmlFor={`${prefix}:title`}>
                            Pantalla {index + 1} · título
                          </label>
                          <input
                            id={`${prefix}:title`}
                            name={`${prefix}:title`}
                            className="input"
                            defaultValue={screen.title}
                            maxLength={120}
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`${prefix}:pages`}>
                            Páginas del PDF
                          </label>
                          <input
                            id={`${prefix}:pages`}
                            name={`${prefix}:pages`}
                            className="input mono"
                            defaultValue={screen.pages.join(", ")}
                            placeholder="3, 4"
                          />
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <label className="label" htmlFor={`${prefix}:paragraphs`}>
                            Explicación (un párrafo por línea)
                          </label>
                          <textarea
                            id={`${prefix}:paragraphs`}
                            name={`${prefix}:paragraphs`}
                            className="input"
                            rows={4}
                            defaultValue={screen.paragraphs.join("\n")}
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`${prefix}:bullets`}>
                            Conceptos, pasos o ejemplos (uno por línea)
                          </label>
                          <textarea
                            id={`${prefix}:bullets`}
                            name={`${prefix}:bullets`}
                            className="input"
                            rows={4}
                            defaultValue={screen.bullets.join("\n")}
                          />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs muted">
                        <input type="checkbox" name={`${prefix}:delete`} />
                        Quitar esta pantalla del tema
                      </label>
                    </div>
                  );
                })}

                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_8rem]">
                  <div>
                    <label className="label" htmlFor={`pantallas:${topic.id}:newTitle`}>
                      Añadir pantalla · título
                    </label>
                    <input
                      id={`pantallas:${topic.id}:newTitle`}
                      name={`pantallas:${topic.id}:newTitle`}
                      className="input"
                      maxLength={120}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`pantallas:${topic.id}:newParagraphs`}>
                      Explicación
                    </label>
                    <input
                      id={`pantallas:${topic.id}:newParagraphs`}
                      name={`pantallas:${topic.id}:newParagraphs`}
                      className="input"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor={`pantallas:${topic.id}:newPages`}>
                      Páginas
                    </label>
                    <input
                      id={`pantallas:${topic.id}:newPages`}
                      name={`pantallas:${topic.id}:newPages`}
                      className="input mono"
                      placeholder="3, 4"
                    />
                  </div>
                </div>
              </fieldset>
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="btn btn-primary btn-sm" disabled={readOnly}>
                Guardar correcciones de pantallas
              </button>
              <span className="muted text-xs">
                Se guardan solo las pantallas: ni los temas ni los cuestionarios se tocan.
              </span>
            </div>
          </form>
        )}

        {contentTopics.length > 0 ? (
          <div className="space-y-2 border-t border-[var(--line)] pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide muted">
              Generar pantallas con IA
            </p>
            {contentTopics.map((topic) => (
              <form
                key={topic.id}
                action={generateScreensAction}
                className="flex flex-wrap items-end gap-2"
              >
                <input type="hidden" name="courseId" value={courseId} />
                <input type="hidden" name="version" value={view.version} />
                <input type="hidden" name="revision" value={view.revision} />
                <input type="hidden" name="topicId" value={topic.id} />
                <span className="text-sm">{topic.title}</span>
                <div>
                  <label className="label" htmlFor={`pantallas-${topic.id}`}>
                    Pantallas (opcional)
                  </label>
                  <input
                    id={`pantallas-${topic.id}`}
                    name="requestedScreens"
                    type="number"
                    min={1}
                    max={30}
                    className="input w-24"
                    placeholder="auto"
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={readOnly || !status.configured || !hasPdf}
                >
                  {topic.screens.length > 0 ? "Regenerar" : "Generar"}
                </button>
              </form>
            ))}
            <p className="muted text-xs leading-relaxed">
              Regenerar un tema reemplaza solo sus pantallas: el resto del curso y sus correcciones
              se quedan como están.
            </p>
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Paso 4 · cuestionarios                                            */}
      {/* ---------------------------------------------------------------- */}
      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">Paso 4 · Cuestionarios y examen final</h2>
          <p className="muted mt-1 text-xs leading-relaxed">
            Se apoyan en las pantallas y en el PDF. La respuesta correcta y su explicación se
            guardan aparte y nunca viajan al navegador antes de corregir. Para retocar preguntas a
            mano, usa el editor completo: allí se editan enunciado, opciones, correcta y
            explicación.
          </p>
        </div>

        <div className="space-y-2">
          {contentTopics.map((topic) => (
            <form
              key={topic.id}
              action={generateQuizAction}
              className="flex flex-wrap items-end gap-2 border-t border-[var(--line)] pt-2 first:border-0 first:pt-0"
            >
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="version" value={view.version} />
              <input type="hidden" name="revision" value={view.revision} />
              <input type="hidden" name="topicId" value={topic.id} />
              <span className="text-sm">
                {topic.title}{" "}
                <span className="muted text-xs">
                  ({topic.questions} pregunta(s) · {topic.screens.length} pantalla(s))
                </span>
              </span>
              <div>
                <label className="label" htmlFor={`preguntas-${topic.id}`}>
                  Preguntas
                </label>
                <input
                  id={`preguntas-${topic.id}`}
                  name="questionCount"
                  type="number"
                  min={1}
                  max={25}
                  defaultValue={5}
                  className="input w-24"
                />
              </div>
              <label className="flex items-center gap-1 pb-2 text-xs">
                <input type="checkbox" name="allowMultiple" />
                Permitir respuesta múltiple
              </label>
              <button
                type="submit"
                className="btn btn-secondary btn-sm"
                disabled={readOnly || !status.configured || topic.screens.length === 0}
                title={topic.screens.length === 0 ? "Genera antes las pantallas del tema" : undefined}
              >
                {topic.questions > 0 ? "Regenerar cuestionario" : "Generar cuestionario"}
              </button>
            </form>
          ))}
        </div>

        <form
          action={generateFinalExamAction}
          className="flex flex-wrap items-end gap-2 border-t border-[var(--line)] pt-3"
        >
          <input type="hidden" name="courseId" value={courseId} />
          <input type="hidden" name="version" value={view.version} />
          <input type="hidden" name="revision" value={view.revision} />
          <span className="text-sm">
            Examen final{" "}
            <span className="muted text-xs">({view.finalExamQuestions} pregunta(s))</span>
          </span>
          <div>
            <label className="label" htmlFor="final-count">
              Preguntas
            </label>
            <input
              id="final-count"
              name="questionCount"
              type="number"
              min={1}
              max={25}
              defaultValue={10}
              className="input w-24"
            />
          </div>
          <label className="flex items-center gap-1 pb-2 text-xs">
            <input type="checkbox" name="allowMultiple" defaultChecked />
            Permitir respuesta múltiple
          </label>
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            disabled={readOnly || !status.configured}
          >
            {view.finalExamQuestions > 0 ? "Regenerar examen final" : "Generar examen final"}
          </button>
        </form>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Paso 5 · revisión                                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold">Paso 5 · Revisión y publicación</h2>
          <p className="muted mt-1 text-xs leading-relaxed">
            Nada de lo generado se publica solo. La publicación es el botón de siempre y vuelve a
            comprobar el contenido completo.
          </p>
        </div>

        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <p className="stat-value">{view.errors.length}</p>
            <p className="stat-label">problemas que impiden publicar</p>
          </div>
          <div>
            <p className="stat-value">{view.warnings.length}</p>
            <p className="stat-label">avisos de calidad</p>
          </div>
          <div>
            <p className="stat-value">{view.topics.filter((topic) => topic.questions > 0).length}</p>
            <p className="stat-label">temas con cuestionario</p>
          </div>
        </div>

        {view.errors.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {view.errors.slice(0, 8).map((issue) => (
              <li key={`${issue.code}-${issue.path}`} className="alert alert-error">
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}

        {view.warnings.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {view.warnings.slice(0, 8).map((issue) => (
              <li key={`${issue.code}-${issue.path}`} className="alert alert-warn">
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Link href={editorHref} className="btn btn-secondary btn-sm">
            Revisar todo en el editor
          </Link>
          <Link href={`/admin/cursos/${courseId}?v=${view.version}`} className="btn btn-primary btn-sm">
            Ir a publicar
          </Link>
        </div>
      </section>
    </div>
  );
}
