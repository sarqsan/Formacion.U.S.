import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { adminCourses, aiConnectionStatus } from "@/server/portal";
import { checkAiConnectionAction, startAiCourseAction } from "@/app/actions/ai";
import { MAX_AI_UPLOAD_BYTES } from "@/server/ai/config";

export const dynamic = "force-dynamic";

/**
 * CREAR CURSO CON IA · PASO 1
 * ===========================
 *
 * Ficha del curso y PDF del temario. De aquí sale un borrador normal, con el
 * PDF guardado en el mismo almacén fragmentado de siempre: si la IA no
 * funcionase, el curso sigue ahí para escribirlo a mano.
 *
 * El estado de Gemini se muestra arriba y sin adornos: si falta la clave, se
 * dice y no se ofrece un botón que vaya a fallar.
 */
export default async function AiCoursePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; comprobado?: string; ok?: string }>;
}) {
  const { error, comprobado, ok } = await searchParams;

  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  const [status, courses] = await Promise.all([
    aiConnectionStatus(),
    adminCourses(session.actor),
  ]);

  const drafts = courses.filter((course) => course.lastDraftVersion !== null);

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
        / <span>Crear con IA</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Contenido</p>
          <h1 className="page-title mt-1">Crear curso con IA</h1>
          <p className="muted mt-1 text-sm">
            Sube el temario en PDF: la IA propone los temas, las pantallas de estudio y los
            cuestionarios. Todo queda en un borrador que tú revisas y publicas con el flujo de
            siempre.
          </p>
        </div>
        <Link href="/admin/cursos" className="btn btn-secondary">
          Volver a cursos
        </Link>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Estado de la conexión con el proveedor de IA                       */}
      {/* ---------------------------------------------------------------- */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Conexión con {status.providerLabel}</h2>
            <p className="muted mt-1 text-xs leading-relaxed">
              La clave vive solo en el servidor. Aquí nunca se muestra, ni completa ni en parte.
            </p>
          </div>
          <span
            className={`pill ${status.configured ? (status.reachable === false ? "pill-warn" : "pill-ok") : "pill-off"}`}
          >
            {status.configured
              ? status.reachable === false
                ? "Configurada, sin respuesta"
                : status.reachable === true
                  ? status.modelAvailable === false
                    ? "Conectada · modelo no disponible"
                    : "Conectada"
                  : "Configurada"
              : "Sin configurar"}
          </span>
        </div>

        <p className="mt-2 text-sm">{status.message}</p>
        <p className="muted mt-1 text-xs">
          Modelo: <span className="mono">{status.model}</span>
          {status.checkedAt ? ` · comprobado ${new Date(status.checkedAt).toLocaleString("es-ES")}` : ""}
        </p>
        {/*
          Diagnóstico a la vista: el 25/10 el asistente siguió usando Gemini en
          producción sin que se pudiera saber desde aquí si faltaba la clave de
          Groq o si era una decisión de `AI_PROVIDER`.
        */}
        <p className="muted mt-1 text-xs">
          Claves en el servidor: Groq {status.diagnostics.keys.groq ? "sí" : "no"} · Google{" "}
          {status.diagnostics.keys.gemini ? "sí" : "no"}
          {status.diagnostics.declared
            ? ` · proveedor forzado: ${status.diagnostics.declared} (AI_PROVIDER)`
            : " · proveedor forzado: no"}
        </p>

        {status.provider === "gemini" && !status.diagnostics.keys.groq ? (
          <p className="alert alert-warn mt-3 text-xs leading-relaxed">
            <strong>Falta GROQ_API_KEY en el servidor.</strong> Por eso el asistente sigue usando
            Google. Añade la variable en Vercel → Settings → Environment Variables marcando el
            entorno <strong>Production</strong> (y Preview, si quieres probarla antes) y vuelve a
            desplegar: en cuanto esté, la aplicación la usará sin cambiar nada más.
          </p>
        ) : null}

        {status.provider === "gemini" && status.diagnostics.keys.groq ? (
          <p className="alert alert-info mt-3 text-xs leading-relaxed">
            Hay claves de los dos proveedores y se está usando Google porque{" "}
            <code>AI_PROVIDER=gemini</code>. Para usar Groq, cambia esa variable o bórrala.
          </p>
        ) : null}

        {comprobado ? <p className="alert alert-ok mt-3 text-sm">{comprobado}</p> : null}

        <form action={checkAiConnectionAction} className="mt-3">
          <input type="hidden" name="returnTo" value="/admin/cursos/ia" />
          <button type="submit" className="btn btn-secondary btn-sm">
            Comprobar conexión ahora
          </button>
        </form>
      </section>

      {error ? <p className="alert alert-error">{error}</p> : null}
      {ok ? <p className="alert alert-ok">{ok}</p> : null}

      {!status.configured ? (
        <p className="alert alert-warn text-sm">
          Falta <span className="mono">GEMINI_API_KEY</span> en el servidor. El resto de la
          aplicación funciona con normalidad; este asistente quedará activo en cuanto se añada la
          clave en el entorno del despliegue (nunca en este repositorio ni en el navegador).
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Paso 1                                                           */}
      {/* ---------------------------------------------------------------- */}
      <form action={startAiCourseAction} className="card space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">Paso 1 · Curso y temario</h2>
          <p className="muted mt-1 text-xs leading-relaxed">
            El PDF se guarda con las comprobaciones de siempre (firma, tamaño, páginas y huella
            SHA-256). Nada de lo que subas aquí lo ve el alumnado hasta que publiques.
          </p>
          {/*
            Aviso de tratamiento: el temario sale de la aplicación para generar el
            curso. Se dice aquí, antes de subir el fichero, no en una política que
            nadie lee. Ver `docs/IA-Y-DATOS.md`.
          */}
          <p className="alert alert-warn mt-2 text-xs leading-relaxed">
            <strong>El temario se envía a {status.providerLabel}</strong> para separarlo en temas y
            redactar el curso; no se publica en ningún sitio.{" "}
            {status.provider === "groq"
              ? "El acuerdo de servicio de Groq prohíbe usar lo que se le envía para entrenar modelos."
              : "Con la cuota gratuita de Google, el contenido sí se usa para mejorar sus productos y puede leerlo un revisor; con facturación activa, no."}{" "}
            No subas aquí documentos con datos personales. Detalle:{" "}
            <code>docs/IA-Y-DATOS.md</code>.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
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
              Minúsculas, números y guiones. No se puede cambiar después.
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

        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div>
            <label className="label" htmlFor="pdf">
              PDF del temario
            </label>
            <input
              id="pdf"
              name="pdf"
              type="file"
              accept="application/pdf,.pdf"
              className="input"
              required
            />
            <p className="muted mt-1 text-xs">
              Hasta {Math.round(MAX_AI_UPLOAD_BYTES / (1024 * 1024))} MB por fichero, y tiene que
              tener texto seleccionable: un escaneo sin reconocimiento no se puede leer. Con el plan
              gratuito, el texto que cabe en una sola pasada ronda las <strong>30 páginas</strong>:
              si el temario es mayor, la aplicación lo dirá antes de empezar y bastará con dividirlo
              en dos o tres partes. Para PDF de más de{" "}
              {Math.round(MAX_AI_UPLOAD_BYTES / (1024 * 1024))} MB, súbelo por partes desde el
              editor del curso (hasta 8 MB).
            </p>
          </div>

          <div>
            <label className="label" htmlFor="pageCount">
              Páginas del PDF
            </label>
            <input
              id="pageCount"
              name="pageCount"
              type="number"
              inputMode="numeric"
              min={1}
              max={5000}
              className="input"
              required
              placeholder="24"
            />
            <p className="muted mt-1 text-xs">Lo indica el lector de PDF.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary">
            Crear borrador y continuar
          </button>
          <span className="muted text-xs">
            Crea el curso, abre su borrador y sube el PDF. No publica nada.
          </span>
        </div>
      </form>

      {/* ---------------------------------------------------------------- */}
      {/* Continuar un borrador existente                                  */}
      {/* ---------------------------------------------------------------- */}
      <section className="card p-5">
        <h2 className="text-sm font-semibold">Continuar un borrador</h2>
        {drafts.length === 0 ? (
          <p className="muted mt-2 text-sm">
            No hay ningún curso con borrador abierto. Crea uno arriba o prepáralo a mano desde{" "}
            <Link href="/admin/cursos/nuevo" className="underline">
              Nuevo curso
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-sm">
            {drafts.map((course) => (
              <li key={course.courseId} className="flex flex-wrap items-center gap-2">
                <span className="mono text-xs">{course.courseId}</span>
                <span>{course.title}</span>
                <span className="pill pill-info">borrador v{course.lastDraftVersion}</span>
                <Link
                  href={`/admin/cursos/${course.courseId}/ia?v=${course.lastDraftVersion}&paso=2`}
                  className="underline text-xs"
                >
                  Continuar con IA
                </Link>
                <Link
                  href={`/admin/cursos/${course.courseId}/editar?v=${course.lastDraftVersion}`}
                  className="underline text-xs muted"
                >
                  Editor completo
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-4 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Qué hace la IA y qué no</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Propone temas localizados en el PDF y cita las páginas en las que se apoya cada pantalla.</li>
          <li>Escribe las pantallas de estudio y los cuestionarios; no inventa lo que el documento no dice.</li>
          <li>No publica, no matricula y no aprueba a nadie: la corrección sigue siendo del servidor.</li>
          <li>Si algo falla, el borrador queda como estaba: se puede reintentar o continuar a mano.</li>
        </ul>
      </section>
    </div>
  );
}
