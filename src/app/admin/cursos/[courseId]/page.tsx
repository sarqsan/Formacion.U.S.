import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminCourseDetail } from "@/server/portal";
import { validateCourseVersion } from "@/domain/courses/content";
import {
  newDraftAction,
  publishAction,
  saveDraftAction,
} from "@/app/actions/demo";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  creado: "Curso creado. Todavía no tiene versiones: no está publicado ni visible para el alumnado.",
  guardado: "Borrador guardado. El contenido publicado no ha cambiado.",
  publicada: "Versión publicada. Quien tenía el curso empezado lo repetirá desde el principio.",
  borrador: "Versión nueva creada en borrador a partir de la publicada.",
};

const STATUS_LABEL: Record<string, string> = {
  published: "Publicada",
  draft: "Borrador",
  archived: "Archivada",
};

export default async function AdminCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ v?: string; ok?: string; error?: string; revisar?: string }>;
}) {
  const { courseId } = await params;
  const { v, ok, error, revisar } = await searchParams;

  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const requestedVersion = Number(v);
  const detail = await adminCourseDetail(
    session.actor,
    courseId,
    Number.isFinite(requestedVersion) && requestedVersion > 0 ? requestedVersion : undefined,
  );

  if (!detail) notFound();

  const selected = detail.selected;
  const issues = selected?.definition ? validateCourseVersion(selected.definition) : [];
  const isDraft = selected?.status === "draft";

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
        / <span>{detail.title}</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Curso</p>
          <h1 className="page-title mt-1">{detail.title}</h1>
          <p className="muted mono mt-1 text-xs">{detail.courseId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {detail.versions.length > 0 ? (
            <Link
              href={`/admin/cursos/${detail.courseId}?v=${detail.publishedVersion ?? detail.versions[0].version}`}
              className="btn btn-secondary"
            >
              Ver estructura
            </Link>
          ) : null}
          {detail.publishedVersion !== null ? (
            <form action={newDraftAction}>
              <input type="hidden" name="courseId" value={detail.courseId} />
              <input type="hidden" name="fromVersion" value={detail.publishedVersion} />
              <button type="submit" className="btn btn-secondary">
                Nueva versión en borrador
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {ok && MESSAGES[ok] ? <p className="alert alert-ok">{MESSAGES[ok]}</p> : null}
      {error ? <p className="alert alert-error">{error}</p> : null}

      <div className="flex flex-wrap gap-1.5">
        {detail.versions.map((version) => (
          <Link
            key={version.version}
            href={`/admin/cursos/${detail.courseId}?v=${version.version}`}
            className={version.version === selected?.version ? "pill pill-info" : "pill pill-off"}
          >
            v{version.version} · {STATUS_LABEL[version.status] ?? version.status}
          </Link>
        ))}
      </div>

      {!selected ? (
        <div className="card p-5 muted text-sm">
          <p className="font-semibold text-[var(--foreground)]">Este curso no tiene versiones.</p>
          <p className="mt-1">
            Se creó vacío a propósito: no está publicado, no aparece en el catálogo del alumnado y
            no se puede matricular a nadie en él.
          </p>
        </div>
      ) : (
        <>
          <section className="card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                Versión {selected.version} ·{" "}
                <span className={selected.status === "draft" ? "pill pill-warn" : "pill pill-ok"}>
                  {STATUS_LABEL[selected.status] ?? selected.status}
                </span>
              </h2>
              {selected.publishedAt ? (
                <span className="muted text-xs">
                  Publicada el {new Date(selected.publishedAt).toLocaleString("es-ES")}
                </span>
              ) : null}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="stat">
                <p className="stat-value">{selected.topics.length}</p>
                <p className="stat-label">Temas</p>
              </div>
              <div className="stat">
                <p className="stat-value">
                  {selected.topics.reduce((sum, topic) => sum + topic.documents.length, 0)}
                </p>
                <p className="stat-label">Documentos</p>
              </div>
              <div className="stat">
                <p className="stat-value">
                  {selected.topics.reduce((sum, topic) => sum + topic.questions, 0) +
                    selected.finalExamQuestions}
                </p>
                <p className="stat-label">Preguntas</p>
              </div>
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide muted">
                Validación del contenido
              </h3>
              {issues.length === 0 ? (
                <p className="alert alert-ok mt-2">
                  Sin problemas detectados: temas ordenados, todos con cuestionario si son
                  obligatorios, y examen final definido.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {issues.map((issue) => (
                    <li key={`${issue.code}-${issue.path}`} className="alert alert-error">
                      <span className="mono text-xs">{issue.path}</span> · {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {revisar ? (
                <p className="muted mt-2 text-xs">
                  La validación se ejecuta con el mismo código que bloquea una publicación.
                </p>
              ) : null}
            </div>
          </section>

          {isDraft && selected.definition ? (
            <section className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Editar borrador</h2>
                  <p className="muted mt-1 text-xs">
                    Título, descripción, orden de temas y pantallas. Las preguntas no se editan
                    todavía (ver hoja de ruta).
                  </p>
                </div>
                <form action={publishAction}>
                  <input type="hidden" name="courseId" value={detail.courseId} />
                  <input type="hidden" name="version" value={selected.version} />
                  <button type="submit" className="btn btn-primary" disabled={issues.length > 0}>
                    Publicar versión {selected.version}
                  </button>
                </form>
              </div>

              {issues.length > 0 ? (
                <p className="alert alert-warn mt-3">
                  No se puede publicar hasta corregir los problemas de validación.
                </p>
              ) : null}

              <form action={saveDraftAction} className="mt-4 space-y-4">
                <input type="hidden" name="courseId" value={detail.courseId} />
                <input type="hidden" name="version" value={selected.version} />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="title">
                      Título del curso
                    </label>
                    <input
                      id="title"
                      name="title"
                      className="input"
                      defaultValue={selected.definition.title}
                      required
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="description">
                      Descripción
                    </label>
                    <input
                      id="description"
                      name="description"
                      className="input"
                      defaultValue={selected.definition.description ?? ""}
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {selected.definition.topics.map((topic) => (
                    <fieldset key={topic.id} className="rounded-lg border border-[var(--line)] p-3">
                      <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
                        Tema {topic.id}
                      </legend>
                      <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
                        <div>
                          <label className="label" htmlFor={`topic:${topic.id}:title`}>
                            Título del tema
                          </label>
                          <input
                            id={`topic:${topic.id}:title`}
                            name={`topic:${topic.id}:title`}
                            className="input"
                            defaultValue={topic.title}
                            required
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
                            max={selected.definition?.topics.length ?? 1}
                            defaultValue={topic.order}
                          />
                        </div>
                      </div>

                      <div className="mt-2 space-y-2">
                        {topic.documents.map((document) => (
                          <div
                            key={document.id}
                            className="grid gap-2 rounded-md bg-[#f8f9f6] p-2 sm:grid-cols-[1fr_6rem]"
                          >
                            <div>
                              <label className="label" htmlFor={`doc:${document.id}:title`}>
                                Pantalla / documento
                              </label>
                              <input
                                id={`doc:${document.id}:title`}
                                name={`doc:${document.id}:title`}
                                className="input"
                                defaultValue={document.title}
                                required
                              />
                            </div>
                            <div>
                              <label className="label" htmlFor={`doc:${document.id}:pages`}>
                                Pantallas
                              </label>
                              <input
                                id={`doc:${document.id}:pages`}
                                name={`doc:${document.id}:pages`}
                                className="input"
                                type="number"
                                min={1}
                                max={5000}
                                defaultValue={document.pageCount}
                              />
                            </div>
                          </div>
                        ))}
                        <p className="muted text-xs">
                          {topic.quiz.length} pregunta(s) en el cuestionario del tema. Añadir o
                          quitar preguntas cambiará la clave de corrección: queda fuera de esta
                          entrega para no reescribir el editor a medias.
                        </p>
                      </div>
                    </fieldset>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" className="btn btn-primary">
                    Guardar borrador
                  </button>
                  <span className="muted text-xs">
                    Guardar no publica: los alumnos siguen viendo la versión publicada.
                  </span>
                </div>
              </form>
            </section>
          ) : (
            <section className="card p-5">
              <h2 className="text-sm font-semibold">Contenido publicado</h2>
              <p className="muted mt-1 text-xs">
                Una versión publicada es inmutable. Para cambiar el temario, crea una versión nueva.
              </p>

              <div className="step-list mt-3">
                {selected.topics.map((topic) => (
                  <div key={topic.id} className="step">
                    <span className="step-index">{topic.order}</span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{topic.title}</span>
                        {topic.mandatory ? (
                          <span className="pill pill-info">Obligatorio</span>
                        ) : (
                          <span className="pill pill-off">Opcional</span>
                        )}
                        <span className="pill pill-off">{topic.questions} preguntas</span>
                      </div>
                      <ul className="muted mt-1 text-xs">
                        {topic.documents.map((document) => (
                          <li key={document.id}>
                            {document.title} · {document.pageCount} pantallas
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
                <div className="step">
                  <span className="step-index">★</span>
                  <div>
                    <span className="text-sm font-semibold">Examen final</span>
                    <p className="muted mt-1 text-xs">
                      {selected.finalExamQuestions} preguntas · se abre al superar los temas
                      obligatorios
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
