"use client";

import Link from "next/link";
import { useActionState } from "react";
import { importPreviewAction, type ImportPreviewState } from "@/app/actions/demo";

const INITIAL: ImportPreviewState = { status: "idle" };

export function ImportDemo() {
  const [state, formAction, pending] = useActionState(importPreviewAction, INITIAL);
  const preview = state.preview;

  return (
    <div className="space-y-4">
      <form action={formAction} className="space-y-3">
        <div>
          <label className="label" htmlFor="file">
            Excel de personas (.xlsx)
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="input"
            required
          />
          <p className="hint">
            Dos columnas: <strong>Rol</strong> (ROL 1 o ROL 2) y <strong>Apellido</strong>.{" "}
            <a href="/demo/personas-sinteticas.xlsx" className="underline font-medium">
              Descargar fichero de ejemplo sintético
            </a>
            .
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Leyendo…" : "Ver vista previa"}
          </button>
          <span className="muted text-xs">
            No se crea ninguna cuenta: solo se analiza el fichero.
          </span>
        </div>
      </form>

      {state.status === "error" ? (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-4">
          <div className="grid-stats">
            <div className="stat">
              <p className="stat-value">{preview.summary.totalRows}</p>
              <p className="stat-label">Filas leídas</p>
            </div>
            <div className="stat">
              <p className="stat-value">{preview.summary.valid}</p>
              <p className="stat-label">Listas</p>
            </div>
            <div className="stat">
              <p className="stat-value">{preview.summary.invalid}</p>
              <p className="stat-label">Con errores</p>
            </div>
            <div className="stat">
              <p className="stat-value">{preview.summary.duplicates}</p>
              <p className="stat-label">Duplicados</p>
            </div>
          </div>

          <div className="table-wrap card">
            <table className="data">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>Estado</th>
                  <th>Rol</th>
                  <th>Apellido</th>
                  <th>Usuario que se crearía</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>
                      {row.status === "ok" ? (
                        <span className="pill pill-ok">Correcta</span>
                      ) : row.status === "duplicate" ? (
                        <span className="pill pill-warn">Duplicada</span>
                      ) : (
                        <span className="pill pill-error">Error</span>
                      )}
                    </td>
                    <td>
                      {"rol" in row ? row.rol : row.rolRaw || "—"}
                    </td>
                    <td>
                      {"apellido" in row ? row.apellido : row.apellidoRaw || "—"}
                    </td>
                    <td>
                      {row.status === "error" ? (
                        <ul className="text-xs text-[var(--danger)]">
                          {row.issues.map((issue) => (
                            <li key={issue.code}>{issue.message}</li>
                          ))}
                        </ul>
                      ) : "username" in row ? (
                        <span className="mono">{row.username}</span>
                      ) : (
                        <span className="muted text-xs">pendiente de decisión</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="alert alert-warn">
            <p className="font-semibold">Creación de cuentas: no conectada</p>
            <p className="mt-1">
              En producción, confirmar esta importación crea una cuenta de Firebase Authentication
              por fila (siempre como alumno y pendiente de activación), guarda el perfil en Firestore
              y devuelve un código de activación de un solo uso. Eso requiere Firebase conectado y
              no se simula aquí.
            </p>
          </div>

          <p className="muted text-xs">
            ¿Quieres ver el recorrido del alumno?{" "}
            <Link href="/login" className="underline">
              Entra con la cuenta de demostración
            </Link>{" "}
            y comprueba que las cuentas ficticias ya existen con su rol y apellido.
          </p>
        </div>
      ) : null}
    </div>
  );
}
