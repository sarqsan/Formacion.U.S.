"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_PDF_BYTES, formatBytes } from "@/domain/storage/pdf-chunks";
import { UPLOAD_PART_BYTES } from "@/domain/storage/pdf-upload";

/**
 * SUBIDA DE PDF POR PARTES (interfaz de administración)
 * ====================================================
 *
 * Sin librerías: el navegador parte el fichero con `File.slice`, calcula su
 * SHA-256 con WebCrypto y envía cada parte al servidor. El servidor valida el
 * orden, el tamaño, la firma `%PDF-` y la huella antes de **activar** el
 * documento; mientras tanto el documento está pendiente y no lo ve nadie.
 *
 * Reglas de la interfaz, a propósito:
 *   - el número de páginas lo declara el administrador y hay que **confirmarlo**
 *     expresamente: el sistema no lo verifica (no interpreta el PDF);
 *   - no se anuncia «guardado» hasta que el servidor confirma la finalización;
 *     durante la subida solo se dice «en curso / pendiente»;
 *   - un error se muestra tal cual llega del servidor, sin adornos;
 *   - reanudar exige volver a elegir el fichero: el navegador no puede conservar
 *     un fichero entre recargas, y el servidor acepta las partes que ya tenía.
 */

export interface UploadTopicOption {
  id: string;
  title: string;
  order: number;
}

export interface PendingUploadView {
  documentId: string;
  topicId: string;
  title: string;
  bytes: number;
  pageCount: number;
  partsTotal: number;
  partsReceived: number;
  percent: number;
  uploadedAt: string;
}

interface Props {
  courseId: string;
  version: number;
  /** Revisión del borrador que el editor tiene abierta. */
  expectedRevision: number;
  topics: UploadTopicOption[];
  pending: PendingUploadView[];
  /** Documentos ya asociados a cada tema (referencias del borrador). */
  documentsByTopic: Record<string, Array<{ id: string; title: string; pageCount: number }>>;
}

type Phase = "idle" | "hashing" | "creating" | "uploading" | "finalizing" | "attaching";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  hashing: "Calculando la huella del fichero…",
  creating: "Reservando cuota y abriendo la subida…",
  uploading: "Enviando partes… el documento aún no está guardado",
  finalizing: "Verificando tamaño y SHA-256…",
  attaching: "Asociando el documento al tema del borrador…",
};

