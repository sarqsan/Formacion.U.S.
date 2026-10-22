import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/domain/text";
import { getUiSession } from "@/demo/session";
import {
  accounts as listAccounts,
  adminActivationSummary,
  adminProgress,
} from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";
import { disableAccountAction, enableAccountAction } from "@/app/actions/demo";
import { ReissueActivation } from "./account-actions";

export const dynamic = "force-dynamic";

/**
 * FICHA DE UNA CUENTA (bloque 09)
 * ===============================
 *
 * Qué se puede hacer desde aquí y bajo qué condiciones:
 *
 *   · deshabilitar — cuentas activas o pendientes; nunca el último
 *     administrador activo (lo impide el servicio, no la interfaz);
 *   · reactivar — solo cuentas deshabilitadas;
 *   · reemitir el código — solo cuentas pendientes de activación.
 *
 * La página no decide nada: enseña el estado real y ofrece las operaciones que
 * el servidor aceptaría. Si alguien fuerza una operación que no toca, el
 * servicio la rechaza con su mensaje.
 */

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

const MESSAGES: Record<string, string> = {
  deshabilitada:
    "Cuenta deshabilitada. Su sesión se ha cerrado y los códigos pendientes quedan anulados.",
  reactivada: "Cuenta reactivada. La persona tendrá que iniciar sesión de nuevo.",
};

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ uid: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { uid } = await params;
  const { ok, error } = await searchParams;

  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  // Primero la cuenta: si no existe, 404 antes de pedir nada más (y sin
  // convertir el «no existe» en un 500 al consultar sus códigos).
  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  try {
    accounts = await listAccounts(session.actor);
  } catch (caught) {
    if (isUnavailable(caught)) {
      return <DataUnavailable detail={caught instanceof Error ? caught.message : undefined} />;
    }
    throw caught;
  }

  const account = accounts.find((item) => item.uid === uid);
  if (!account) notFound();

  let progress: Awaited<ReturnType<typeof adminProgress>>;
  let activations: Awaited<ReturnType<typeof adminActivationSummary>>;
  try {
    progress = await adminProgress(session.actor);
    activations = await adminActivationSummary(session.actor, uid);
  } catch (caught) {
    if (isUnavailable(caught)) {
      return <DataUnavailable detail={caught instanceof Error ? caught.message : undefined} />;
    }
    if (caught instanceof DomainError && caught.code === "ACCOUNT_NOT_FOUND") notFound();
    throw caught;
  }

  const enrollments = progress.filter((row) => row.uid === uid);
  const activeAdmins = accounts.filter(
    (item) => item.role === "admin" && item.status === "active",
  ).length;

  const isSelf = session.actor.uid === uid;
  const lastAdmin = account.role === "admin" && account.status === "active" && activeAdmins <= 1;
  const canDisable = account.status !== "disabled" && !lastAdmin;
  const canEnable = account.status === "disabled";
  const canReissue = account.status === "pending_activation";

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        /{" "}
        <Link href="/admin/personas" className="underline">
          Personas
        </Link>{" "}
        / <span className="mono">{account.username || account.uid}</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Cuenta</p>
          <h1 className="page-title mt-1">{account.displayName}</h1>
          <p className="muted mono mt-1 text-xs">{account.uid}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={STATUS_CLASS[account.status] ?? "pill pill-warn"}>
            {STATUS_LABEL[account.status] ?? account.status}
          </span>
          {account.role === "admin" ? (
            <span className="pill pill-info">Administración</span>
          ) : (
            <span className="pill pill-off">Alumnado</span>
          )}
        </div>
      </div>

      {ok && MESSAGES[ok] ? <p className="alert alert-ok">{MESSAGES[ok]}</p> : null}
      {error ? <p className="alert alert-error">{error}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="stat">
          <p className="stat-value">{account.username || "—"}</p>
          <p className="stat-label">Usuario</p>
        </div>
        <div className="stat">
          <p className="stat-value">{account.personRol}</p>
          <p className="stat-label">Rol de persona</p>
        </div>
        <div className="stat">
          <p className="stat-value">{enrollments.length}</p>
          <p className="stat-label">Matrículas</p>
        </div>
        <div className="stat">
          <p className="stat-value">{enrollments.reduce((sum, row) => sum + row.attempts.length, 0)}</p>
          <p className="stat-label">Intentos</p>
        </div>
      </div>

      <section className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold">Acceso</h2>
        <p className="muted text-xs leading-relaxed">
          Deshabilitar cierra la sesión en la siguiente petición: se incrementa la versión de las
          claims y se revocan los refresh tokens. Una cuenta no se borra, así que su historial de
          progreso e intentos se conserva.
        </p>

        {lastAdmin ? (
          <p className="alert alert-warn text-xs">
            Es el único administrador activo. Deshabilitarlo dejaría el sistema sin administración,
            así que la operación no está disponible (el servidor también la rechazaría).
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          {canDisable ? (
            <form action={disableAccountAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="uid" value={account.uid} />
              <div>
                <label className="label" htmlFor="reason">
                  Motivo (opcional, queda en la auditoría)
                </label>
                <input
                  id="reason"
                  name="reason"
                  className="input"
                  maxLength={200}
                  placeholder="Baja del servicio, cambio de destino…"
                />
              </div>
              <button type="submit" className="btn btn-primary">
                Deshabilitar cuenta
              </button>
            </form>
          ) : null}

          {canEnable ? (
            <form action={enableAccountAction}>
              <input type="hidden" name="uid" value={account.uid} />
              <button type="submit" className="btn btn-primary">
                Reactivar cuenta
              </button>
            </form>
          ) : null}
        </div>

        {isSelf ? (
          <p className="muted text-xs">
            Esta es tu propia cuenta. Puedes deshabilitarla si hay otro administrador activo: la
            sesión se cerrará al instante.
          </p>
        ) : null}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold">Código de activación</h2>
        <p className="muted text-xs leading-relaxed">
          {activations.pending > 0
            ? `Hay ${activations.pending} código(s) sin usar. Caducan el ${
                activations.expiresAt ? new Date(activations.expiresAt).toLocaleString("es-ES") : "—"
              }.`
            : "No hay ningún código utilizable ahora mismo."}{" "}
          Se han usado {activations.used} y se han anulado {activations.revoked}.
        </p>

        {canReissue ? (
          <ReissueActivation uid={account.uid} />
        ) : (
          <p className="alert alert-info text-xs">
            {account.status === "active"
              ? "La cuenta ya está activa: entra con su contraseña, no necesita código."
              : "La cuenta está deshabilitada. Reactívala antes de emitir un código."}
          </p>
        )}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-sm font-semibold">Matrículas y progreso</h2>
        {enrollments.length === 0 ? (
          <p className="muted text-sm">Esta cuenta no tiene ninguna matrícula.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {enrollments.map((row) => (
              <li key={`${row.uid}-${row.courseId}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.courseTitle}</span>
                <span className="muted text-xs">{row.courseId}</span>
                {row.completed ? (
                  <span className="pill pill-ok">Completado</span>
                ) : (
                  <span className="pill pill-warn">En curso</span>
                )}
                <span className="muted text-xs">
                  {row.attempts.length} intento(s) · {row.pending.length} tema(s) pendiente(s)
                </span>
                <Link href="/admin/progreso" className="text-xs underline">
                  Ver detalle
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted text-xs leading-relaxed">
        Ficha de solo lectura salvo las tres operaciones indicadas: no se puede cambiar el rol, ni
        el nombre de usuario, ni la contraseña desde aquí.
      </p>
    </div>
  );
}
