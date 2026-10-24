"use client";

import { useActionState } from "react";
import {
  resetPasswordAction,
  type ResetPasswordState,
} from "@/app/actions/demo";

const INITIAL: ResetPasswordState = { status: "idle" };

/**
 * RESTABLECER LA CONTRASEÑA DE OTRA PERSONA
 * =========================================
 *
 * La contraseña la genera el servidor y se devuelve **una sola vez**, en el
 * resultado de la acción: no viaja en la URL, no queda en el historial del
 * navegador y no se guarda en claro. Quien administra la copia y la entrega en
 * mano; la persona la cambia en «Mi cuenta».
 *
 * El texto agrupado (`abcd-efgh-…`) sirve para dictarla sin errores; los guiones
 * no forman parte de la contraseña y el campo de copiar lleva la real.
 */
export function ResetPassword({ uid, username }: { uid: string; username: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, INITIAL);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="uid" value={uid} />
        <button type="submit" className="btn btn-secondary" disabled={pending}>
          {pending ? "Generando…" : "Restablecer contraseña"}
        </button>
        <span className="muted text-xs">
          Genera una contraseña temporal nueva y cierra las sesiones abiertas de esa cuenta.
        </span>
      </form>

      {state.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" && state.password ? (
        <div className="card space-y-2 p-4">
          <p className="alert alert-ok">{state.message}</p>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="muted">Usuario</dt>
              <dd className="mono">{state.username ?? username}</dd>
            </div>
            <div>
              <dt className="muted">Cambiada</dt>
              <dd className="mono">
                {state.changedAt ? new Date(state.changedAt).toLocaleString("es-ES") : "—"}
              </dd>
            </div>
          </dl>

          <label className="label" htmlFor="temporary-password">
            Contraseña temporal (cópiala ahora: no se vuelve a mostrar)
          </label>
          <input
            id="temporary-password"
            readOnly
            value={state.password}
            className="input mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="muted text-xs">
            Para dictarla: <span className="mono">{state.passwordGrouped}</span> (los guiones no
            forman parte de la contraseña)
          </p>
          <p className="muted text-xs leading-relaxed">
            Entrégala por un canal que puedas controlar. En el primer acceso, la persona debe
            cambiarla en «Mi cuenta». No aparece en la auditoría ni se guarda en claro.
          </p>
        </div>
      ) : null}
    </div>
  );
}
