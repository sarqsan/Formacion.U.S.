import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { courseViewForLearner } from "@/server/portal";
import { DomainError } from "@/domain/text";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const session = await getUiSession();

  if (session.mode === "unconfigured") {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-6">
          <h1 className="page-title">Curso</h1>
          <p className="lead mt-2 text-sm">{session.message}</p>
          <Link href="/estado" className="btn btn-secondary mt-4">
            Ver el estado del sistema
          </Link>
        </div>
      </div>
    );
  }

  const actor = session.actor;
  if (!actor) redirect("/login");
  if (actor.role === "admin") redirect(`/admin/cursos/${courseId}`);

  let view;
  try {
    view = await courseViewForLearner(actor, courseId);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    if (error instanceof DomainError) {
      if (error.status === 404) notFound();
      return (
        <div className="mx-auto max-w-xl">
          <div className="card p-6">
            <h1 className="page-title">Sin acceso a este curso</h1>
            <p className="lead mt-2 text-sm">{error.message}</p>
            <Link href="/panel" className="btn btn-secondary mt-4">
              Volver a mi formación
            </Link>
          </div>
        </div>
      );
    }
    throw error;
  }

  const nextTopic = view.topics.find((topic) => !topic.quizPassed);
  const finalStepIndex = view.topics.length + 1;

  return (
    <div className="space-y-6">
      <nav className="text-xs muted">
        <Link href="/panel" className="underline">
          Mi formación
        </Link>{" "}
        / <span>Curso</span>
      </nav>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="pill pill-info">Versión {view.version}</span>
              {view.completed ? (
                <span className="pill pill-ok">Curso completado</span>
              ) : (
                <span className="pill pill-warn">En curso</span>
              )}
            </div>
            <h1 className="page-title mt-2">{view.title}</h1>
            {view.description ? <p className="lead mt-2 text-sm">{view.description}</p> : null}
          </div>
          <div className="text-right">
            <p className="stat-value">{view.percent}%</p>
            <p className="stat-label">Progreso</p>
          </div>
        </div>

        <div className="progress progress-lg mt-4">
          <span style={{ width: `${view.percent}%` }} />
        </div>

        {nextTopic ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href={
                nextTopic.documents.length > 0
                  ? `/cursos/${view.courseId}/documentos/${nextTopic.documents[0].id}`
                  : `/cursos/${view.courseId}/temas/${nextTopic.id}/pantallas`
              }
              className="btn btn-primary"
            >
              Continuar donde lo dejé
            </Link>
            <span className="muted text-xs">Siguiente: {nextTopic.title}</span>
          </div>
        ) : view.finalExam.passed ? (
          <p className="alert alert-ok mt-4">
            Has superado todos los temas y el examen final. Puedes repasar el temario cuando quieras.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href={`/cursos/${view.courseId}/examen`} className="btn btn-primary">
              Ir al examen final
            </Link>
            <span className="muted text-xs">Todos los temas están superados.</span>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Qué te queda pendiente</h2>
        {view.completed ? (
          <p className="alert alert-ok mt-2">
            Nada: has superado todos los temas y el examen final. Puedes repasar cuando quieras.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-sm">
            {view.topics.map((topic) => (
              <li key={topic.id} className="flex flex-wrap items-center gap-2">
                <span className={topic.quizPassed ? "pill pill-ok" : "pill pill-warn"}>
                  {topic.quizPassed ? "Aprobado" : "Pendiente"}
                </span>
                <span>{topic.title}</span>
                {!topic.quizPassed ? (
                  <span className="muted text-xs">
                    {topic.readComplete
                      ? "estudio hecho · falta el cuestionario"
                      : topic.documents.length > 0
                        ? `lectura ${topic.documents.reduce((sum, document) => sum + document.lastPageViewed, 0)}/${topic.documents.reduce((sum, document) => sum + document.totalPages, 0)} páginas`
                        : `estudio ${topic.screens.lastViewed}/${topic.screens.total} pantallas`}
                  </span>
                ) : null}
              </li>
            ))}
            <li className="flex flex-wrap items-center gap-2">
              <span className={view.finalExam.passed ? "pill pill-ok" : "pill pill-off"}>
                {view.finalExam.passed
                  ? "Aprobado"
                  : view.finalExam.unlocked
                    ? "Disponible"
                    : "Bloqueado"}
              </span>
              <span>Examen final</span>
            </li>
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide muted">Temario</h2>

        <div className="step-list">
          {view.topics.map((topic, index) => {
            const state = topic.quizPassed
              ? "done"
              : topic.readComplete
                ? "current"
                : index === view.topics.findIndex((item) => !item.quizPassed)
                  ? "current"
                  : "locked";

            const readDocuments = topic.documents.filter((document) => document.read).length;

            return (
              <div
                key={topic.id}
                className={`step ${state === "done" ? "step-done" : ""} ${state === "current" ? "step-current" : ""} ${state === "locked" ? "step-locked" : ""}`}
              >
                <span className="step-index">{topic.quizPassed ? "✓" : topic.order}</span>

                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{topic.title}</h3>
                    {topic.mandatory ? (
                      <span className="pill pill-info">Obligatorio</span>
                    ) : (
                      <span className="pill pill-off">Opcional</span>
                    )}
                    {topic.quizPassed ? (
                      <span className="pill pill-ok">Superado · {topic.bestScore}%</span>
                    ) : null}
                  </div>

                  <p className="muted mt-1 text-xs">
                    {topic.documents.length > 0 ? (
                      <>
                        {topic.documents.length} documento
                        {topic.documents.length === 1 ? "" : "s"} · {readDocuments} leído
                        {readDocuments === 1 ? "" : "s"}
                      </>
                    ) : (
                      <>
                        {topic.screens.total} pantalla{topic.screens.total === 1 ? "" : "s"} ·{" "}
                        {Math.min(topic.screens.lastViewed, topic.screens.total)} vista
                        {Math.min(topic.screens.lastViewed, topic.screens.total) === 1 ? "" : "s"}
                      </>
                    )}
                    {topic.attempts > 0 ? ` · ${topic.attempts} intento${topic.attempts === 1 ? "" : "s"}` : ""}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {topic.documents.map((document) => (
                      <Link
                        key={document.id}
                        href={`/cursos/${view.courseId}/documentos/${document.id}`}
                        className="pill pill-off"
                      >
                        {document.read ? "✓ " : ""}
                        {document.title} ({document.lastPageViewed}/{document.totalPages})
                      </Link>
                    ))}
                    {topic.screens.available ? (
                      <Link
                        href={`/cursos/${view.courseId}/temas/${topic.id}/pantallas`}
                        className="pill pill-off"
                      >
                        {topic.screens.completed ? "✓ " : ""}
                        Estudio por pantallas ({Math.min(topic.screens.lastViewed, topic.screens.total)}/
                        {topic.screens.total})
                      </Link>
                    ) : null}
                  </div>
                </div>

                <div className="step-actions flex flex-wrap gap-2">
                  {topic.documents.length > 0 ? (
                    <Link
                      href={`/cursos/${view.courseId}/documentos/${topic.documents[0].id}`}
                      className="btn btn-secondary btn-sm"
                    >
                      {topic.readComplete ? "Repasar" : "Estudiar"}
                    </Link>
                  ) : null}
                  {topic.screens.available ? (
                    <Link
                      href={`/cursos/${view.courseId}/temas/${topic.id}/pantallas`}
                      className="btn btn-secondary btn-sm"
                    >
                      {topic.screens.completed ? "Repasar pantallas" : "Estudiar pantallas"}
                    </Link>
                  ) : null}
                  <Link
                    href={`/cursos/${view.courseId}/temas/${topic.id}`}
                    className={`btn btn-sm ${topic.quizAvailable ? "btn-primary" : "btn-secondary"}`}
                    aria-disabled={!topic.quizAvailable}
                    title={topic.quizAvailable ? undefined : "Termina la lectura del tema"}
                  >
                    {topic.quizPassed ? "Ver cuestionario" : "Cuestionario"}
                  </Link>
                </div>
              </div>
            );
          })}

          <div
            className={`step ${view.finalExam.passed ? "step-done" : ""} ${
              view.finalExam.unlocked && !view.finalExam.passed ? "step-current" : ""
            } ${!view.finalExam.unlocked ? "step-locked" : ""}`}
          >
            <span className="step-index">{view.finalExam.passed ? "✓" : finalStepIndex}</span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">Examen final</h3>
                {view.finalExam.passed ? (
                  <span className="pill pill-ok">Superado · {view.finalExam.bestScore}%</span>
                ) : view.finalExam.unlocked ? (
                  <span className="pill pill-warn">Disponible</span>
                ) : (
                  <span className="pill pill-off">Bloqueado</span>
                )}
              </div>
              <p className="muted mt-1 text-xs">
                {view.finalExam.unlocked
                  ? `${view.finalExam.questions.length} preguntas · hay que acertarlas todas`
                  : "Se desbloquea al superar todos los temas obligatorios."}
              </p>
            </div>
            <div className="step-actions">
              <Link
                href={`/cursos/${view.courseId}/examen`}
                className={`btn btn-sm ${view.finalExam.unlocked ? "btn-primary" : "btn-secondary"}`}
              >
                {view.finalExam.passed ? "Repasar" : "Abrir examen"}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="card p-5 text-xs muted">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Qué cuenta como superado</h2>
        <p className="mt-2 leading-relaxed">
          Un tema se supera cuando el cuestionario se responde entero y todas las respuestas son
          correctas en el mismo intento. No hay nota parcial: los intentos fallidos no restan, solo
          cuentan como intentos. La corrección la hace el servidor con la clave privada del curso;
          el navegador nunca recibe cuál es la opción correcta.
        </p>
      </section>
    </div>
  );
}
