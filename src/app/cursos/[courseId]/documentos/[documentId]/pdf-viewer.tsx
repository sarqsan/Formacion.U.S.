"use client";

import { useEffect, useState } from "react";

/**
 * VISOR DEL PDF CON EL NAVEGADOR (bloque 07)
 * =========================================
 *
 * Sin librerías: se incrusta el PDF con `<object type="application/pdf">` y el
 * navegador usa **su** visor. En Android —donde Chrome no siempre incrusta el
 * PDF dentro de la página— el mismo componente ofrece siempre un enlace directo
 * para abrirlo en una pestaña independiente, que es la alternativa que sí
 * funciona en todos los móviles.
 *
 * Lo que este componente **no** hace: interpretar el PDF, paginarlo ni dibujar
 * nada. Si el navegador no puede mostrarlo, se dice y se ofrece el enlace; no se
 * simula que está cargado.
 *
 * El estado de carga es real: mientras el objeto no avisa de que ha cargado se
 * muestra «Cargando…», y si tarda demasiado se sugiere abrir en otra pestaña en
 * lugar de dejar un hueco en blanco sin explicación.
 */
export function PdfViewer({
  src,
  title,
  bytes,
}: {
  src: string;
  title: string;
  bytes?: number;
}) {
  const [state, setState] = useState<"loading" | "ready" | "slow">("loading");

  useEffect(() => {
    const timer = setTimeout(() => {
      setState((current) => (current === "loading" ? "slow" : current));
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-2">
      {state === "loading" ? (
        <p className="alert alert-info text-xs" aria-live="polite">
          Cargando el documento… El PDF se descarga completo y lo muestra el visor del navegador.
        </p>
      ) : null}
      {state === "slow" ? (
        <p className="alert alert-warn text-xs" aria-live="polite">
          El visor del navegador no ha confirmado la carga. Puedes abrir el documento en una pestaña
          independiente con el botón de abajo.
        </p>
      ) : null}

      <object
        data={src}
        type="application/pdf"
        title={title}
        aria-label={`Documento PDF: ${title}`}
        className="h-[70vh] w-full rounded-lg border border-[var(--line)] bg-white"
        onLoad={() => setState("ready")}
      >
        <div className="card p-4 text-sm">
          <p>
            Este navegador no puede mostrar el PDF dentro de la página. No es un error del curso: el
            documento está disponible y se abre aparte.
          </p>
          <a href={src} target="_blank" rel="noopener noreferrer" className="btn btn-primary mt-3">
            Abrir el PDF en una pestaña nueva
          </a>
        </div>
      </object>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-secondary btn-sm"
        >
          Abrir en una pestaña nueva
        </a>
        {bytes ? <span className="muted text-xs">{formatBytes(bytes)}</span> : null}
        <span className="muted text-xs">
          Si el visor no aparece (habitual en Android), usa el botón: se abre con la aplicación de
          PDF del dispositivo.
        </span>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
