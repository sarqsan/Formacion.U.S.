import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminCourseDetail } from "@/server/portal";
import { validateCourseVersion } from "@/domain/courses/content";
import { deleteCourseAction, publishAction, startDraftAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  creado: "Curso creado. Todavía no tiene versiones: no está publicado ni visible para el alumnado.",
  publicada: "Versión publicada. Quien tenía el curso empezado lo repetirá desde el principio.",
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
  searchParams: Promise<{ v?: string; ok?: string; error?: string }>;
}) {
  const { courseId } = await params;
  const { v, ok, error } = await searchParams;

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
          {detail.drafts > 0 || detail.publishedVersion !== null ? (
            <form action={startDraftAction}>
              <input type="hidden" name="courseId" value={detail.courseId} />
              <button type="submit" className="btn btn-secondary">
                {detail.drafts > 0 ? "Abrir borrador" : "Nueva versión en borrador"}
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
        <div className="card p-5 text-sm">
          <p className="font-semibold">Este curso no tiene versiones.</p>
          <p className="muted mt-1">
            Se creó vacío a propósito: no está publicado, no aparece en el catálogo del alumnado y
            no se puede matricular a nadie en él.
          </p>
          <form action={startDraftAction} className="mt-3">
            <input type="hidden" name="courseId" value={detail.courseId} />
            <button type="submit" className="btn btn-primary">
              Preparar el primer borrador
            </button>
          </form>
          <p className="muted mt-2 text-xs">
            El borrador se guarda sin publicar y puede quedar incompleto tanto tiempo como haga falta.
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
            </div>
          </section>

          {isDraft ? (
            <section className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Borrador de la versión {selected.version}</h2>
                  <p className="muted mt-1 text-xs">
                    Título, descripción y temas se editan en el editor de estructura. Publicar exige
                    que no quede ningún problema de validación.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/admin/cursos/${detail.courseId}/editar?v=${selected.version}`}
                    className="btn btn-secondary"
                  >
                    Abrir editor
                  </Link>
                  <form action={publishAction}>
                    <input type="hidden" name="courseId" value={detail.courseId} />
                    <input type="hidden" name="version" value={selected.version} />
                    <button type="submit" className="btn btn-primary" disabled={issues.length > 0}>
                      Publicar versión {selected.version}
                    </button>
                  </form>
                </div>
              </div>

              {issues.length > 0 ? (
                <p className="alert alert-warn mt-3">
                  Guardar el borrador no está bloqueado, pero no se puede publicar hasta corregir
                  estos problemas.
                </p>
              ) : null}
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

      {/*
        Eliminar solo se ofrece en cursos que nunca se han publicado: si hay una
        versión publicada, el servicio lo rechaza igualmente, pero es mejor no
        enseñar un botón que va a decir que no.
      */}
      {detail.publishedVersion === null &&
      detail.versions.every((version) => version.status === "draft") ? (
        <section className="card border-l-4 border-l-red-400 p-5">
          <h2 className="text-sm font-semibold">Eliminar este curso</h2>
          <p className="muted mt-1 text-xs">
            Borra el curso, sus versiones en borrador, sus claves de corrección y los PDF que solo
            usaba este curso. No se puede deshacer. Si hay personas matriculadas, progreso o
            certificados, la aplicación se negará y no borrará nada.
          </p>
          <form action={deleteCourseAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="courseId" value={detail.courseId} />
            <label className="text-xs">
              <span className="muted">
                Escribe <span className="mono">{detail.courseId}</span> para confirmar
              </span>
              <input
                type="text"
                name="confirmation"
                required
                autoComplete="off"
                placeholder={detail.courseId}
                className="mt-1 block w-72 rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <button type="submit" className="btn btn-secondary">
              Eliminar curso definitivamente
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
