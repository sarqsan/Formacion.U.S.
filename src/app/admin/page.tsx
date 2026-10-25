import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { accounts as listAccounts, adminCourses, adminEnrollments, adminOverview } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending_activation: "Pendiente de activación",
  active: "Activa",
  disabled: "Deshabilitada",
};

const STATUS_CLASS: Record<string, string> = {
  pending_activation: "pill pill-warn",
  active: "pill pill-ok",
  disabled: "pill pill-error",
};

export default async function AdminPage() {
  const session = await getUiSession();

  if (session.mode === "unconfigured") {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-6">
          <h1 className="page-title">Administración</h1>
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
  if (actor.role !== "admin") redirect("/panel");

  // Mismo código para las dos persistencias: el portal activo decide si esto
  // se lee de Firestore o del almacén sintético. Las funciones de lectura
  // vuelven a comprobar el rol en el servidor.
  let overview: Awaited<ReturnType<typeof adminOverview>>;
  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  let courses: Awaited<ReturnType<typeof adminCourses>>;
  let enrollments: Awaited<ReturnType<typeof adminEnrollments>>;
  try {
    [overview, accounts, courses, enrollments] = await Promise.all([
      adminOverview(actor),
      listAccounts(actor),
      adminCourses(actor),
      adminEnrollments(actor),
    ]);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }
  const pendingEnrollments = enrollments.filter((row) => !row.completed).slice(0, 5);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Administración</p>
          <h1 className="page-title mt-1">Resumen</h1>
          <p className="muted mt-1 text-sm">
            Datos leídos de la persistencia activa: {session.mode === "demo" ? "almacén sintético de la demostración" : "Firestore"}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/cursos/ia" className="btn btn-primary">
            Crear curso con IA
          </Link>
          <Link href="/admin/cursos" className="btn btn-secondary">
            Gestionar cursos
          </Link>
          <Link href="/admin/cursos/nuevo" className="btn btn-secondary">
            Nuevo curso
          </Link>
          <Link href="/admin/matriculas" className="btn btn-secondary">
            Matrículas
          </Link>
        </div>
      </section>

      <section className="grid-stats">
        <div className="stat">
          <p className="stat-value">{overview.accounts}</p>
          <p className="stat-label">Cuentas</p>
          <p className="muted mt-1 text-xs">
            {overview.activeAccounts} activas · {overview.pendingAccounts} pendientes
          </p>
        </div>
        <div className="stat">
          <p className="stat-value">{overview.publishedCourses}</p>
          <p className="stat-label">Cursos publicados</p>
          <p className="muted mt-1 text-xs">{overview.draftVersions} borrador(es) en preparación</p>
        </div>
        <div className="stat">
          <p className="stat-value">{overview.activeEnrollments}</p>
          <p className="stat-label">Matrículas activas</p>
          <p className="muted mt-1 text-xs">{overview.enrollments} en total</p>
        </div>
        <div className="stat">
          <p className="stat-value">{overview.completions}</p>
          <p className="stat-label">Cursos completados</p>
          <p className="muted mt-1 text-xs">{overview.attempts} intentos registrados</p>
        </div>
      </section>

      <section className="grid-cards">
        <Link href="/admin/cursos/ia" className="tile">
          <span className="pill pill-ok">IA</span>
          <span className="font-semibold">Crear curso con IA</span>
          <span className="muted text-sm leading-relaxed">
            Sube el PDF del temario y la aplicación propone temas, pantallas y cuestionarios.
            Siempre queda en borrador hasta que lo revises y lo publiques.
          </span>
        </Link>
        <Link href="/admin/cursos" className="tile">
          <span className="pill pill-info">Contenido</span>
          <span className="font-semibold">Cursos y versiones</span>
          <span className="muted text-sm leading-relaxed">
            Crear la siguiente versión, editar el borrador, organizar temas y pantallas y publicar.
          </span>
        </Link>
        <Link href="/admin/personas" className="tile">
          <span className="pill pill-info">Alumnado</span>
          <span className="font-semibold">Personas</span>
          <span className="muted text-sm leading-relaxed">
            Altas, activación de cuentas y datos de cada persona. El apellido y el rol identifican
            al usuario; el identificador interno no se muestra.
          </span>
        </Link>
        <Link href="/admin/matriculas" className="tile">
          <span className="pill pill-info">Alumnado</span>
          <span className="font-semibold">Matrículas</span>
          <span className="muted text-sm leading-relaxed">
            Dar o quitar acceso a un curso. Publicar no matricula: el acceso se concede aquí.
          </span>
        </Link>
        <Link href="/admin/progreso" className="tile">
          <span className="pill pill-info">Seguimiento</span>
          <span className="font-semibold">Progreso y resultados</span>
          <span className="muted text-sm leading-relaxed">
            Qué temas ha superado cada alumno, qué le queda pendiente y qué ha contestado.
          </span>
        </Link>
        <Link href="/admin/actividad" className="tile">
          <span className="pill pill-info">Auditoría</span>
          <span className="font-semibold">Registro de actividad</span>
          <span className="muted text-sm leading-relaxed">
            Qué se hizo, quién y cuándo: altas, bajas, códigos reemitidos y contraseñas
            restablecidas. Solo lectura.
          </span>
        </Link>
        <Link href="/admin/importar" className="tile">
          <span className="pill pill-warn">Parcial</span>
          <span className="font-semibold">Importar desde Excel</span>
          <span className="muted text-sm leading-relaxed">
            Vista previa con las columnas Rol y Apellido. La creación de cuentas necesita Firebase
            Authentication.
          </span>
        </Link>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Cursos</h2>
            <Link href="/admin/cursos" className="text-xs underline muted">
              Ver todos
            </Link>
          </div>
          <div className="table-wrap mt-2">
            <table className="data">
              <thead>
                <tr>
                  <th>Curso</th>
                  <th>Publicada</th>
                  <th>Borradores</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((course) => (
                  <tr key={course.courseId}>
                    <td>
                      <Link href={`/admin/cursos/${course.courseId}`} className="font-medium underline">
                        {course.title}
                      </Link>
                    </td>
                    <td>{course.publishedVersion ? `v${course.publishedVersion}` : "—"}</td>
                    <td>{course.drafts > 0 ? course.drafts : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Seguimiento pendiente</h2>
            <Link href="/admin/progreso" className="text-xs underline muted">
              Ver progreso
            </Link>
          </div>
          {pendingEnrollments.length === 0 ? (
            <p className="muted mt-2 text-sm">No hay matrículas en curso.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {pendingEnrollments.map((row) => (
                <li key={`${row.uid}-${row.courseId}`} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.username}</span>
                    <span className="muted text-xs">{row.percent}%</span>
                  </div>
                  <div className="progress mt-1">
                    <span style={{ width: `${row.percent}%` }} />
                  </div>
                  <p className="muted mt-1 text-xs">{row.courseTitle}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Cuentas</h2>
          <div className="flex items-center gap-3">
            <span className="muted text-xs">{accounts.length} en total</span>
            <Link href="/admin/personas" className="text-xs underline">
              Gestionar personas
            </Link>
          </div>
        </div>
        <div className="table-wrap mt-2">
          <table className="data">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Nombre</th>
                <th>Rol</th>
                <th>Cuenta</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.uid}>
                  <td className="mono">{account.username}</td>
                  <td>{account.displayName}</td>
                  <td>{account.personRol}</td>
                  <td>{account.role === "admin" ? "Administrador" : "Alumno"}</td>
                  <td>
                    <span className={STATUS_CLASS[account.status] ?? "pill pill-warn"}>
                      {STATUS_LABEL[account.status] ?? account.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted mt-3 text-xs">
          El rol de administrador nunca se concede por importación: se asigna con el script de
          arranque o por otro administrador.
        </p>
      </section>
    </div>
  );
}
