import Link from "next/link";
import { isDemoMode } from "@/demo/session";
import { ActivateForm } from "./activate-form";

export default function ActivatePage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Activar cuenta</h1>
        <p className="muted mt-1 mb-5 text-sm">
          Introduce el código que te ha entregado administración y elige tu contraseña personal.
        </p>
        <ActivateForm />
      </div>

      {isDemoMode() ? (
        <div className="alert alert-warn text-sm">
          En la demostración no hay activación real: la cuenta ficticia ya está activa. Elige un
          perfil en <Link href="/login" className="underline">acceso</Link>. La activación con código
          de un solo uso necesita Firebase Authentication.
        </div>
      ) : null}

      <div className="card p-4 text-sm">
        <p className="muted">
          ¿Ya tienes contraseña?{" "}
          <Link className="font-semibold text-[var(--accent)] underline" href="/login">
            Iniciar sesión
          </Link>
        </p>
      </div>
    </div>
  );
}
