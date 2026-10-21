import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";
import { assertActiveAccount, assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  CHUNK_BYTES,
  MAX_PDF_BYTES,
  assertFitsBudget,
  assertFitsTransaction,
  assertPageCount,
  assertPageCountFitsBytes,
  assertPdfBytes,
  chunkCount,
  formatBytes,
  pageRange,
} from "@/domain/storage/pdf-chunks";
import {
  assertCanViewPage,
  initDocumentProgress,
  nextAllowedPage,
  recordPageViewed,
} from "@/domain/progress/reading";
import { mandatoryTopicsOf, type CourseCatalogStore } from "@/server/courses/catalog";
import { assertCourseAccess } from "@/server/enrollments/service";
import type { EnrollmentStore } from "@/server/enrollments/store";
import type { LearningStore } from "@/server/learning/store";
import { loadOrInitProgress } from "@/server/learning/progress-loader";
import type { PdfDocumentStore } from "@/server/documents/store";
import type { SlidingWindowLimiter } from "@/server/ratelimit/limiter";

/**
 * DOCUMENTOS PDF SIN FIREBASE STORAGE (servicios)
 * ==============================================
 *
 *   subida   → el administrador envía el PDF al servidor; el servidor valida
 *              firma `%PDF-`, tamaño (≤ 8 MiB), cabida en una transacción,
 *              páginas y cuota, calcula el SHA-256 y lo escribe troceado en
 *              Firestore dentro de **una sola transacción**.
 *   lectura  → el alumno pide un **rango de páginas contiguas que empiece en la
 *              siguiente que le toca**. El servidor comprueba matrícula, versión
 *              publicada, secuencia (`assertCanViewPage`) y límite de peticiones,
 *              y solo entonces lee los fragmentos.
 *
 * Lo que esto NO es: no es DRM. Un alumno con matrícula puede reunir las
 * rebanadas del PDF que está viendo. Lo que sí se garantiza es que no hay
 * enlaces públicos, que el binario no sale de Firestore sin pasar por el
 * servidor, que la secuencia de lectura se controla en servidor y que las
 * respuestas de los cuestionarios viven en otra colección cerrada al cliente.
 */

export interface DocumentDependencies {
  documents: PdfDocumentStore;
  catalog: CourseCatalogStore;
  enrollments: EnrollmentStore;
  learning: LearningStore;
  /** Presupuesto para PDF en bytes (cuota gratuita menos reserva). */
  budgetBytes: number;
  /** Límite de peticiones de lectura; si no se pasa, no se limita (pruebas). */
  limiter?: SlidingWindowLimiter;
  now?: () => Date;
}

/** Páginas que se pueden pedir en una sola petición. */
export const MAX_PAGES_PER_REQUEST = 20;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Subida (solo administradores)
// ---------------------------------------------------------------------------

export interface UploadDocumentInput {
  actor: Actor;
  courseId: string;
  version: number;
  topicId: string;
  documentId: string;
  title: string;
  pageCount: number;
  bytes: Uint8Array;
}

export interface UploadDocumentResult {
  documentId: string;
  bytes: number;
  chunks: number;
  sha256: string;
  usedBytes: number;
  budgetBytes: number;
}

