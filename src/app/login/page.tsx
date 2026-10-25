import Link from "next/link";
import { isDemoMode } from "@/demo/session";
import { assessFirebaseReadiness, missingConfiguration } from "@/server/firebase/readiness";
import { demoState } from "@/demo/store";
import { LoginForm } from "./login-form";
import { enterDemoSession } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string; password?: string }>;
}) {
  const { demo, password } = await searchParams;
  const demoMode = isDemoMode();
  // El formulario real necesita **las dos** partes: credenciales del servidor
  // (Admin SDK) y configuración pública de la app web (SDK del navegador).
  // Antes solo se miraban las credenciales, así que con la app web sin
  // registrar el formulario aparecía y el error saltaba al pulsar «Entrar».
  const readiness = assessFirebaseReadiness(process.env);
  const firebaseReady = readiness.ready;
  const missing = missingConfiguration(readiness);
  const accounts = demoMode
    ? demoState().accounts.filter((account) => account.status === "active")
    : [];

  return (
    <div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <div className="card p-6">
          <p className="eyebrow">Acceso privado</p>
          <h1 className="page-title mt-1">Iniciar sesión</h1>
          <p className="lead mt-2 text-sm">
            Usa el usuario que te entregó administración y la contraseña que elegiste al activar la
            cuenta.
          </p>

          {password === "cambiada" ? (
            <p className="alert alert-info mt-4 text-sm">
              Contraseña cambiada. Por seguridad se han cerrado las sesiones abiertas: entra con la
              contraseña nueva.
            </p>
          ) : null}

          <div className="mt-5">
            {firebaseReady ? (
              <LoginForm />
            ) : demoMode ? (
              // En la demostración no falta nada: no se usa Firebase. Se dice
              // así para no llenar la pantalla de variables sin configurar.
              <div className="alert alert-info">
                <strong>Estás en la demostración.</strong> Aquí no hay contraseñas ni Firebase: elige
                una cuenta ficticia en el panel de la derecha. El acceso real se habilita al
                configurar el proyecto (detalle: <span className="mono">npm run check:setup</span>).
              </div>
            ) : (
              <div className="alert alert-warn">
                <strong>Acceso real no disponible todavía.</strong> Falta configuración de Firebase en
                esta instalación, así que el formulario no se muestra (no tendría con qué comprobar la
                contraseña).
                {missing.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                    {readiness.serverFindings
                      .filter((finding) => finding.level === "FAILED")
                      .map((finding) => (
                        <li key={finding.id}>
                          <span className="mono">{finding.id}</span>: {finding.detail}
                        </li>
                      ))}
                    {readiness.webFindings
                      .filter((finding) => finding.level === "FAILED")
                      .map((finding) => (
                        <li key={finding.id}>
                          <span className="mono">{finding.id}</span>: falta la configuración pública de
                          la app web.
                        </li>
                      ))}
                  </ul>
                ) : null}
                <p className="mt-2 text-xs">
                  El detalle, paso a paso: <span className="mono">npm run check:setup</span>. Para
                  recorrer la interfaz sin Firebase, usa el acceso de demostración.
                </p>
              </div>
            )}
          </div>

          <p className="muted mt-4 text-sm">
            ¿Tienes un código de activación?{" "}
            <Link href="/activar" className="font-semibold underline">
              Activa tu cuenta
            </Link>
          </p>
        </div>

        <div className="card p-4 text-xs muted">
          <p className="font-semibold text-[var(--foreground)]">Qué ocurre al entrar</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
            <li>La contraseña se comprueba en Firebase Authentication, no aquí.</li>
            <li>El servidor emite una cookie httpOnly y verifica la cuenta en cada petición.</li>
            <li>Si la cuenta se deshabilita, la sesión deja de valer de inmediato.</li>
          </ul>
        </div>
      </div>

      {demoMode ? (
        <div className="card p-6">
          <p className="eyebrow">Demostración</p>
          <h2 className="mt-1 text-lg font-semibold">Entrar con una cuenta ficticia</h2>
          <p className="muted mt-2 text-sm leading-relaxed">
            Sin contraseña y sin crear nada: elige un perfil para recorrer la aplicación. Los datos
            son inventados y se pierden al reiniciar el servidor.
          </p>

          {demo === "no-valido" ? (
            <p className="alert alert-error mt-3">
              Esa cuenta de demostración no está activa. Elige otra.
            </p>
          ) : null}

          <div className="mt-4 space-y-2">
            {accounts.map((account) => (
              <form key={account.uid} action={enterDemoSession}>
                <input type="hidden" name="uid" value={account.uid} />
                <button
                  type="submit"
                  className={`tile w-full text-left ${account.role === "admin" ? "" : ""}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{account.displayName}</span>
                    <span className={account.role === "admin" ? "pill pill-info" : "pill pill-ok"}>
                      {account.role === "admin" ? "Administración" : "Alumno"}
                    </span>
                  </span>
                  <span className="muted mono text-xs">{account.username}</span>
                </button>
              </form>
            ))}
          </div>

          <p className="mt-4 text-xs muted">
            La cuenta «pendiente de activación» no aparece aquí: es la que muestra el estado real de
            una persona importada que todavía no ha activado su acceso.
          </p>
        </div>
      ) : (
        <div className="card p-6 text-sm">
          <p className="eyebrow">Demostración</p>
          <h2 className="mt-1 text-lg font-semibold">No disponible</h2>
          <p className="muted mt-2 leading-relaxed">
            El acceso de demostración solo aparece si el servidor arranca con{" "}
            <code className="mono">DEMO_MODE=1</code>. Nunca se activa sola y nunca convive con
            sesiones reales.
          </p>
        </div>
      )}
    </div>
  );
}
