import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminCourses } from "@/server/portal";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  published: "Publicada",
  draft: "Borrador",
  archived: "Archivada",
};

const STATUS_CLASS: Record<string, string> = {
  published: "pill pill-ok",
  draft: "pill pill-warn",
  archived: "pill pill-off",
};

export default async function AdminCoursesPage() {
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const courses = await adminCourses(session.actor);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Contenido</p>
          <h1 className="page-title mt-1">Cursos y versiones</h1>
          <p className="muted mt-1 text-sm">
            Lo publicado no se edita: los cambios se preparan en un borrador y se publican como
            versión nueva.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/cursos/nuevo" className="btn btn-primary">
            Nuevo curso
          </Link>
          <Link href="/admin" className="btn btn-secondary">
            Volver al resumen
          </Link>
        </div>
      </div>

      <div className="space-y-3">
        {courses.map((course) => (
          <article key={course.courseId} className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{course.title}</h2>
                <p className="muted mono mt-1 text-xs">{course.courseId}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="pill pill-info">
                  {course.publishedVersion ? `Publicada v${course.publishedVersion}` : "Sin publicar"}
                </span>
                {course.publishedVersion === null && course.lastDraftVersion === null ? (
                  <span className="pill pill-off">Sin versiones</span>
                ) : null}
                {course.drafts > 0 ? (
                  <span className="pill pill-warn">{course.drafts} borrador(es)</span>
                ) : null}
                <Link
                  href={`/admin/cursos/${course.courseId}`}
                  className="btn btn-primary btn-sm"
                >
                  Abrir
                </Link>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {course.versions.map((version) => (
                <Link
                  key={version.version}
                  href={`/admin/cursos/${course.courseId}?v=${version.version}`}
                  className={STATUS_CLASS[version.status] ?? "pill pill-off"}
                >
                  v{version.version} · {STATUS_LABEL[version.status] ?? version.status}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="card p-4 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Reglas del modelo de contenido</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Un curso puede existir sin ninguna versión: se crea vacío y no aparece en el catálogo.</li>
          <li>Una versión publicada es inmutable; se archiva al publicar la siguiente.</li>
          <li>No se pueden saltar versiones: debe publicarse siempre la inmediatamente siguiente.</li>
          <li>Al publicar, el progreso del curso se reinicia para quien lo tenía empezado.</li>
          <li>Los cuestionarios viven dentro de cada versión; las claves se guardan aparte.</li>
        </ul>
      </div>
    </div>
  );
}
