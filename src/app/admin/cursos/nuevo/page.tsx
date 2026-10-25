import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { createCourseAction } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

/**
 * ALTA DE CURSO
 * =============
 *
 * Crea la ficha del curso y **nada más**: no hay versión, no hay contenido y no
 * se publica. Es el primer paso del ciclo de vida; el borrador se guardará
 * desde el editor en el bloque siguiente.
 *
 * El identificador se valida otra vez en el servidor (aquí solo se ayuda a
 * escribirlo bien): un formulario manipulado no puede saltarse la regla.
 */
export default async function NewCoursePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

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
        / <span>Nuevo curso</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Contenido</p>
          <h1 className="page-title mt-1">Nuevo curso</h1>
          <p className="muted mt-1 text-sm">
            Se crea la ficha del curso, vacía. No se crea ninguna versión y no se publica nada:
            el temario se prepara después, en un borrador.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/cursos/ia" className="btn btn-primary">
            Crear curso con IA
          </Link>
          <Link href="/admin/cursos" className="btn btn-secondary">
            Volver a cursos
          </Link>
        </div>
      </div>

      <p className="alert alert-info text-sm">
        ¿El temario ya está en un PDF? <strong>Crear curso con IA</strong> crea el curso, sube el
        PDF y propone temas, pantallas y cuestionarios en un solo recorrido. Este formulario es
        para crear la ficha vacía y escribir el contenido a mano.
      </p>

      {error ? <p className="alert alert-error">{error}</p> : null}

      <form action={createCourseAction} className="card space-y-4 p-5">
        <div>
          <label className="label" htmlFor="courseId">
            Identificador del curso
          </label>
          <input
            id="courseId"
            name="courseId"
            className="input mono"
            required
            maxLength={64}
            pattern="[a-z0-9][a-z0-9-]{0,63}"
            placeholder="prevencion-riesgos-laborales"
            autoComplete="off"
          />
          <p className="muted mt-1 text-xs">
            Minúsculas, números y guiones. Es el identificador interno y no se puede cambiar
            después: forma parte de las matrículas, del progreso y de las versiones.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="title">
            Título
          </label>
          <input
            id="title"
            name="title"
            className="input"
            required
            maxLength={200}
            placeholder="Prevención de riesgos laborales"
          />
        </div>

        <div>
          <label className="label" htmlFor="description">
            Descripción (opcional)
          </label>
          <input
            id="description"
            name="description"
            className="input"
            maxLength={500}
            placeholder="Para qué sirve el curso, en una línea"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary">
            Crear curso
          </button>
          <span className="muted text-xs">
            El curso nace sin versión publicada y sin borrador.
          </span>
        </div>
      </form>

      <div className="card p-4 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Qué ocurre al crearlo</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Se reserva el identificador. Si ya existe, no se sobrescribe: se avisa y no se crea nada.</li>
          <li>El curso queda sin versión publicada y sin borrador, así que no aparece en el catálogo del alumnado.</li>
          <li>Ningún alumno puede matricularse en un curso sin versión publicada.</li>
          <li>El temario, los PDF y los cuestionarios se añaden en el siguiente paso y solo se ven al publicar.</li>
        </ul>
      </div>
    </div>
  );
}
