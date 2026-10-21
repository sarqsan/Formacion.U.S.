import { DomainError } from "@/domain/text";

/**
 * ALMACENAMIENTO DE PDF EN FRAGMENTOS (dominio)
 * ============================================
 *
 * Decisión de fase 4: **no se usa Firebase Storage**. El plan gratuito Spark no
 * incluye Storage (requiere Blaze), así que los PDF se guardan en Firestore
 * troceados en documentos pequeños, escritos y leídos SOLO por el servidor.
 *
 * Por qué fragmentar:
 *   - Firestore limita cada documento a 1 MiB. Un PDF no cabe en uno solo.
 *   - Al trocear, se puede leer por ventanas en lugar del fichero completo.
 *
 * Límites, con su porqué:
 *   - `CHUNK_BYTES` = 768 KiB. Deja ~256 KiB de margen sobre el 1 MiB de
 *     Firestore para nombres de campo, el id y el propio envoltorio.
 *   - `MAX_PDF_BYTES` = **8 MiB** (fase 6). Antes eran 20 MiB y era un error:
 *     Firestore limita cada **petición/transacción a 10 MiB**, así que 27
 *     fragmentos de 768 KiB (20,25 MiB) no caben en una transacción. Con 8 MiB
 *     son 11 fragmentos = 8,25 MiB, con margen sobre el límite de 10 MiB.
 *   - `FREE_TIER_STORAGE_BYTES` = 1 GiB: cuota total de Firestore en Spark.
 *   - `STORAGE_RESERVE_BYTES`: lo que se deja libre para el resto de documentos
 *     (cuentas, progreso, intentos, cursos) y sus índices.
 *   - `HARD_MAX_BUDGET_BYTES` = 1 GiB − reserva: nunca se permite configurar un
 *     presupuesto que llene la cuota entera.
 *   - `DEFAULT_BUDGET_BYTES` = 512 MiB: el valor con el que se arranca.
 *
 * Si el corpus real no cabe, la respuesta NO es subir el presupuesto: es
 * reducir el corpus, comprimir los PDF o cambiar de estrategia (ver
 * `docs/INFORME-FASE-4.md`, alternativas).
 */

/** Límite duro por documento en Firestore (1 MiB). */
export const FIRESTORE_MAX_DOCUMENT_BYTES = 1024 * 1024;

/** Tamaño de cada fragmento. Margen amplio bajo el límite de 1 MiB. */
export const CHUNK_BYTES = 768 * 1024;

/** Tope duro por PDF subido (8 MiB). */
export const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** Fragmentos máximos de un PDF (11 con los valores actuales). */
export const MAX_CHUNKS = Math.ceil(MAX_PDF_BYTES / CHUNK_BYTES);

/**
 * Límite documentado de Firestore por petición/transacción. Es el que **de
 * verdad** manda al subir: una transacción con 12 fragmentos de 768 KiB
 * (9 MiB) ya está al borde.
 */
export const MAX_TRANSACTION_BYTES = 10 * 1024 * 1024;

/** Margen de seguridad que se exige por debajo del límite de transacción. */
export const TRANSACTION_SAFETY_BYTES = 512 * 1024;

/** Ventana máxima que se puede pedir de una vez al leer. */
export const MAX_RANGE_BYTES = CHUNK_BYTES;

/** Cuota de almacenamiento de Firestore en el plan Spark. */
export const FREE_TIER_STORAGE_BYTES = 1024 * 1024 * 1024;

/** Reserva intocable para el resto de la base de datos. */
export const STORAGE_RESERVE_BYTES = 128 * 1024 * 1024;

/** Presupuesto máximo configurable para PDF. */
export const HARD_MAX_BUDGET_BYTES = FREE_TIER_STORAGE_BYTES - STORAGE_RESERVE_BYTES;

/** Presupuesto por defecto para PDF (512 MiB). */
export const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

/** Páginas máximas de un documento (coincide con `reading.ts`). */
export const MAX_PAGES = 5000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function chunkCount(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new DomainError("PDF_EMPTY", "El documento no tiene contenido.", 400);
  }
  if (bytes > MAX_PDF_BYTES) {
    throw new DomainError(
      "PDF_TOO_LARGE",
      `El documento supera el máximo permitido (${formatBytes(MAX_PDF_BYTES)}). Divídelo en varios documentos.`,
      413,
    );
  }
  return Math.ceil(bytes / CHUNK_BYTES);
}

/**
 * Comprueba que escribir el fichero completo en UNA transacción cabe en el
 * límite de 10 MiB de Firestore, con margen para metadatos y el contador.
 *
 * Se llama en la validación de entrada (antes de leer el cuerpo) y otra vez en
 * el servicio (antes de tocar la base de datos): dos barreras, no una.
 */
export function assertFitsTransaction(bytes: number): void {
  const chunks = chunkCount(bytes);
  const total = chunks * CHUNK_BYTES + TRANSACTION_SAFETY_BYTES;
  if (total > MAX_TRANSACTION_BYTES) {
    throw new DomainError(
      "PDF_TRANSACTION_TOO_LARGE",
      `El documento necesita ${chunks} fragmentos y no cabe en una transacción de ${formatBytes(MAX_TRANSACTION_BYTES)}. Reduce el tamaño del PDF.`,
      413,
    );
  }
}

/** Longitud del fragmento `index` (el último puede ser más corto). */
export function chunkLength(bytes: number, index: number): number {
  assertChunkIndex(bytes, index);
  const from = index * CHUNK_BYTES;
  return Math.min(CHUNK_BYTES, bytes - from);
}

