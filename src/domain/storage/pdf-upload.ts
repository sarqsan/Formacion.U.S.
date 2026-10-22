import { DomainError } from "@/domain/text";
import {
  CHUNK_BYTES,
  MAX_PDF_BYTES,
  MAX_PAGES,
  chunkCount,
  chunkLength,
  formatBytes,
} from "@/domain/storage/pdf-chunks";

/**
 * SUBIDA POR PARTES: ESTADOS, LÍMITES Y ORDEN (dominio)
 * ===================================================
 *
 * Un PDF de hasta 8 MiB no se pide en una sola petición: el cuerpo de una
 * función en el plan gratuito de Vercel ronda los 4,5 MB y una subida única
 * dejaría fuera la mitad de los documentos permitidos. Se sube **por partes**,
 * cada una del tamaño de un fragmento de almacenamiento (768 KiB).
 *
 * El ciclo de vida es explícito y solo tiene tres estados:
 *
 *      create ──► pending ──finalize──► active
 *                   │
 *                   └──abort──► aborted
 *
 * Reglas que se sostienen aquí (y se prueban en `tests/domain/pdf-upload.test.ts`):
 *
 *   - una parte mide **exactamente** lo que le toca; la última es la única que
 *     puede ser más corta;
 *   - las partes se aceptan **en orden**: la 0 primero (ahí se comprueba la
 *     firma `%PDF-`), luego 1, 2… Reenviar una parte ya guardada es válido si
 *     el contenido es idéntico (reintento idempotente) y un conflicto si no;
 *   - el documento solo se activa con **todas** las partes, el tamaño declarado
 *     y el SHA-256 global comprobado;
 *   - la cuota se **reserva** al crear y se convierte en uso al activar, de modo
 *     que una subida a medias no deja espacio libre que otro pueda ocupar.
 *
 * Nada de esto interpreta el PDF: solo se mira la cabecera. El número de
 * páginas lo declara el administrador y **no se verifica automáticamente**.
 */

export type PdfUploadState = "pending" | "active" | "aborted";

/** Tamaño máximo de una parte enviada al servidor. */
export const UPLOAD_PART_BYTES = CHUNK_BYTES;

/** Forma exacta de un SHA-256 en hexadecimal minúscula. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Los identificadores los genera el servidor; el cliente nunca los elige. */
const UPLOAD_ID = /^doc_[0-9a-f]{32}$/;

export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

export function assertUploadId(value: unknown): string {
  if (!isUploadId(value)) {
    throw new DomainError("UPLOAD_ID_INVALID", "El identificador de la subida no es válido.", 400);
  }
  return value;
}

/** Tamaño declarado por el administrador antes de enviar la primera parte. */
export function assertDeclaredBytes(bytes: unknown): number {
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) {
    throw new DomainError("PDF_EMPTY", "El documento no tiene contenido.", 400);
  }
  if (bytes > MAX_PDF_BYTES) {
    throw new DomainError(
      "PDF_TOO_LARGE",
      `El documento supera el máximo permitido (${formatBytes(MAX_PDF_BYTES)}). Divídelo en varios documentos.`,
      413,
    );
  }
  return bytes;
}

export function assertSha256Hex(value: unknown): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new DomainError(
      "PDF_SHA256_INVALID",
      "Falta la huella SHA-256 del documento o no tiene el formato esperado.",
      400,
    );
  }
  return value;
}

export function assertPageCountDeclared(pageCount: unknown, bytes: number): number {
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new DomainError("DOCUMENT_PAGE_COUNT_INVALID", "Indica cuántas páginas tiene el documento.", 400);
  }
  if (pageCount > MAX_PAGES) {
    throw new DomainError(
      "DOCUMENT_PAGE_COUNT_INVALID",
      `El número de páginas debe estar entre 1 y ${MAX_PAGES}.`,
      400,
    );
  }
  // El servidor trocea por "páginas" entendidas como rebanadas de bytes: con
  // más páginas que bytes una rebanada saldría vacía y la secuencia de lectura
  // sería trivial de saltar.
  if (pageCount > bytes) {
    throw new DomainError(
      "PDF_PAGES_EXCEED_BYTES",
      "El número de páginas no puede superar el número de bytes del documento.",
      400,
    );
  }
  return pageCount;
}

/** Partes que tiene un documento del tamaño declarado. */
export function uploadPartCount(bytes: number): number {
  return chunkCount(bytes);
}

/** Longitud exacta de la parte `index`. */
export function uploadPartLength(bytes: number, index: number): number {
  return chunkLength(bytes, index);
}

export function assertPartIndex(bytes: number, index: unknown): number {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw new DomainError("PDF_CHUNK_INDEX_INVALID", "La parte indicada no es válida.", 400);
  }
  const total = uploadPartCount(bytes);
  if (index < 0 || index >= total) {
    throw new DomainError(
      "PDF_CHUNK_INDEX_INVALID",
      `La parte ${index} está fuera de rango: el documento tiene ${total}.`,
      400,
    );
  }
  return index;
}

