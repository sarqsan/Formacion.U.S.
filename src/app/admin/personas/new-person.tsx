"use client";

import { useActionState } from "react";
import {
  createPersonAction,
  type CreatePersonState,
} from "@/app/actions/demo";

const INITIAL: CreatePersonState = { status: "idle" };

/**
 * ALTA DE UNA PERSONA SUELTA
 * ==========================
 *
 * Mismo camino que la importación de Excel —misma validación del apellido,
 * mismo usuario calculado por el servidor, mismo código de un solo uso— pero con
 * un formulario, para no tener que fabricar un fichero de una fila.
 *
 * El rol de cuenta es siempre `learner` y la cuenta nace pendiente de
 * activación: este formulario no crea administradores ni cuentas activas.
 * El código se muestra una sola vez, como en la reemisión.
 */
export function NewPerson() {
  const [state, formAction, pending] = useActionState(createPersonAction, INITIAL);

  return (
    <div className="space-y-3">
      <form action={formAction} className="grid gap-3 sm:grid-cols-[1.4fr_1fr_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="apellido">
            Apellido
          </label>
          <input
            id="apellido"
            name="apellido"
            className="input"
            placeholder="García López"
            maxLength={80}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="rol">
            Rol de persona
          </label>
          <select id="rol" name="rol" className="select" required defaultValue="ROL 1">
            <option value="ROL 1">ROL 1</option>
            <option value="ROL 2">ROL 2</option>
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creando…" : "Crear cuenta"}
        </button>

        <p className="muted text-xs sm:col-span-3">
          El usuario lo calcula el sistema con el rol y el apellido (por ejemplo,{" "}
          <span className="mono">rol1.garcia</span>). Si ya existe una cuenta con ese apellido y
          rol, no se crea otra: es la misma persona.
        </p>
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
              <dt className="muted">El código caduca</dt>
              <dd className="mono">
                {state.expiresAt ? new Date(state.expiresAt).toLocaleString("es-ES") : "—"}
              </dd>
            </div>
          </dl>
          <label className="label" htmlFor="new-person-token">
            Código de activación (cópialo ahora: no se vuelve a mostrar)
          </label>
          <input
            id="new-person-token"
            readOnly
            value={state.token}
            className="input mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className="muted text-xs leading-relaxed">
            Entrégalo junto con el usuario por un canal que puedas controlar. No se envía por correo
            y no aparece en la auditoría.
          </p>
        </div>
      ) : null}
    </div>
  );
}
