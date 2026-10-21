import { DomainError } from "@/domain/text";

/**
 * LECTURA SECUENCIAL DE PDF
 * =========================
 *
 * El servidor guarda cuántas páginas ha visto el usuario en cada documento y
 * rechaza cualquier petición que se salte páginas. Así la regla "visualización
 * secuencial, respetando el orden original" no depende solo de la interfaz.
 *
 * LÍMITE HONESTO: es un control de aplicación, no DRM. Un usuario podría
 * descargar el PDF completo si obtuviera una URL firmada (vida corta) y usar
 * otro visor. Lo que sí se garantiza es que el progreso registrado y el
 * desbloqueo del cuestionario solo avanzan página a página por el servidor.
 */

export interface DocumentReadProgress {
  documentId: string;
  totalPages: number;
  /** Última página vista en orden; 0 = ninguna. */
  lastPageViewed: number;
  completedAt: string | null;
}

export function initDocumentProgress(
  documentId: string,
  totalPages: number,
): DocumentReadProgress {
  assertTotalPages(totalPages);
  return { documentId, totalPages, lastPageViewed: 0, completedAt: null };
}

export function assertTotalPages(totalPages: number): void {
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 5000) {
    throw new DomainError(
      "DOCUMENT_PAGE_COUNT_INVALID",
      "El número de páginas del documento no es válido.",
      500,
    );
  }
}

/** Página siguiente permitida (1 si aún no ha empezado). */
export function nextAllowedPage(progress: DocumentReadProgress): number {
  return Math.min(progress.lastPageViewed + 1, progress.totalPages);
}

export function assertCanViewPage(
  progress: DocumentReadProgress,
  page: number,
): void {
  if (!Number.isInteger(page) || page < 1) {
    throw new DomainError("PAGE_INVALID", "Número de página no válido.");
  }
  if (page > progress.totalPages) {
    throw new DomainError("PAGE_OUT_OF_RANGE", "La página no existe en el documento.", 404);
  }
  if (page > progress.lastPageViewed + 1) {
    throw new DomainError(
      "PAGE_OUT_OF_ORDER",
      `Debes leer las páginas en orden. La siguiente página disponible es la ${nextAllowedPage(progress)}.`,
      409,
    );
  }
}

/** Visitar una página ya vista es idempotente (no incrementa el progreso). */
export function recordPageViewed(
  progress: DocumentReadProgress,
  page: number,
  atIso: string,
): DocumentReadProgress {
  assertCanViewPage(progress, page);
  if (Number.isNaN(Date.parse(atIso))) {
    throw new DomainError("TIMESTAMP_INVALID", "Marca de tiempo no válida.", 500);
  }
  const lastPageViewed = Math.max(progress.lastPageViewed, page);
  const completedAt =
    progress.completedAt ??
    (lastPageViewed >= progress.totalPages ? atIso : null);

  return { ...progress, lastPageViewed, completedAt };
}

export function isDocumentRead(progress: DocumentReadProgress): boolean {
  return progress.lastPageViewed >= progress.totalPages;
}

/**
 * El cuestionario del tema se abre cuando todos sus documentos obligatorios
 * están leídos completos. Si un tema no tiene documentos, no se exige lectura.
 */
export function isTopicFullyRead(
  mandatoryDocumentIds: readonly string[],
  documents: Readonly<Record<string, DocumentReadProgress>>,
): boolean {
  return mandatoryDocumentIds.every((documentId) => {
    const progress = documents[documentId];
    return progress ? isDocumentRead(progress) : false;
  });
}
