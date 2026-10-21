"use client";

import { useMemo, useRef, useState } from "react";

type PreviewRow =
  | { status: "ok"; rowNumber: number; rol: string; apellido: string; username: string }
  | { status: "error"; rowNumber: number; rolRaw: string; apellidoRaw: string; issues: { code: string; message: string }[] }
  | {
      status: "duplicate";
      rowNumber: number;
      rol: string;
      apellido: string;
      duplicateOfRow: number | null;
      reason: "same_file" | "already_exists";
      resolution: "skip" | "include" | null;
      includable: boolean;
    };

interface Preview {
  rows: PreviewRow[];
  summary: {
    totalRows: number;
    valid: number;
    invalid: number;
    duplicates: number;
    duplicatesPending: number;
    duplicatesSkipped: number;
    duplicatesIncluded: number;
    confirmable: boolean;
    usernames: string[];
  };
}

interface CreatedAccount {
  username: string;
  activationToken: string;
  activationExpiresAt: string;
}

export function ImportClient() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, "skip" | "include">>({});
  const [created, setCreated] = useState<CreatedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const selectedFile = () => fileInput.current?.files?.[0] ?? null;

  const credentialsText = useMemo(
    () =>
      (created ?? [])
        .map((account) => `${account.username};${account.activationToken}`)
        .join("\n"),
    [created],
  );

  async function send(endpoint: "preview" | "confirm", nextResolutions: Record<number, string>) {
    const file = selectedFile();
    if (!file) {
      setError("Selecciona un archivo .xlsx.");
      return null;
    }

    const form = new FormData();
    form.append("file", file);
    form.append("resolutions", JSON.stringify(nextResolutions));

    const response = await fetch(`/api/admin/import/${endpoint}`, { method: "POST", body: form });
    const data = (await response.json().catch(() => null)) as
      | { preview?: Preview; created?: CreatedAccount[]; error?: { message?: string } }
      | null;

    if (!response.ok) {
      setError(data?.error?.message ?? "No se ha podido procesar el archivo.");
      return null;
    }

    return data;
  }

  async function analyze(nextResolutions: Record<number, "skip" | "include"> = resolutions) {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const data = await send("preview", nextResolutions);
      if (data?.preview) setPreview(data.preview);
    } catch {
      setError("Error de conexión al analizar el archivo.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(rowNumber: number, decision: "skip" | "include") {
    const next = { ...resolutions, [rowNumber]: decision };
    setResolutions(next);
    await analyze(next);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const data = await send("confirm", resolutions);
      if (data?.created) {
        setCreated(data.created);
        setPreview(null);
        setResolutions({});
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch {
      setError("Error de conexión al confirmar la importación.");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4">
        <div className="rounded-md bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]">
          Copia estos códigos ahora y entrégalos por un canal interno. No se vuelven a mostrar: en
          la base de datos solo queda una huella cifrada.
        </div>

        <textarea
          readOnly
          className="input font-mono text-xs"
          rows={Math.min(14, Math.max(4, created.length + 2))}
          value={credentialsText}
          aria-label="Usuarios y códigos de activación"
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              await navigator.clipboard.writeText(credentialsText).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? "Copiado" : "Copiar usuario;código"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setCreated(null)}>
            Terminar
          </button>
        </div>

        <p className="muted text-xs">
          {created.length} cuentas creadas como alumnas y pendientes de activación. Ninguna tiene
          permisos de administrador.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label" htmlFor="people-file">
          Excel de personas (.xlsx, exactamente dos columnas: Rol y Apellido)
        </label>
        <input
          id="people-file"
          ref={fileInput}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="input"
          onChange={() => {
            setPreview(null);
            setResolutions({});
            setError(null);
          }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => analyze()} disabled={busy}>
          {busy ? "Trabajando…" : "Analizar y previsualizar"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={confirm}
          disabled={busy || !preview?.summary.confirmable}
        >
          Confirmar importación
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="badge badge-ok">{preview.summary.valid} listas</span>
            <span className="badge badge-error">{preview.summary.invalid} con errores</span>
            <span className="badge badge-warn">
              {preview.summary.duplicatesPending} duplicadas sin decidir
            </span>
            <span className="muted">
              {preview.summary.totalRows} filas · {preview.summary.duplicatesSkipped} omitidas
            </span>
          </div>

          {!preview.summary.confirmable ? (
            <p className="rounded-md bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]">
              No se puede confirmar todavía: corrige las filas con errores en el Excel o decide qué
              hacer con cada duplicado.
            </p>
          ) : null}

          <div className="card max-h-[28rem] overflow-auto p-2">
            <table className="data">
              <thead>
                <tr>
                  <th>Fila</th>
                  <th>Rol</th>
                  <th>Apellido</th>
                  <th>Usuario</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{"rol" in row ? row.rol : row.rolRaw}</td>
                    <td>{"apellido" in row ? row.apellido : row.apellidoRaw}</td>
                    <td className="font-mono">{"username" in row ? row.username : "—"}</td>
                    <td>
                      {row.status === "ok" ? <span className="badge badge-ok">Lista</span> : null}
                      {row.status === "error" ? (
                        <div className="space-y-1">
                          <span className="badge badge-error">Error</span>
                          <ul className="muted list-disc pl-4 text-xs">
                            {row.issues.map((issue) => (
                              <li key={issue.code}>{issue.message}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {row.status === "duplicate" ? (
                        <div className="space-y-1">
                          <span className="badge badge-warn">
                            {row.reason === "already_exists" ? "Ya existe" : "Duplicada"}
                          </span>
                          <p className="muted text-xs">
                            {row.reason === "already_exists"
                              ? "Esta cuenta ya está creada. Solo puede omitirse."
                              : `Coincide con la fila ${row.duplicateOfRow}. ¿Es la misma persona?`}
                          </p>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              className="btn btn-secondary px-2 py-1 text-xs"
                              onClick={() => decide(row.rowNumber, "skip")}
                              disabled={busy}
                            >
                              Omitir
                            </button>
                            {row.includable ? (
                              <button
                                type="button"
                                className="btn btn-secondary px-2 py-1 text-xs"
                                onClick={() => decide(row.rowNumber, "include")}
                                disabled={busy}
                              >
                                Es otra persona
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
