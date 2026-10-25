import { redirect } from "next/navigation";
import Link from "next/link";
import { getUiSession } from "@/demo/session";
import { accountProfile } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";

/**
 * Mi cuenta: cambio de la propia contraseña.
 *
 * No muestra datos personales ni códigos: solo el nombre de usuario y el
 * formulario. En la demostración se explica que aquí no hay contraseñas reales.
 */
export default async function CuentaPage() {
  const session = await getUiSession();

  if (session.mode === "unconfigured") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card p-6">
          <h1 className="page-title">Mi cuenta</h1>
          <p className="lead mt-2 text-sm">{session.message}</p>
        </div>
      </div>
    );
  }

  const actor = session.actor;
  if (!actor) redirect("/login");

  let account: Awaited<ReturnType<typeof accountProfile>> = null;
  try {
    account = await accountProfile(actor);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div className="card p-6">
        <p className="eyebrow">Cuenta</p>
        <h1 className="page-title mt-1">Mi contraseña</h1>
        <p className="lead mt-2 text-sm">
          Cambia la contraseña con la que entras. Se te pedirá la actual para confirmar que la cuenta
          es tuya.
        </p>

        <div className="mt-5">
          {session.mode === "demo" ? (
            <div className="alert alert-info text-sm">
              <strong>Estás en la demostración.</strong> Las cuentas ficticias no tienen contraseña,
              así que aquí no hay nada que cambiar. El cambio real funciona con Firebase configurado.
            </div>
          ) : (
            <PasswordForm username={account?.username ?? null} />
          )}
        </div>
      </div>

      <p className="muted text-sm">
        ¿Has olvidado la contraseña y no puedes entrar? No hay recuperación por correo: pide a
        administración que restablezca la tuya.{" "}
        <Link href="/panel" className="font-semibold underline">
          Volver a mi formación
        </Link>
      </p>
    </div>
  );
}