export async function uploadPdfDocument(
  input: UploadDocumentInput,
  deps: DocumentDependencies,
): Promise<UploadDocumentResult> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();

  // Barreras de entrada, en orden de coste: firma y tamaño antes de tocar la
  // base de datos; después cabida en transacción y coherencia de páginas.
  assertPdfBytes(input.bytes);
  if (input.bytes.length > MAX_PDF_BYTES) {
    throw new DomainError(
      "PDF_TOO_LARGE",
      `El documento supera el máximo permitido (${formatBytes(MAX_PDF_BYTES)}).`,
      413,
    );
  }
  assertFitsTransaction(input.bytes.length);
  assertPageCount(input.pageCount);
  assertPageCountFitsBytes(input.pageCount, input.bytes.length);

  if (!input.title.trim()) {
    throw new DomainError("DOCUMENT_TITLE_REQUIRED", "El documento necesita un título.", 400);
  }

  // El documento debe pertenecer a una versión existente del curso: evita
  // dejar binarios huérfanos que nadie puede leer ni nadie limpia.
  const version = await deps.catalog.getVersion(input.courseId, input.version);
  if (!version) {
    throw new DomainError(
      "VERSION_NOT_FOUND",
      "La versión indicada no existe. Crea primero el borrador del curso.",
      404,
    );
  }

  const topic = version.topics.find((item) => item.id === input.topicId);
  if (!topic) {
    throw new DomainError("TOPIC_NOT_IN_COURSE", "El tema no pertenece a esa versión.", 404);
  }

  const totalBytes = input.bytes.length;
  const totalChunks = chunkCount(totalBytes);

  const existing = await deps.documents.getMeta(input.documentId);
  if (existing) {
    throw new DomainError(
      "DOCUMENT_ALREADY_EXISTS",
      "Ya existe un documento con ese identificador. Los documentos son inmutables: usa otro id.",
      409,
    );
  }

  // Cada fragmento es un `Bytes` de Firestore (nunca base64: inflaría un 33 %).
  const chunks = Array.from({ length: totalChunks }, (_, index) => ({
    index,
    data: new Uint8Array(input.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)),
  }));

  const written = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  if (written !== totalBytes) {
    throw new DomainError("PDF_CHUNK_MISMATCH", "El troceado no reconstruye el fichero.", 500);
  }

  const meta = {
    documentId: input.documentId,
    courseId: input.courseId,
    version: input.version,
    topicId: input.topicId,
    title: input.title.trim(),
    pageCount: input.pageCount,
    bytes: totalBytes,
    sha256: sha256Hex(input.bytes),
    chunkLengths: chunks.map((chunk) => chunk.data.length),
    uploadedBy: admin.uid,
    uploadedAt: now.toISOString(),
  };

  // El presupuesto se comprueba DOS veces: aquí (fallo rápido, sin escribir) y
  // dentro de la transacción del almacén (autoridad final frente a subidas
  // simultáneas). La segunda es la que impide que dos peticiones a la vez
  // acepten ambas lo que solo cabe una vez.
  const usedBytes = await deps.documents.usageBytes();
  assertFitsBudget({ usedBytes, newBytes: totalBytes, budgetBytes: deps.budgetBytes });

  await deps.documents.saveDocument({
    meta,
    chunks,
    bytes: totalBytes,
    budgetBytes: deps.budgetBytes,
  });

  return {
    documentId: input.documentId,
    bytes: totalBytes,
    chunks: totalChunks,
    sha256: meta.sha256,
    usedBytes: usedBytes + totalBytes,
    budgetBytes: deps.budgetBytes,
  };
}

// ---------------------------------------------------------------------------
// Lectura por páginas (cuentas activas con matrícula)
// ---------------------------------------------------------------------------

export interface ReadPagesInput {
  actor: Actor;
  documentId: string;
  /** Primera página pedida: debe ser exactamente la siguiente permitida. */
  from: number;
  /** Última página pedida (inclusive). */
  to: number;
}

export interface ReadPagesResult {
  bytes: Uint8Array;
  from: number;
  to: number;
  totalPages: number;
  totalBytes: number;
  /** Siguiente página que el servidor permitirá leer. */
  nextPage: number;
  /** Páginas restantes del documento (0 = leído completo). */
  remainingPages: number;
  sha256: string;
  chunksRead: number;
  /** Cuánto se ha descontado del límite de peticiones. */
  cost: number;
}

/**
 * Sirve un rango de páginas contiguas **empezando en la siguiente permitida**.
 *
 * Autorización, en este orden y sin saltarse ninguna:
 *   1. cuenta activa (`assertActiveAccount`);
 *   2. el documento existe y no está archivado;
 *   3. matrícula activa en el curso (o rol admin);
 *   4. la versión del documento es la publicada (o rol admin);
 *   5. `from` es exactamente la página siguiente a la última vista;
 *   6. el rango no supera `MAX_PAGES_PER_REQUEST` ni el final del documento;
 *   7. límite de peticiones por usuario y global.
 *
 * Después, cada página se registra con `recordPageViewed`, que vuelve a
 * comprobar el orden: si algo se descuadra, se lanza 409 en lugar de servir.
 */