/** Rango `[from, to)` del fragmento `index` dentro del fichero. */
export function chunkRange(bytes: number, index: number): { from: number; to: number } {
  const length = chunkLength(bytes, index);
  const from = index * CHUNK_BYTES;
  return { from, to: from + length };
}

function assertChunkIndex(bytes: number, index: number): void {
  const total = chunkCount(bytes);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new DomainError(
      "PDF_CHUNK_INDEX_INVALID",
      `Fragmento fuera de rango (${index}); el documento tiene ${total}.`,
      400,
    );
  }
}

/** Índices de fragmento que cubren el rango `[from, to)`. */
export function chunksForRange(bytes: number, from: number, to: number): number[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > bytes) {
    throw new DomainError("PDF_RANGE_INVALID", "Rango de bytes no válido.", 400);
  }
  if (to - from > MAX_RANGE_BYTES) {
    throw new DomainError(
      "PDF_RANGE_TOO_LARGE",
      `La ventana de lectura supera ${formatBytes(MAX_RANGE_BYTES)}. Pide menos bytes de una vez.`,
      413,
    );
  }
  // `to - 1` evita pedir un fragmento vacío cuando el rango acaba justo en un borde.
  const first = Math.floor(from / CHUNK_BYTES);
  const last = Math.floor((to - 1) / CHUNK_BYTES);
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

// ---------------------------------------------------------------------------
// Páginas: rebanadas deterministas de bytes
// ---------------------------------------------------------------------------

/**
 * El servidor **no** interpreta el PDF (no hay parser ni índice de páginas):
 * define "página" como una rebanada determinista del fichero. Las rebanadas
 * `1..pageCount` particionan el documento exactamente: concatenadas en orden
 * reconstruyen el original byte a byte.
 *
 * Esto permite aplicar la secuencia obligatoria de estudio en el servidor (no
 * se puede pedir la página 5 sin la 4) sin mentir sobre lo que se sirve. Lo que
 * no permite es renderizar una página aislada: el visor debe pedirlas en orden
 * y montar el PDF completo antes de dibujarlo.
 *
 * Requisito: `pageCount <= bytes`. Si hay menos bytes que páginas, alguna
 * rebanada saldría vacía y la secuencia sería trivial de saltar; se rechaza al
 * subir (`assertPageCountFitsBytes`).
 */
export function pageRange(
  bytes: number,
  pageCount: number,
  page: number,
): { from: number; to: number } {
  assertPageCount(pageCount);
  if (pageCount > bytes) {
    throw new DomainError(
      "PDF_PAGES_EXCEED_BYTES",
      "El documento declara más páginas que bytes: no se puede trocear por páginas.",
      500,
    );
  }
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new DomainError("PAGE_OUT_OF_RANGE", "La página no existe en el documento.", 404);
  }
  const from = Math.floor(((page - 1) * bytes) / pageCount);
  const to = Math.floor((page * bytes) / pageCount);
  return { from, to };
}

/** Máximo de páginas que se pueden servir en una sola petición. */
export function assertPageCountFitsBytes(pageCount: number, bytes: number): void {
  assertPageCount(pageCount);
  if (pageCount > bytes) {
    throw new DomainError(
      "PDF_PAGES_EXCEED_BYTES",
      "El número de páginas no puede superar el número de bytes del documento.",
      400,
    );
  }
}

/**
 * Un PDF empieza por `%PDF-`. La especificación permite basura antes de la
 * cabecera, así que se busca en los primeros 1 KiB en lugar de exigir que sea
 * el primer byte. Comprobar la firma evita guardar ejecutables o HTML con
 * extensión `.pdf`.
 */
export function assertPdfBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new DomainError("PDF_EMPTY", "El documento no tiene contenido.", 400);
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw new DomainError(
      "PDF_TOO_LARGE",
      `El documento supera el máximo permitido (${formatBytes(MAX_PDF_BYTES)}).`,
      413,
    );
  }
  // Tercera barrera: aunque quepa en el límite por documento, tiene que caber
  // en una transacción. Hoy 8 MiB siempre cabe; la comprobación evita que un
  // futuro cambio de CHUNK_BYTES lo rompa en silencio.
  assertFitsTransaction(bytes.length);
  const window = bytes.subarray(0, 1024);
  const header = "%PDF-";
  for (let index = 0; index + header.length <= window.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < header.length; offset += 1) {
      if (window[index + offset] !== header.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) return;
  }
  throw new DomainError(
    "PDF_SIGNATURE_INVALID",
    "El archivo no es un PDF válido (falta la cabecera %PDF-).",
    400,
  );
}

export function assertPageCount(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    throw new DomainError(
      "DOCUMENT_PAGE_COUNT_INVALID",
      `El número de páginas debe estar entre 1 y ${MAX_PAGES}.`,
      400,
    );
  }
}

/** Convierte el presupuesto configurado (MiB) en bytes, acotado. */
export function budgetBytesFromMiB(value: number | undefined, fallback = DEFAULT_BUDGET_BYTES): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  const bytes = Math.floor(value * 1024 * 1024);
  return Math.min(Math.max(bytes, 1), HARD_MAX_BUDGET_BYTES);
}

/** ¿Cabe un documento de `bytes` más en el presupuesto? */
export function assertFitsBudget(input: {
  usedBytes: number;
  newBytes: number;
  budgetBytes: number;
}): void {
  const total = input.usedBytes + input.newBytes;
  if (total > input.budgetBytes) {
    throw new DomainError(
      "STORAGE_BUDGET_EXCEEDED",
      `No cabe: quedarían ${formatBytes(total)} en uso y el presupuesto para PDF es ${formatBytes(input.budgetBytes)}. Borra documentos antiguos o reduce el tamaño.`,
      507,
    );
  }
}
