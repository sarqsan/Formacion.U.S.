import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { ImportClient } from "./import-client";
import { ImportDemo } from "./import-demo";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const session = await getUiSession();

  if (session.mode !== "demo") {
    if (!session.actor) redirect("/login");
    if (session.actor.role !== "admin") redirect("/panel");
  } else {
    if (!session.actor) redirect("/login");
    if (session.actor.role !== "admin") redirect("/panel");
  }

  const demo = session.mode === "demo";

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        / <span>Importar personas</span>
      </nav>

      <div>
        <p className="eyebrow">Alumnado</p>
        <h1 className="page-title mt-1">Importar personas desde Excel</h1>
        <p className="muted mt-1 text-sm">
          El fichero debe tener exactamente dos columnas: <strong>Rol</strong> y{" "}
          <strong>Apellido</strong>. Roles admitidos: ROL 1 y ROL 2.
        </p>
      </div>

      {demo ? (
        <div className="card p-5">
          <p className="alert alert-warn mb-4">
            Modo demostración: la vista previa es real (se lee el Excel y se validan Rol y Apellido),
            pero <strong>no se crean cuentas</strong>. El fichero de ejemplo es inventado.
          </p>
          <ImportDemo />
        </div>
      ) : session.mode === "firebase" ? (
        <div className="card p-5">
          <ImportClient />
        </div>
      ) : (
        <div className="card p-5">
          <p className="alert alert-info">
            Sin Firebase configurado, la importación no puede crear cuentas. Arranca con{" "}
            <code className="mono">DEMO_MODE=1</code> para ver la vista previa con un fichero
            sintético.
          </p>
        </div>
      )}

      <div className="card p-4 text-xs muted">
        <p className="font-semibold text-[var(--foreground)]">Qué hace la importación</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>Una cuenta por fila válida, siempre como alumno y pendiente de activación.</li>
          <li>Nunca se copian contraseñas desde el Excel: se eligen al activar la cuenta.</li>
          <li>Dos personas con el mismo apellido y rol requieren una decisión explícita.</li>
          <li>Los códigos de activación se muestran una sola vez.</li>
          <li>El rol de administrador nunca se concede por importación.</li>
        </ul>
      </div>
    </div>
  );
}
