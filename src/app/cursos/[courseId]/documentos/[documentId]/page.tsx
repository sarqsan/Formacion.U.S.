import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { documentFileSummary, readingView } from "@/server/portal";
import { PdfViewer } from "./pdf-viewer";
import { readScreenAction } from "@/app/actions/demo";
import { DomainError } from "@/domain/text";

export const dynamic = "force-dynamic";

export default async function ScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; documentId: string }>;
  searchParams: Promise<{ pantalla?: string; error?: string }>;
}) {
  const { courseId, documentId } = await params;
  const { pantalla, error } = await searchParams;
  const session = await getUiSession();

  if (session.mode === "unconfigured" || !session.actor) redirect("/login");

  const requested = Number(pantalla);

  let view;
  try {
    view = await readingView(session.actor, {
      courseId,
      documentId,
      page: Number.isFinite(requested) && requested > 0 ? requested : undefined,
    });
  } catch (caught) {
    if (caught instanceof DomainError) {
      return (
        <div className="mx-auto max-w-xl">
          <div className="card p-6">
            <h1 className="page-title">No se puede abrir este documento</h1>
            <p className="lead mt-2 text-sm">{caught.message}</p>
            <Link href={`/cursos/${courseId}`} className="btn btn-secondary mt-4">
              Volver al curso
            </Link>
          </div>
        </div>
      );
    }
    throw caught;
  }

  // ¿Se puede ofrecer el PDF? El servidor decide: cuenta, matrícula, versión
  // publicada y referencia expresa del documento. No se lee el fichero aquí.
  const file = await documentFileSummary(session.actor, documentId);

  if (view.kind === "pdf") {
    const isLastPage = view.page >= view.totalPages;
    const alreadyRead = view.lastPageViewed >= view.totalPages;

    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <nav className="text-xs muted">
          <Link href="/panel" className="underline">
            Mi formación
          </Link>{" "}
          /{" "}
          <Link href={`/cursos/${courseId}`} className="underline">
            Curso
          </Link>{" "}
          / <span>{view.topicTitle}</span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">{view.topicTitle}</p>
            <h1 className="page-title mt-1">{view.documentTitle}</h1>
          </div>
          <div className="text-right">
            <p className="pill pill-info">
              Página {view.page} de {view.totalPages}
            </p>
            {alreadyRead ? <p className="pill pill-ok mt-1">Documento leído</p> : null}
          </div>
        </div>

        <div className="progress">
          <span style={{ width: `${(view.page / view.totalPages) * 100}%` }} />
        </div>

        {error ? <p className="alert alert-error">{error}</p> : null}

        {file ? (
          <section className="card space-y-3 p-5 text-sm">
            <div>
              <h2 className="text-base font-semibold">{file.title}</h2>
              <p className="muted mt-1 text-xs leading-relaxed">
                El documento se sirve completo desde el servidor, sin URL pública ni copia en el
                navegador: se comprueba tu matrícula, la versión publicada del curso y la integridad
                del fichero en cada apertura. Se muestra con el visor del propio navegador.
              </p>
            </div>
            <PdfViewer
              src={`/api/documents/${encodeURIComponent(documentId)}/file`}
              title={file.title}
              bytes={file.bytes}
            />
          </section>
        ) : (
          <p className="alert alert-warn text-sm">
            El documento todavía no está disponible para abrirlo en PDF. Si acabas de empezar el
            curso, vuelve a intentarlo en un momento; si sigue igual, avisa a administración.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href={`/cursos/${courseId}`} className="btn btn-secondary">
            Volver al curso
          </Link>

          <div className="flex flex-wrap gap-2">
            {alreadyRead ? (
              <Link href={`/cursos/${courseId}/temas/${view.topicId}`} className="btn btn-primary">
                Ir al cuestionario
              </Link>
            ) : (
              <form action={readScreenAction}>
                <input type="hidden" name="courseId" value={courseId} />
                <input type="hidden" name="documentId" value={documentId} />
                <input type="hidden" name="page" value={view.page} />
                <button type="submit" className="btn btn-primary">
                  {isLastPage ? "He terminado el documento" : "Leído, continuar"}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  const screen = view.screens[view.page - 1];
  const isLastScreen = view.page >= view.totalPages;
  const alreadyRead = view.lastPageViewed >= view.totalPages;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <nav className="text-xs muted">
        <Link href="/panel" className="underline">
          Mi formación
        </Link>{" "}
        /{" "}
        <Link href={`/cursos/${courseId}`} className="underline">
          Curso
        </Link>{" "}
        / <span>{view.topicTitle}</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{view.topicTitle}</p>
          <h1 className="page-title mt-1">{view.documentTitle}</h1>
        </div>
        <div className="text-right">
          <p className="pill pill-info">
            Pantalla {view.page} de {view.totalPages}
          </p>
          {alreadyRead ? <p className="pill pill-ok mt-1">Documento leído</p> : null}
        </div>
      </div>

      <div className="progress">
        <span style={{ width: `${(view.page / view.totalPages) * 100}%` }} />
      </div>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {pantalla && Number(pantalla) > view.lastPageViewed + 1 ? (
        <p className="alert alert-warn">
          Esa pantalla todavía no está disponible: primero hay que leer las anteriores.
        </p>
      ) : null}

      {file ? (
        <section className="card space-y-2 p-4 text-sm">
          <h2 className="text-sm font-semibold">Documento completo en PDF</h2>
          <p className="muted text-xs leading-relaxed">
            El PDF de este documento también se puede abrir con el visor del navegador. La lectura
            guiada de arriba se mantiene igual: no cambia el progreso del curso.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={`/api/documents/${encodeURIComponent(documentId)}/file`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
            >
              Abrir el PDF en una pestaña nueva
            </a>
            <span className="muted text-xs">
              {file.pageCount} página(s) · se abre con la aplicación de PDF del dispositivo
            </span>
          </div>
        </section>
      ) : null}

      <article className="screen-body">
        <h2 className="text-base font-semibold">{screen.title}</h2>
        <div className="prose-block mt-2">
          {screen.body.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </article>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {view.screens.map((_, index) => {
            const pageNumber = index + 1;
            const reachable = pageNumber <= view.lastPageViewed + 1;
            return reachable ? (
              <Link
                key={pageNumber}
                href={`/cursos/${courseId}/documentos/${documentId}?pantalla=${pageNumber}`}
                className={`pill ${pageNumber === view.page ? "pill-info" : "pill-off"}`}
              >
                {pageNumber}
              </Link>
            ) : (
              <span key={pageNumber} className="pill pill-off opacity-60">
                {pageNumber}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          {view.page > 1 ? (
            <Link
              href={`/cursos/${courseId}/documentos/${documentId}?pantalla=${view.page - 1}`}
              className="btn btn-secondary"
            >
              Anterior
            </Link>
          ) : null}

          {view.lastPageViewed >= view.totalPages ? (
            <Link href={`/cursos/${courseId}/temas/${view.topicId}`} className="btn btn-primary">
              Ir al cuestionario
            </Link>
          ) : (
            <form action={readScreenAction}>
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="page" value={view.page} />
              <button type="submit" className="btn btn-primary">
                {isLastScreen ? "He terminado el documento" : "Leído, continuar"}
              </button>
            </form>
          )}
        </div>
      </div>

      <p className="muted text-xs leading-relaxed">
        El servidor registra cada pantalla. Si se intenta abrir una posterior sin haber leído las
        anteriores, la petición se rechaza con un aviso: el orden no depende del navegador.
      </p>
    </div>
  );
}