export async function readDocumentPages(
  input: ReadPagesInput,
  deps: DocumentDependencies,
): Promise<ReadPagesResult> {
  const actor = assertActiveAccount(input.actor);
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();

  const meta = await deps.documents.getMeta(input.documentId);
  if (!meta) {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }

  // ---- matrícula y publicación -------------------------------------------
  let version: Awaited<ReturnType<CourseCatalogStore["getVersion"]>> = null;
  if (actor.role === "admin") {
    version = await deps.catalog.getVersion(meta.courseId, meta.version);
  } else {
    await assertCourseAccess(actor, meta.courseId, deps);

    const course = await deps.catalog.getCourse(meta.courseId);
    if (!course || course.publishedVersion === null) {
      throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
    }
    if (course.publishedVersion !== meta.version) {
      throw new DomainError(
        "DOCUMENT_NOT_PUBLISHED",
        "Ese documento pertenece a una versión que ya no está publicada.",
        409,
      );
    }
    version = await deps.catalog.getVersion(meta.courseId, course.publishedVersion);
  }

  // ---- rango y secuencia --------------------------------------------------
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to)) {
    throw new DomainError("PAGE_INVALID", "Las páginas deben ser números enteros.", 400);
  }
  if (input.to < input.from) {
    throw new DomainError("PAGE_INVALID", "El rango de páginas está invertido.", 400);
  }
  if (input.to - input.from + 1 > MAX_PAGES_PER_REQUEST) {
    throw new DomainError(
      "PAGE_RANGE_TOO_LARGE",
      `Pide como máximo ${MAX_PAGES_PER_REQUEST} páginas por vez.`,
      413,
    );
  }
  if (input.from < 1 || input.to > meta.pageCount) {
    throw new DomainError("PAGE_OUT_OF_RANGE", "La página no existe en el documento.", 404);
  }

  const { progress, archive } = await loadOrInitProgress({
    learning: deps.learning,
    uid: actor.uid,
    courseId: meta.courseId,
    publishedVersion: meta.version,
    mandatoryTopicIds: version ? mandatoryTopicsOf(version) : [],
    at,
  });

  const current =
    progress.documents[meta.documentId] ??
    initDocumentProgress(meta.documentId, meta.pageCount);

  // La página pedida tiene que ser la siguiente: ni saltos ni repeticiones.
  assertCanViewPage(current, input.from);
  const expected = nextAllowedPage(current);
  if (input.from !== expected) {
    throw new DomainError(
      "PAGE_OUT_OF_ORDER",
      `Debes leer las páginas en orden. La siguiente página disponible es la ${expected}.`,
      409,
    );
  }

  // ---- límite de peticiones (coste = páginas) -----------------------------
  const cost = input.to - input.from + 1;
  deps.limiter?.consumeOrThrow(`pdf:${actor.uid}`, cost);

  // ---- lectura de los fragmentos -----------------------------------------
  const from = pageRange(meta.bytes, meta.pageCount, input.from).from;
  const to = pageRange(meta.bytes, meta.pageCount, input.to).to;
  const bytes = await readBytes(meta, from, to, deps);

  // ---- progreso (solo tras leer con éxito) --------------------------------
  let updated = current;
  for (let page = input.from; page <= input.to; page += 1) {
    updated = recordPageViewed(updated, page, at);
  }

  if (actor.role !== "admin") {
    await deps.learning.saveProgress(
      {
        ...progress,
        documents: { ...progress.documents, [meta.documentId]: updated },
        updatedAt: at,
      },
      archive,
    );
  }

  return {
    bytes,
    from: input.from,
    to: input.to,
    totalPages: meta.pageCount,
    totalBytes: meta.bytes,
    nextPage: nextAllowedPage(updated),
    remainingPages: Math.max(0, meta.pageCount - updated.lastPageViewed),
    sha256: meta.sha256,
    chunksRead: chunksForRangeCount(meta.bytes, from, to),
    cost,
  };
}

/** Fragmentos que cubre el rango (para informar del coste sin releer). */
function chunksForRangeCount(bytes: number, from: number, to: number): number {
  return Math.floor((to - 1) / CHUNK_BYTES) - Math.floor(from / CHUNK_BYTES) + 1;
}

async function readBytes(
  meta: { documentId: string; bytes: number; chunkLengths: number[] },
  from: number,
  to: number,
  deps: DocumentDependencies,
): Promise<Uint8Array> {
  const firstIndex = Math.floor(from / CHUNK_BYTES);
  const lastIndex = Math.floor((to - 1) / CHUNK_BYTES);
  const buffers: Uint8Array[] = [];

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const chunk = await deps.documents.readChunk(meta.documentId, index);
    if (!chunk || chunk.length !== meta.chunkLengths[index]) {
      throw new DomainError(
        "DOCUMENT_CORRUPTED",
        "Falta un fragmento del documento o su tamaño no coincide. Avisa a administración.",
        500,
      );
    }
    buffers.push(chunk);
  }

  const joined = concat(buffers);
  const offset = from - firstIndex * CHUNK_BYTES;
  const slice = joined.subarray(offset, offset + (to - from));

  if (slice.length !== to - from) {
    throw new DomainError("DOCUMENT_CORRUPTED", "El rango solicitado no se pudo reconstruir.", 500);
  }

  return new Uint8Array(slice);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Gestión de cuota
// ---------------------------------------------------------------------------

export interface StorageUsage {
  usedBytes: number;
  budgetBytes: number;
  freeBytes: number;
  /** 0..100 */
  percent: number;
}

export async function storageUsage(deps: DocumentDependencies): Promise<StorageUsage> {
  const usedBytes = await deps.documents.usageBytes();
  const freeBytes = Math.max(0, deps.budgetBytes - usedBytes);
  return {
    usedBytes,
    budgetBytes: deps.budgetBytes,
    freeBytes,
    percent: deps.budgetBytes === 0 ? 100 : Math.round((usedBytes / deps.budgetBytes) * 1000) / 10,
  };
}

export async function archivePdfDocument(
  input: { actor: Actor; documentId: string },
  deps: DocumentDependencies,
): Promise<{ documentId: string; freedBytes: number }> {
  assertAdmin(input.actor);

  const meta = await deps.documents.getMeta(input.documentId);
  if (!meta) {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }

  await deps.documents.archiveDocument(input.documentId);
  return { documentId: input.documentId, freedBytes: meta.bytes };
}
