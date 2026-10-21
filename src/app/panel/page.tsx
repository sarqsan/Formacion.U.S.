import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { accountProfile, coursesForLearner } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

export default async function PanelPage() {
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
  try {
    [account, courses] = await Promise.all([accountProfile(actor), coursesForLearner(actor)]);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }

  const completed = courses.filter((course) => course.completed).length;

  return (
    <div className="space-y-6">
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

              <div className="mt-4 flex items-center justify-between gap-2">
                <Link href={`/cursos/${course.courseId}`} className="btn btn-primary btn-sm">
                  {course.completed ? "Repasar el curso" : "Continuar"}
                </Link>
                {course.completed ? <span className="pill pill-ok">Completado</span> : null}
              </div>
            </article>
          ))}
        </section>
      )}

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
