"use client";

import { useActionState } from "react";
import {
  reissueActivationAction,
  type ReissueActivationState,
} from "@/app/actions/demo";

const INITIAL: ReissueActivationState = { status: "idle" };

/**
 * REEMITIR CÓDIGO DE ACTIVACIÓN
 * =============================
 *
 * El código se devuelve en el resultado de la acción, no en la URL ni en una
 * cookie: no queda en el historial del navegador, ni en los registros del
 * servidor, ni en un enlace que se pueda reenviar sin querer. Se muestra una
 * sola vez y solo lo guarda quien lo pida (aquí, copiándolo).
 *
 * Es un componente de cliente porque necesita conservar el token entre el
 * envío y el repintado. Sin JavaScript, el formulario dice claramente que hace
 * falta para ver el código: no se finge que se ha emitido.
 */
export function ReissueActivation({ uid }: { uid: string }) {
  const [state, formAction, pending] = useActionState(reissueActivationAction, INITIAL);

  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="uid" value={uid} />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Emitiendo…" : "Reemitir código de activación"}
        </button>
        <span className="muted text-xs">
          Anula el código anterior. Se muestra una sola vez; no se guarda en claro.
        </span>
      </form>

      {state.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" && state.token ? (
        <div className="card space-y-2 p-4">
          <p className="alert alert-ok">{state.message}</p>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="muted">Usuario</dt>
              <dd className="mono">{state.username}</dd>
            </div>
            <div>
              <dt className="muted">Caduca</dt>
              <dd className="mono">
                {state.expiresAt ? new Date(state.expiresAt).toLocaleString("es-ES") : "—"}
              </dd>
            </div>
          </dl>
          <label className="label" htmlFor="activation-token">
            Código (cópialo ahora: no se vuelve a mostrar)
          </label>
          <input
            id="activation-token"
            readOnly
            value={state.token}
            className="input mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="muted text-xs leading-relaxed">
            Entrégalo por un canal que puedas controlar. No se envía por correo desde el sistema y
            no aparece en la auditoría.
          </p>
        </div>
      ) : null}
    </div>
  );
}