/**
 * Comprueba el tamaño de una parte. Se exige el tamaño **exacto** para que el
 * servidor no tenga que confiar en que el cliente troceó bien: si la última
 * parte llega corta, el documento no se podrá reconstruir.
 */
export function assertPartLength(bytes: number, index: number, length: number): void {
  const expected = uploadPartLength(bytes, index);
  if (length !== expected) {
    throw new DomainError(
      "PDF_CHUNK_SIZE_INVALID",
      `La parte ${index} debe ocupar ${expected} bytes y han llegado ${length}. Vuelve a intentarlo.`,
      400,
    );
  }
  if (length === 0 || length > UPLOAD_PART_BYTES) {
    throw new DomainError("PDF_CHUNK_SIZE_INVALID", "La parte está vacía o supera el máximo.", 413);
  }
}

/**
 * Orden de las partes.
 *
 * Devuelve `"write"` si toca escribirla, `"retry"` si ya estaba guardada (el
 * reintento es válido y el servicio comprobará que el contenido coincide) y
 * lanza `PDF_CHUNK_OUT_OF_ORDER` si se adelanta a las que faltan.
 */
export function partOrderAction(
  partsReceived: number,
  index: number,
  total: number,
): "write" | "retry" {
  if (index > partsReceived) {
    throw new DomainError(
      "PDF_CHUNK_OUT_OF_ORDER",
      `Falta la parte ${partsReceived}: las partes se envían en orden. Reanuda desde ahí.`,
      409,
    );
  }
  if (index < partsReceived) return "retry";
  if (index >= total) {
    throw new DomainError("PDF_CHUNK_INDEX_INVALID", "La parte ya no pertenece al documento.", 400);
  }
  return "write";
}

/** Avance de la subida, para mostrarlo tal cual en la interfaz. */
export function uploadProgress(
  bytes: number,
  partsReceived: number,
): { partsTotal: number; partsReceived: number; bytesReceived: number; percent: number } {
  const partsTotal = uploadPartCount(bytes);
  const received = Math.min(Math.max(partsReceived, 0), partsTotal);
  const bytesReceived =
    received >= partsTotal
      ? bytes
      : Array.from({ length: received }, (_, index) => uploadPartLength(bytes, index)).reduce(
          (sum, length) => sum + length,
          0,
        );

  return {
    partsTotal,
    partsReceived: received,
    bytesReceived,
    percent: bytes === 0 ? 0 : Math.min(100, Math.floor((bytesReceived / bytes) * 100)),
  };
}

/** Sin todas las partes no se puede finalizar. */
export function assertUploadComplete(bytes: number, partsReceived: number): void {
  const total = uploadPartCount(bytes);
  if (partsReceived !== total) {
    throw new DomainError(
      "PDF_UPLOAD_INCOMPLETE",
      `La subida está incompleta: faltan ${total - partsReceived} de ${total} partes. Reanúdala antes de finalizar.`,
      409,
      { partsTotal: total, partsReceived, missing: total - partsReceived },
    );
  }
}

/**
 * Cabecera PDF. La especificación permite bytes de relleno antes de `%PDF-`,
 * así que se busca en el primer KiB en lugar de exigir que sea el primer byte.
 * Se comprueba en la **primera parte**, que es donde está la cabecera.
 */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return false;
  const header = "%PDF-";
  const window = bytes.subarray(0, 1024);
  for (let index = 0; index + header.length <= window.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < header.length; offset += 1) {
      if (window[index + offset] !== header.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

export function assertPdfHeader(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new DomainError("PDF_EMPTY", "El documento no tiene contenido.", 400);
  }
  if (!hasPdfHeader(bytes)) {
    throw new DomainError(
      "PDF_SIGNATURE_INVALID",
      "El archivo no parece un PDF: falta la cabecera %PDF-. No se acepta por el nombre ni por la extensión.",
      400,
    );
  }
}

/**
 * Material con el que el servicio deriva el identificador del activo.
 *
 * El cliente no elige identificadores: el servidor los calcula con SHA-256 a
 * partir de estos datos (ver `documentIdFor` en el servicio). Así:
 *   - dos subidas del **mismo** fichero al mismo sitio son la misma operación
 *     (no se reserva cuota dos veces);
 *   - un fichero distinto —aunque se llame igual— es un activo nuevo, que es
 *     justo lo que exige la inmutabilidad.
 */
export function uploadIdentityMaterial(input: {
  courseId: string;
  version: number;
  topicId: string;
  sha256: string;
  bytes: number;
}): string {
  return [input.courseId, input.version, input.topicId, input.bytes, input.sha256].join("|");
}
