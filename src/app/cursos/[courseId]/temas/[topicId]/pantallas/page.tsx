import Link from "next/link";
import { redirect } from "next/navigation";
import { DomainError } from "@/domain/text";
import { getUiSession } from "@/demo/session";
import { topicScreensView } from "@/server/portal";
import { readTopicScreenAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

/**
 * ESTUDIO PANTALLA A PANTALLA
 * ===========================
 *
 * El temario de un tema puede ser un PDF (lector de páginas) o pantallas de
 * estudio (texto estructurado con referencias a las páginas del PDF de origen).
 * Esta pantalla sirve el segundo caso con la misma regla que el primero:
 *
 *   · se avanza de una en una, y el servidor comprueba el orden;
 *   · abrir una pantalla no cuenta como leerla: hay que pulsar «Leído»;
 *   · al terminar la última, el tema queda leído y se abre el cuestionario.
 */
export default async function TopicScreensPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; topicId: string }>;
  searchParams: Promise<{ pantalla?: string; error?: string }>;
}) {
  const { courseId, topicId } = await params;
  const { pantalla, error } = await searchParams;
  const session = await getUiSession();

  if (session.mode === "unconfigured" || !session.actor) redirect("/login");

  const requested = Number(pantalla);

  let view;
  try {
    view = await topicScreensView(session.actor, {
      courseId,
      topicId,
      screen: Number.isFinite(requested) && requested > 0 ? requested : undefined,
    });
  } catch (caught) {
    if (caught instanceof DomainError) {
      return (
        <div className="mx-auto max-w-xl">
          <div className="card p-6">
            <h1 className="page-title">No se puede abrir este tema</h1>
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

  const screen = view.screen;
  const isLast = view.screenNumber >= view.totalScreens;

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
        /{" "}
        <Link href={`/cursos/${courseId}/temas/${view.topicId}`} className="underline">
          {view.topicTitle}
        </Link>{" "}
        / <span>Estudio</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{view.topicTitle}</p>
          <h1 className="page-title mt-1">Pantalla {view.screenNumber}</h1>
        </div>
        <div className="text-right">
          <p className="pill pill-info">
            Pantalla {view.screenNumber} de {view.totalScreens}
          </p>
          {view.finished ? <p className="pill pill-ok mt-1">Tema estudiado</p> : null}
        </div>
      </div>

      <div className="progress">
        <span style={{ width: `${(view.screenNumber / view.totalScreens) * 100}%` }} />
      </div>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {pantalla && Number(pantalla) > view.lastViewed + 1 ? (
        <p className="alert alert-warn">
          Esa pantalla todavía no está disponible: primero hay que estudiar las anteriores.
        </p>
      ) : null}

      <article className="screen-body">
        <h2 className="text-base font-semibold">{screen.title}</h2>

        <div className="prose-block mt-2">
          {screen.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>

        {screen.bullets.length > 0 ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {screen.bullets.map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        ) : null}
      </article>

      {screen.pages.length > 0 ? (
        <section className="card p-4 text-xs muted">
          <p className="font-semibold text-[var(--foreground)]">De dónde sale esta pantalla</p>
          <p className="mt-1 leading-relaxed">
            Se apoya en {screen.pages.length === 1 ? "la página" : "las páginas"}{" "}
            <span className="mono">{screen.pages.join(", ")}</span> del temario en PDF. Si algo no
            encaja con el documento, avisa a administración: el contenido se revisa antes de
            publicarse.
          </p>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: view.totalScreens }, (_, index) => {
            const number = index + 1;
            const reachable = number <= view.lastViewed + 1;
            return reachable ? (
              <Link
                key={number}
                href={`/cursos/${courseId}/temas/${view.topicId}/pantallas?pantalla=${number}`}
                className={`pill ${number === view.screenNumber ? "pill-info" : "pill-off"}`}
              >
                {number}
              </Link>
            ) : (
              <span key={number} className="pill pill-off opacity-60">
                {number}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          {view.screenNumber > 1 ? (
            <Link
              href={`/cursos/${courseId}/temas/${view.topicId}/pantallas?pantalla=${view.screenNumber - 1}`}
              className="btn btn-secondary"
            >
              Anterior
            </Link>
          ) : null}

          {view.lastViewed >= view.totalScreens ? (
            <Link href={`/cursos/${courseId}/temas/${view.topicId}`} className="btn btn-primary">
              Ir al cuestionario
            </Link>
          ) : (
            <form action={readTopicScreenAction}>
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="topicId" value={view.topicId} />
              <input type="hidden" name="screen" value={view.screenNumber} />
              <button type="submit" className="btn btn-primary">
                {isLast ? "He terminado el tema" : "Leído, continuar"}
              </button>
            </form>
          )}
        </div>
      </div>

      <p className="muted text-xs leading-relaxed">
        El servidor registra cada pantalla y rechaza abrir una posterior sin haber estudiado las
        anteriores: el orden no depende del navegador.
      </p>
    </div>
  );
}
