import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { accountProfile, coursesForLearner, learnerCourseHistory } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";
import { issueCertificateAction } from "@/app/actions/certificates";

export const dynamic = "force-dynamic";

/** Fecha corta y estable: el servidor no debe depender de la zona del navegador. */
function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export default async function PanelPage({
  searchParams,
}: {
  searchParams: Promise<{ certificado?: string; motivo?: string }>;
}) {
  const { certificado, motivo } = await searchParams;
  const session = await getUiSession();

  if (session.mode === "unconfigured") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card p-6">
          <h1 className="page-title">Mi formación</h1>
          <p className="lead mt-2 text-sm">{session.message}</p>
          <pre className="mono mt-4 overflow-x-auto rounded-md bg-[#f4f6f3] p-3 text-xs">
            DEMO_MODE=1 npm run dev
          </pre>
        </div>
      </div>
    );
  }

  const actor = session.actor;
  if (!actor) redirect("/login");
  if (actor.role === "admin") redirect("/admin");

  // La misma llamada sirve para la demostración y para Firestore: el portal
  // activo decide de dónde vienen los datos.
  let account: Awaited<ReturnType<typeof accountProfile>> = null;
  let courses: Awaited<ReturnType<typeof coursesForLearner>> = [];
  let history: Awaited<ReturnType<typeof learnerCourseHistory>> = { entries: [], unresolved: 0 };
  try {
    [account, courses, history] = await Promise.all([
      accountProfile(actor),
      coursesForLearner(actor),
      learnerCourseHistory(actor),
    ]);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }

  const completed = courses.filter((course) => course.completed).length;

  return (
    <div className="space-y-6">
      {certificado === "error" ? (
        <p className="alert alert-warn text-sm">
          No se ha podido emitir el certificado: {motivo ?? "inténtalo de nuevo."}
        </p>
      ) : null}

      <section className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Mi formación</p>
            <h1 className="page-title mt-1">
              Hola, {account?.displayName ?? "alumno"}
            </h1>
            <p className="muted mt-1 text-sm">
              {account ? (
                <>
                  Usuario <span className="mono">{account.username}</span> · {account.personRol}
                </>
              ) : (
                "Sesión iniciada"
              )}
            </p>
          </div>
          <div className="grid-stats">
            <div className="stat">
              <p className="stat-value">{courses.length}</p>
              <p className="stat-label">Cursos asignados</p>
            </div>
            <div className="stat">
              <p className="stat-value">{completed}</p>
              <p className="stat-label">Completados</p>
            </div>
          </div>
        </div>
      </section>

      {courses.length === 0 ? (
        <div className="card p-6">
          <h2 className="text-sm font-semibold">Todavía no tienes cursos</h2>
          <p className="muted mt-2 text-sm leading-relaxed">
            Publicar un curso no da acceso: administración tiene que matricularte. Cuando lo haga,
            aparecerá aquí con su temario y tu progreso.
          </p>
          {session.mode === "demo" ? (
            <p className="muted mt-3 text-xs">
              En la demostración puedes matricularte desde el panel de administración
              («Matrículas»).
            </p>
          ) : null}
        </div>
      ) : (
        <section className="grid-cards">
          {courses.map((course) => (
            <article key={course.courseId} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="pill pill-off">Versión {course.version}</span>
                  <h2 className="mt-2 text-base font-semibold leading-snug">{course.title}</h2>
                </div>
                <div className="ring" style={{ ["--value" as string]: `${course.percent}%` }}>
                  <span>{course.percent}%</span>
                </div>
              </div>

              {course.description ? (
                <p className="muted mt-2 text-sm leading-relaxed">{course.description}</p>
              ) : null}

              <div className="mt-3">
                <div className="progress">
                  <span style={{ width: `${course.percent}%` }} />
                </div>
                <p className="muted mt-2 text-xs">
                  {course.topicsPassed} de {course.topicsTotal} temas superados ·{" "}
                  {course.completed ? "curso completado" : course.nextStep}
                </p>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <Link href={`/cursos/${course.courseId}`} className="btn btn-primary btn-sm">
                  {course.completed ? "Repasar el curso" : "Continuar"}
                </Link>
                {course.completed ? (
                  /*
                    El botón solo aparece con el curso completado, pero la
                    decisión real la toma el servicio: vuelve a leer el progreso
                    y exige `completedAt`. Un formulario (y no un enlace) porque
                    emite un documento: recargar la página o compartir la URL no
                    debe crear certificados.
                  */
                  <form action={issueCertificateAction}>
                    <input type="hidden" name="courseId" value={course.courseId} />
                    <input type="hidden" name="volver" value="/panel" />
                    <button type="submit" className="btn btn-secondary btn-sm">
                      Obtener certificado
                    </button>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}

      {/*
        Historial: lo archivado al publicarse una versión nueva. Se lee de
        `progressHistory`, que antes se escribía y no se mostraba en ninguna
        parte. No sustituye al progreso vivo: lo conserva.
      */}
      <section className="card p-5" aria-labelledby="historial-titulo">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="historial-titulo" className="text-sm font-semibold">
              Historial de formación
            </h2>
            <p className="muted mt-1 text-xs leading-relaxed">
              Lo que ya cursaste en versiones anteriores de cada curso. Se conserva aunque el curso
              se actualice, y no se puede modificar.
            </p>
          </div>
          {history.entries.length > 0 ? (
            <span className="pill pill-off">{history.entries.length} registros</span>
          ) : null}
        </div>

        {history.entries.length === 0 ? (
          <p className="muted mt-3 text-sm leading-relaxed">
            Todavía no hay versiones anteriores. Cuando se publique una versión nueva de un curso que
            estés cursando, aquí quedará el registro de la anterior con su resultado.
          </p>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Curso</th>
                  <th scope="col">Versión</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">Temas</th>
                  <th scope="col">Examen final</th>
                  <th scope="col">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {history.entries.map((entry) => (
                  <tr key={`${entry.courseId}-v${entry.version}`}>
                    <td className="font-medium">
                      {entry.courseTitle}
                      {entry.supersededBy != null ? (
                        <span className="muted block text-xs">
                          sustituido por la versión {entry.supersededBy}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className="pill pill-off">v{entry.version}</span>
                    </td>
                    <td>
                      {entry.completed ? (
                        <span className="pill pill-ok">Completado</span>
                      ) : (
                        <span className="pill pill-off">Incompleto</span>
                      )}
                    </td>
                    <td className="mono text-xs">
                      {entry.topicsPassed}/{entry.topicsTotal}
                    </td>
                    <td className="mono text-xs">
                      {entry.finalExamPassed ? "Apto" : "No apto"}
                      {entry.finalScore > 0 ? ` · ${entry.finalScore}%` : ""}
                    </td>
                    <td className="muted text-xs">{formatDate(entry.completedAt ?? entry.archivedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {history.unresolved > 0 ? (
          <p className="muted mt-3 text-xs">
            {history.unresolved === 1
              ? "Hay 1 registro de un curso que ya no está en el catálogo y no se muestra."
              : `Hay ${history.unresolved} registros de cursos que ya no están en el catálogo y no se muestran.`}
          </p>
        ) : null}
      </section>

      <section className="card p-5 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Cómo funciona el progreso</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Cada documento se lee pantalla a pantalla y el servidor registra hasta dónde llegaste.</li>
          <li>El cuestionario del tema se abre al terminar su lectura y se repite hasta acertar todo.</li>
          <li>El examen final se desbloquea al superar todos los temas obligatorios.</li>
          <li>Si se publica una versión nueva del curso, se repite desde el principio sin perder el histórico.</li>
        </ul>
      </section>
    </div>
  );
}