async function errorFromResponse(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `Error ${response.status}`;
  } catch {
    return `Error ${response.status}`;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Este navegador no puede calcular el SHA-256 (hace falta HTTPS). Sin huella no se puede verificar el fichero.",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function PdfUploader({
  courseId,
  version,
  expectedRevision,
  topics,
  pending,
  documentsByTopic,
}: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [sha256, setSha256] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [pageCount, setPageCount] = useState("");
  const [topicId, setTopicId] = useState(topics[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [resumeFile, setResumeFile] = useState<Record<string, File | null>>({});

  const busy = phase !== "idle";
  const pendingByTopic = (id: string) => pending.filter((item) => item.topicId === id);

  async function onFileChange(selected: File | null) {
    setError(null);
    setNotice(null);
    setSha256(null);
    setProgress(null);
    setFile(selected);
    if (!selected) return;

    if (selected.size > MAX_PDF_BYTES) {
      setError(`El fichero ocupa ${formatBytes(selected.size)} y el máximo por documento es ${formatBytes(MAX_PDF_BYTES)}.`);
      setFile(null);
      return;
    }
    if (!title) {
      setTitle(selected.name.replace(/\.pdf$/i, "").slice(0, 200));
    }

    setPhase("hashing");
    try {
      setSha256(await sha256Hex(await selected.arrayBuffer()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo calcular la huella.");
      setFile(null);
    } finally {
      setPhase("idle");
    }
  }

  async function sendParts(documentId: string, partsFrom: number, partsTotal: number, source: File) {
    setProgress({ done: partsFrom, total: partsTotal });
    for (let index = partsFrom; index < partsTotal; index += 1) {
      const from = index * UPLOAD_PART_BYTES;
      const to = Math.min(from + UPLOAD_PART_BYTES, source.size);
      const response = await fetch(
        `/api/admin/documents/uploads/${encodeURIComponent(documentId)}/parts/${index}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: source.slice(from, to),
        },
      );
      if (!response.ok) throw new Error(await errorFromResponse(response));
      setProgress({ done: index + 1, total: partsTotal });
    }
  }

  async function finish(documentId: string, revision: number) {
    setPhase("finalizing");
    const finalize = await fetch(
      `/api/admin/documents/uploads/${encodeURIComponent(documentId)}/finalize`,
      { method: "POST" },
    );
    if (!finalize.ok) {
      setActiveDocumentId(documentId);
      throw new Error(await errorFromResponse(finalize));
    }
    setActiveDocumentId(documentId);

    setPhase("attaching");
    await attach(documentId, revision);
  }

  async function attach(documentId: string, revision: number) {
    const response = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}/attach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision }),
    });
    if (!response.ok) {
      // El documento ya está activo, pero sin asociar: se puede reintentar sin
      // volver a subirlo (y sin decir que está todo listo).
      throw new Error(
        `El documento se ha verificado y está activo, pero no se ha podido asociar: ${await errorFromResponse(response)}`,
      );
    }

    const body = (await response.json()) as { revision: number; attached: boolean };
    setNotice(
      body.attached
        ? "Documento verificado (SHA-256), activado y asociado al tema. No se ha publicado nada: el alumnado sigue viendo la versión publicada."
        : "Ese documento ya estaba asociado a este tema: no se ha duplicado nada.",
    );
    setActiveDocumentId(null);
    setFile(null);
    setSha256(null);
    setTitle("");
    setPageCount("");
    setConfirmed(false);
    setProgress(null);
    router.refresh();
  }

  async function startUpload() {
    if (!file || !sha256 || busy) return;
    setError(null);
    setNotice(null);

    try {
      setPhase("creating");
      const create = await fetch("/api/admin/documents/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          version,
          topicId,
          title,
          pageCount: Number(pageCount),
          bytes: file.size,
          sha256,
        }),
      });
      if (!create.ok) throw new Error(await errorFromResponse(create));

      const body = (await create.json()) as {
        created: boolean;
        partBytes: number;
        upload: { documentId: string; state: string; partsTotal: number; partsReceived: number };
      };

      if (body.upload.state === "active") {
        setNotice("Ese mismo fichero ya estaba verificado en este tema: se reutiliza el activo existente.");
        setActiveDocumentId(body.upload.documentId);
        setPhase("attaching");
        await attach(body.upload.documentId, expectedRevision);
        return;
      }

      setPhase("uploading");
      await sendParts(
        body.upload.documentId,
        body.upload.partsReceived,
        body.upload.partsTotal,
        file,
      );

      await finish(body.upload.documentId, expectedRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo completar la subida.");
    } finally {
      setPhase("idle");
    }
  }

  async function resume(item: PendingUploadView) {
    const source = resumeFile[item.documentId];
    setError(null);
    setNotice(null);
    if (!source) {
      setError("Elige otra vez el mismo fichero para reanudar la subida.");
      return;
    }
    if (source.size !== item.bytes) {
      setError(
        `Ese fichero ocupa ${formatBytes(source.size)} y la subida pendiente espera ${formatBytes(item.bytes)}. Elige el mismo PDF.`,
      );
      return;
    }

    try {
      setPhase("uploading");
      await sendParts(item.documentId, item.partsReceived, item.partsTotal, source);
      await finish(item.documentId, expectedRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo reanudar la subida.");
    } finally {
      setPhase("idle");
    }
  }

  async function cancel(item: PendingUploadView) {
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/admin/documents/uploads/${encodeURIComponent(item.documentId)}/abort`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await errorFromResponse(response));
      const body = (await response.json()) as { releasedBytes: number; chunksDeleted: number };
      setNotice(
        `Subida cancelada. Se han liberado ${formatBytes(body.releasedBytes)} de cuota y ${body.chunksDeleted} fragmento(s).`,
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo cancelar la subida.");
    }
  }

  async function retryAttach() {
    if (!activeDocumentId) return;
    setError(null);
    setNotice(null);
    setPhase("attaching");
    try {
      await attach(activeDocumentId, expectedRevision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo asociar el documento.");
    } finally {
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="alert alert-ok">{notice}</p> : null}
      {phase !== "idle" ? (
        <p className="alert alert-warn" aria-live="polite">
          {PHASE_LABEL[phase]}
          {progress ? ` · parte ${progress.done}/${progress.total}` : ""}
        </p>
      ) : null}
      {activeDocumentId && !busy ? (
        <button type="button" className="btn btn-secondary" onClick={retryAttach}>
          Reintentar la asociación al borrador
        </button>
      ) : null}

      {topics.length === 0 ? (
        <p className="muted text-xs">
          Crea primero un tema en el borrador: un PDF se asocia siempre a un tema.
        </p>
      ) : null}

      <fieldset className="rounded-lg border border-dashed border-[var(--line)] p-3" disabled={busy}>
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide muted">
          Añadir un PDF
        </legend>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="pdf-file">
              Fichero PDF (máximo {formatBytes(MAX_PDF_BYTES)})
            </label>
            <input
              id="pdf-file"
              type="file"
              accept="application/pdf"
              className="input"
              onChange={(event) => void onFileChange(event.target.files?.[0] ?? null)}
            />
            {file ? (
              <p className="muted mt-1 text-xs">
                {file.name} · {formatBytes(file.size)}
                {sha256 ? ` · SHA-256 ${sha256.slice(0, 12)}…` : ""}
              </p>
            ) : null}
          </div>

          <div>
            <label className="label" htmlFor="pdf-topic">
              Tema al que pertenece
            </label>
            <select
              id="pdf-topic"
              className="input"
              value={topicId}
              onChange={(event) => setTopicId(event.target.value)}
            >
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.order}. {topic.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="pdf-title">
              Título del documento
            </label>
            <input
              id="pdf-title"
              className="input"
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="pdf-pages">
              Número de páginas (lo declaras tú)
            </label>
            <input
              id="pdf-pages"
              className="input"
              type="number"
              min={1}
              max={5000}
              value={pageCount}
              onChange={(event) => setPageCount(event.target.value)}
            />
          </div>
        </div>

        <div className="alert alert-warn mt-2 text-xs">
          El sistema <strong>no verifica</strong> el número de páginas: no interpreta el PDF. Ese
          número es el que se usará para el control de lectura, así que debe ser el real.
        </div>

        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            Confirmo que el documento tiene{" "}
            <strong>{pageCount === "" ? "…" : pageCount}</strong> página(s) y que ese número es
            correcto, aunque el sistema no pueda comprobarlo.
          </span>
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              busy ||
              !file ||
              !sha256 ||
              !title.trim() ||
              !pageCount ||
              Number(pageCount) < 1 ||
              !topicId ||
              !confirmed
            }
            onClick={() => void startUpload()}
          >
            Iniciar subida por partes
          </button>
          <span className="muted text-xs">
            Se envía en partes de {formatBytes(UPLOAD_PART_BYTES)}. El documento no cuenta como
            guardado hasta que el servidor verifica el SHA-256 y lo activa.
          </span>
        </div>
      </fieldset>

      {pending.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide muted">
            Subidas pendientes ({pending.length})
          </h3>
          {pending.map((item) => (
            <div key={item.documentId} className="rounded-lg border border-[var(--line)] p-3">
              <p className="text-sm">
                {item.title} · {formatBytes(item.bytes)} · {item.partsReceived}/{item.partsTotal}{" "}
                partes ({item.percent}%)
              </p>
              <p className="muted mono text-xs">
                {item.documentId} · tema {item.topicId} · {item.pageCount} página(s)
              </p>
              <p className="muted mt-1 text-xs">
                Pendiente: no está asociado a ningún tema ni visible para el alumnado. La cuota está
                reservada hasta que se complete o se cancele.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div>
                  <label className="label" htmlFor={`resume-${item.documentId}`}>
                    Reanudar: elige el mismo fichero
                  </label>
                  <input
                    id={`resume-${item.documentId}`}
                    type="file"
                    accept="application/pdf"
                    className="input"
                    onChange={(event) =>
                      setResumeFile({
                        ...resumeFile,
                        [item.documentId]: event.target.files?.[0] ?? null,
                      })
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !resumeFile[item.documentId]}
                  onClick={() => void resume(item)}
                >
                  Reanudar subida
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void cancel(item)}
                >
                  Cancelar y liberar cuota
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide muted">
          Documentos asociados a esta versión
        </h3>
        {topics.map((topic) => (
          <div key={topic.id} className="rounded-lg border border-[var(--line)] p-2">
            <p className="text-xs font-semibold">
              {topic.order}. {topic.title}
            </p>
            {pendingByTopic(topic.id).length > 0 ? (
              <p className="muted text-xs">
                {pendingByTopic(topic.id).length} subida(s) pendiente(s) de este tema.
              </p>
            ) : null}
            <ul className="muted mt-1 space-y-1 text-xs">
              {(documentsByTopic[topic.id] ?? []).length === 0 ? (
                <li>Todavía no hay documentos.</li>
              ) : (
                documentsByTopic[topic.id].map((document) => (
                  <li key={document.id}>
                    <span className="mono">{document.id}</span> · {document.title} ·{" "}
                    {document.pageCount} página(s)
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
