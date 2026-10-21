import Link from "next/link";
import { getUiSession } from "@/demo/session";
import { demoState } from "@/demo/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getUiSession();
  const isDemo = session.mode === "demo";
  const actor = session.actor;
  const demoLearner = demoState().accounts.find((account) => account.uid === "demo-alumno-1");

  return (
    <div className="space-y-8">
      <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr] lg:items-center">
        <div className="space-y-4">
          <p className="eyebrow">Formación interna · acceso privado</p>
          <h1 className="page-title">
            Formación del personal, con temario ordenado, cuestionarios y progreso verificable
          </h1>
          <p className="lead max-w-xl">
            Plataforma independiente para publicar cursos, matricular alumnos y dejar constancia de
            quién ha estudiado y aprobado cada tema. Las cuentas no se registran: las crea
            administración desde un Excel y se activan con un código de un solo uso.
          </p>

          <div className="flex flex-wrap gap-3">
            {actor ? (
              <Link href={actor.role === "admin" ? "/admin" : "/panel"} className="btn btn-primary">
                {actor.role === "admin" ? "Ir a administración" : "Continuar mi formación"}
              </Link>
            ) : (
              <>
                <Link href="/login" className="btn btn-primary">
                  Iniciar sesión
                </Link>
                <Link href="/activar" className="btn btn-secondary">
                  Activar cuenta
                </Link>
              </>
            )}
            <Link href="/estado" className="btn btn-secondary">
              Qué está conectado
            </Link>
          </div>

          {isDemo ? (
            <div className="alert alert-warn">
              <strong>Estás viendo la demostración.</strong> Los datos son inventados y viven en
              memoria.{" "}
              {actor ? (
                <Link href="/panel" className="underline">
                  Seguir recorriendo
                </Link>
              ) : (
                <Link href="/login" className="underline">
                  Entrar como alumno o como administración
                </Link>
              )}
              .
            </div>
          ) : session.mode === "unconfigured" ? (
            <div className="alert alert-info">
              Esta instalación no tiene Firebase configurado. Para recorrer la interfaz con datos
              de prueba, arranca con <code className="mono">DEMO_MODE=1 npm run dev</code>.
            </div>
          ) : null}
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold">Recorrido de un alumno</h2>
          <ol className="mt-3 space-y-3 text-sm">
            {[
              ["Activa la cuenta", "Con el código de un solo uso que entrega administración."],
              ["Entra a sus cursos", "Solo ve los cursos en los que está matriculado."],
              ["Estudia en orden", "El servidor registra cada pantalla y no permite saltarse ninguna."],
              ["Responde el cuestionario", "Se corrige en el servidor; se repite hasta acertar todas."],
              ["Examen final", "Se desbloquea al superar todos los temas obligatorios."],
            ].map(([title, text], index) => (
              <li key={title} className="flex gap-3">
                <span className="step-index shrink-0">{index + 1}</span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="muted text-xs leading-relaxed">{text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          {
            title: "Contenido por versiones",
            text: "Lo publicado es inmutable: cualquier cambio crea una versión nueva, y el curso se repite desde cero sin perder el histórico.",
          },
          {
            title: "Evaluación en servidor",
            text: "Las respuestas correctas nunca llegan al navegador. Aprobar exige acertar todas las preguntas del intento.",
          },
          {
            title: "Progreso visible",
            text: "El alumno ve qué le queda pendiente; administración ve el estado de cada matrícula y cada intento.",
          },
        ].map((item) => (
          <div key={item.title} className="card p-5">
            <h2 className="text-sm font-semibold">{item.title}</h2>
            <p className="muted mt-1 text-sm leading-relaxed">{item.text}</p>
          </div>
        ))}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">¿Quieres verlo funcionando?</h2>
            <p className="muted mt-1 text-sm">
              {isDemo
                ? "La demostración usa un curso inventado de dos temas y tres cuentas ficticias."
                : "La versión demostrable arranca con datos sintéticos y sin conectar nada a Firebase."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/login" className="btn btn-primary">
              Entrar en la demostración
            </Link>
            {demoLearner ? (
              <span className="pill pill-off">usuario de ejemplo: {demoLearner.username}</span>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
