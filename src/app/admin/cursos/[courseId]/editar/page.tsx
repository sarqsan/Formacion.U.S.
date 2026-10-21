import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminDraftEditor } from "@/server/portal";
import { saveDraftAction, startDraftAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

const OK_MESSAGES: Record<string, string> = {
  borrador:
    "Borrador creado. No se ha publicado nada: el alumnado sigue viendo la versión publicada o, si no había, nada.",
  reanudado: "Este curso ya tenía un borrador abierto: se ha reanudado, no se ha creado otro.",
  guardado: "Borrador guardado. No se ha publicado nada.",
};

const STATUS_LABEL: Record<string, string> = {
  published: "Publicada",
  draft: "Borrador",
  archived: "Archivada",
};

/**
 * EDITOR DE ESTRUCTURA DEL BORRADOR
 * =================================
 *
 * Un solo formulario guarda título, descripción y temas (crear, editar,
 * reordenar, marcar obligatorio y eliminar) en **una** escritura, con la
 * revisión del borrador en un campo oculto. Así no hay estados intermedios ni
 * dos pestañas que se pisen: la segunda recibe un aviso y recarga.
 *
 * Lo que se ve aquí no se publica. Publicar sigue viviendo en la ficha del
 * curso y exige la validación estricta.
 */
export default async function DraftEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ v?: string; ok?: string; error?: string }>;
}) {
  const { courseId } = await params;
  const { v, ok, error } = await searchParams;

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

  if (!view) notFound();

  const isDraft = view.status === "draft";
  const coursePath = `/admin/cursos/${view.courseId}`;

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
        <Link href={coursePath} className="underline">
          {view.courseTitle}
        </Link>{" "}
        / <span>Editor</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Borrador</p>
          <h1 className="page-title mt-1">Estructura del curso</h1>
          <p className="muted mt-1 text-sm">
            Versión {view.version} · {STATUS_LABEL[view.status] ?? view.status} · revisión{" "}
            {view.revision}
            {view.publishedVersion !== null ? ` · publicada v${view.publishedVersion}` : " · sin versión publicada"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={coursePath} className="btn btn-secondary">
            Volver al curso
          </Link>
          {view.publishedVersion !== null ? (
            <Link href={`${coursePath}?v=${view.publishedVersion}`} className="btn btn-secondary">
              Ver versión publicada
            </Link>
          ) : null}
        </div>
      </div>

      {ok && OK_MESSAGES[ok] ? <p className="alert alert-ok">{OK_MESSAGES[ok]}</p> : null}
      {error ? <p className="alert alert-error">{error}</p> : null}

      {!isDraft ? (
        <section className="card p-5">
          <h2 className="text-sm font-semibold">
            Esta versión está {STATUS_LABEL[view.status]?.toLowerCase() ?? view.status} y no se edita
          </h2>
          <p className="muted mt-1 text-sm">
            El contenido {view.status === "published" ? "publicado" : "histórico"} es inmutable: cambiarlo
            obliga a preparar una versión nueva, que el alumnado repetirá al publicarse.
          </p>
          <form action={startDraftAction} className="mt-3">
            <input type="hidden" name="courseId" value={view.courseId} />
            <button type="submit" className="btn btn-primary">
              Preparar la siguiente versión en borrador
            </button>
          </form>
        </section>
      ) : (
        <>
          <form action={saveDraftAction} className="card space-y-5 p-5">
            <input type="hidden" name="courseId" value={view.courseId} />
            <input type="hidden" name="version" value={view.version} />
            <input type="hidden" name="expectedRevision" value={view.revision} />

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="title">
                  Título del curso
                </label>
                <input
                  id="title"
                  name="title"
                  className="input"
                  defaultValue={view.title}
                  maxLength={200}
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="description">
                  Descripción (opcional)
                </label>
                <textarea
                  id="description"
                  name="description"
                  className="input"
                  defaultValue={view.description ?? ""}
                  maxLength={500}
                  rows={2}
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Temas</h2>
                <span className="muted text-xs">
                  {view.topics.length === 0
                    ? "Todavía no hay ninguno"
                    : `${view.topics.length} tema(s) · el orden se reajusta a 1..${view.topics.length} al guardar`}
                </span>
              </div>

              {view.topics.map((topic) => (
                <fieldset key={topic.id} className="rounded-lg border border-[var(--line)] p-3">
                  <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
                    Tema · <span className="mono">{topic.id}</span>
                  </legend>

                  <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
                    <div>
                      <label className="label" htmlFor={`topic:${topic.id}:title`}>
                        Título del tema
                      </label>
                      <input
                        id={`topic:${topic.id}:title`}
                        name={`topic:${topic.id}:title`}
                        className="input"
                        defaultValue={topic.title}
                        maxLength={200}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor={`topic:${topic.id}:order`}>
                        Orden
                      </label>
                      <input
                        id={`topic:${topic.id}:order`}
                        name={`topic:${topic.id}:order`}
                        className="input"
                        type="number"
                        min={1}
                        max={Math.max(view.topics.length, 1)}
                        defaultValue={topic.order}
                      />
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`topic:${topic.id}:mandatory`}
                        defaultChecked={topic.mandatory}
                      />
                      Obligatorio (bloquea el examen final)
                    </label>
                    <label className="flex items-center gap-2 muted">
                      <input type="checkbox" name={`delete:${topic.id}`} />
                      Eliminar del borrador
                    </label>
                  </div>

                  <p className="muted mt-2 text-xs">
                    {topic.documents} documento(s) · {topic.questions} pregunta(s). Los documentos y los
                    cuestionarios se editan en su propio bloque: aquí se conservan tal cual.
                  </p>
                </fieldset>
              ))}

              <fieldset className="rounded-lg border border-dashed border-[var(--line)] p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
                  Añadir un tema
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="newTopicId">
                      Identificador
                    </label>
                    <input
                      id="newTopicId"
                      name="newTopicId"
                      className="input mono"
                      pattern="[a-z0-9][a-z0-9-]{0,63}"
                      maxLength={64}
                      placeholder="riesgos-quimicos"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="newTopicTitle">
                      Título
                    </label>
                    <input
                      id="newTopicTitle"
                      name="newTopicTitle"
                      className="input"
                      maxLength={200}
                      placeholder="Riesgos químicos"
                    />
                  </div>
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" name="newTopicMandatory" />
                  Obligatorio
                </label>
                <p className="muted mt-2 text-xs">
                  El identificador es estable: forma parte del progreso y no se puede cambiar después.
                  Para dejar el curso sin temas, marca «Eliminar» en todos y guarda.
                </p>
              </fieldset>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="btn btn-primary">
                Guardar borrador
              </button>
              <span className="muted text-xs">
                Guardar no publica. Un borrador incompleto se guarda igual; lo que falta se indica abajo.
              </span>
            </div>
          </form>

          {view.errors.length > 0 ? (
            <section className="card p-5">
              <h2 className="text-sm font-semibold">Este borrador no se puede guardar todavía</h2>
              <p className="muted mt-1 text-xs">
                Problemas de estructura en lo que ya hay guardado: corrígelos y vuelve a guardar.
              </p>
              <ul className="mt-3 space-y-1">
                {view.errors.map((issue) => (
                  <li key={`${issue.code}-${issue.path}`} className="alert alert-error">
                    <span className="mono text-xs">{issue.path}</span> · {issue.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="card p-5">
            <h2 className="text-sm font-semibold">Qué falta para poder publicar</h2>
            <p className="muted mt-1 text-xs">
              Es informativo: no impide guardar. Publicar exige cero avisos y se hace desde la ficha del
              curso.
            </p>

            {view.warnings.length === 0 ? (
              <p className="alert alert-ok mt-3">
                Nada pendiente: el contenido cumple la validación de publicación.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {view.warnings.map((issue) => (
                  <li key={`${issue.code}-${issue.path}`} className="alert alert-warn">
                    <span className="mono text-xs">{issue.path}</span> · {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
