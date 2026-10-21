import Link from "next/link";
import { isFirebaseConfigured, isDemoMode } from "@/demo/session";
import { demoState } from "@/demo/store";
import { LoginForm } from "./login-form";
import { enterDemoSession } from "@/app/actions/demo";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>;
}) {
  const { demo } = await searchParams;
  const demoMode = isDemoMode();
  const firebaseReady = isFirebaseConfigured();
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

          <div className="mt-5">
            {firebaseReady ? (
              <LoginForm />
            ) : (
              <div className="alert alert-warn">
                <strong>Firebase no está configurado en esta instalación.</strong> El formulario real
                necesita un proyecto de Firebase (o el emulador) con Authentication habilitado. Para
                recorrer la interfaz, usa el acceso de demostración.
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
