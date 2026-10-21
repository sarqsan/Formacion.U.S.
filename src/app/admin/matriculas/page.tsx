import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminCourses, adminEnrollments, learners as listLearners } from "@/server/portal";
import { enrollAction, revokeAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

export default async function EnrollmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { ok, error } = await searchParams;
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const [rows, courses, learners] = await Promise.all([
    adminEnrollments(session.actor),
    adminCourses(session.actor),
    listLearners(session.actor),
  ]);
  const published = courses.filter((course) => course.publishedVersion !== null);

  const active = rows.filter((row) => row.status === "active");
  const revoked = rows.filter((row) => row.status !== "active");

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        / <span>Matrículas</span>
      </nav>

      <div>
        <p className="eyebrow">Alumnado</p>
        <h1 className="page-title mt-1">Matrículas</h1>
        <p className="muted mt-1 text-sm">
          Publicar un curso no da acceso a nadie. El acceso se concede aquí y se puede retirar sin
          borrar el progreso.
        </p>
      </div>

      {ok ? (
        <p className="alert alert-ok">
          {ok === "revocada"
            ? "Matrícula revocada. El progreso se conserva por si se vuelve a matricular."
            : "Matrícula activa."}
        </p>
      ) : null}
      {error ? <p className="alert alert-error">{error}</p> : null}

      <section className="card p-5">
        <h2 className="text-sm font-semibold">Matricular a una persona</h2>
        <form action={enrollAction} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <label className="label" htmlFor="uid">
              Alumno
            </label>
            <select id="uid" name="uid" className="select" required>
              {learners.map((account) => (
                <option key={account.uid} value={account.uid}>
                  {account.username} · {account.personRol} ·{" "}
                  {account.status === "active" ? "activa" : "pendiente"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="courseId">
              Curso
            </label>
            <select id="courseId" name="courseId" className="select" required>
              {published.map((course) => (
                <option key={course.courseId} value={course.courseId}>
                  {course.title} (v{course.publishedVersion})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">
            Matricular
          </button>
        </form>
        <p className="muted mt-2 text-xs">
          Matricular dos veces a la misma persona no duplica nada: la matrícula es única por usuario
          y curso.
        </p>
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Matrículas activas</h2>
          <span className="muted text-xs">{active.length}</span>
        </div>
        <div className="table-wrap mt-2">
          <table className="data">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Rol</th>
                <th>Curso</th>
                <th>Progreso</th>
                <th>Alta</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    Sin matrículas activas.
                  </td>
                </tr>
              ) : (
                active.map((row) => (
                  <tr key={`${row.uid}-${row.courseId}`}>
                    <td className="mono">{row.username}</td>
                    <td>{row.personRol}</td>
                    <td>{row.courseTitle}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="progress w-24">
                          <span style={{ width: `${row.percent}%` }} />
                        </div>
                        <span className="muted text-xs">
                          {row.percent}% · {row.topicsPassed}/{row.topicsTotal} temas
                        </span>
                      </div>
                    </td>
                    <td className="muted text-xs">
                      {new Date(row.enrolledAt).toLocaleDateString("es-ES")}
                    </td>
                    <td>
                      <form action={revokeAction}>
                        <input type="hidden" name="uid" value={row.uid} />
                        <input type="hidden" name="courseId" value={row.courseId} />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          Revocar
                        </button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {revoked.length > 0 ? (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Revocadas</h2>
          <p className="muted mt-1 text-xs">
            Sin acceso, pero el progreso sigue guardado. Al volver a matricular, se retoma donde
            estaba.
          </p>
          <div className="table-wrap mt-2">
            <table className="data">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Curso</th>
                  <th>Progreso guardado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {revoked.map((row) => (
                  <tr key={`${row.uid}-${row.courseId}`}>
                    <td className="mono">{row.username}</td>
                    <td>{row.courseTitle}</td>
                    <td className="muted">{row.percent}%</td>
                    <td>
                      <form action={enrollAction}>
                        <input type="hidden" name="uid" value={row.uid} />
                        <input type="hidden" name="courseId" value={row.courseId} />
                        <button type="submit" className="btn btn-secondary btn-sm">
                          Reactivar
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
