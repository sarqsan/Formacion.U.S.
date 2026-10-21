import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminProgress } from "@/server/portal";

export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const rows = (await adminProgress(session.actor)).filter((row) => row.status === "active");
  const completed = rows.filter((row) => row.completed).length;
  const attempts = rows.reduce((sum, row) => sum + row.attempts.length, 0);

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        / <span>Progreso</span>
      </nav>

      <div>
        <p className="eyebrow">Seguimiento</p>
        <h1 className="page-title mt-1">Progreso y resultados</h1>
        <p className="muted mt-1 text-sm">
          Estado por matrícula: qué temas están superados, cuáles quedan y qué intentos se han
          registrado.
        </p>
      </div>

      <div className="grid-stats">
        <div className="stat">
          <p className="stat-value">{rows.length}</p>
          <p className="stat-label">Matrículas activas</p>
        </div>
        <div className="stat">
          <p className="stat-value">{completed}</p>
          <p className="stat-label">Completadas</p>
        </div>
        <div className="stat">
          <p className="stat-value">{attempts}</p>
          <p className="stat-label">Intentos</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card p-5 muted text-sm">No hay matrículas activas todavía.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <article key={`${row.uid}-${row.courseId}`} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">
                    <span className="mono">{row.username}</span> · {row.courseTitle}
                  </h2>
                  <p className="muted mt-1 text-xs">
                    {row.personRol} · {row.topicsPassed} de {row.topicsTotal} temas ·{" "}
                    {row.finalExamPassed ? "examen final superado" : "examen final pendiente"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {row.completed ? (
                    <span className="pill pill-ok">Completado</span>
                  ) : (
                    <span className="pill pill-warn">En curso</span>
                  )}
                  <span className="badge badge-info">{row.percent}%</span>
                </div>
              </div>

              <div className="progress mt-3">
                <span style={{ width: `${row.percent}%` }} />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide muted">Pendiente</p>
                  {row.pending.length === 0 ? (
                    <p className="alert alert-ok mt-2 text-xs">Nada pendiente.</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {row.pending.map((item) => (
                        <li key={item} className="flex items-center gap-2">
                          <span aria-hidden="true">○</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide muted">
                    Últimos intentos
                  </p>
                  {row.attempts.length === 0 ? (
                    <p className="muted mt-2 text-xs">Sin intentos registrados.</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs">
                      {row.attempts.slice(0, 4).map((attempt, index) => (
                        <li
                          key={`${attempt.at}-${index}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="muted">
                            {new Date(attempt.at).toLocaleString("es-ES")} ·{" "}
                            {attempt.assessmentType === "final"
                              ? "Examen final"
                              : `Tema ${attempt.topicId}`}
                          </span>
                          <span className={attempt.passed ? "pill pill-ok" : "pill pill-error"}>
                            {attempt.correctCount}/{attempt.totalQuestions} · {attempt.score}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="muted text-xs">
        Los intentos son inmutables: guardan qué se contestó y cómo se corrigió. La clave de
        corrección no se muestra en esta pantalla ni se envía al navegador del alumno.
      </p>
    </div>
  );
}
