import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";
import { assertActiveAccount, assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  CHUNK_BYTES,
  MAX_PDF_BYTES,
  assertFitsTransaction,
  assertPageCountFitsBytes,
  assertPdfBytes,
  formatBytes,
  pageRange,
} from "@/domain/storage/pdf-chunks";
import {
  assertDeclaredBytes,
  assertPageCountDeclared,
  assertPartIndex,
  assertPartLength,
  assertPdfHeader,
  assertSha256Hex,
  assertUploadComplete,
  assertUploadId,
  uploadIdentityMaterial,
  uploadPartCount,
  uploadPartLength,
  uploadProgress,
} from "@/domain/storage/pdf-upload";
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
import type { PdfDocumentMeta, PdfDocumentStore } from "@/server/documents/store";
import type { SlidingWindowLimiter } from "@/server/ratelimit/limiter";

/**
 * DOCUMENTOS PDF SIN FIREBASE STORAGE (servicios)
 * ==============================================
 *
 *   subida   → el administrador **declara** tamaño, páginas y SHA-256; el
 *              servidor reserva cuota, recibe el fichero por partes de 768 KiB,
 *              comprueba orden, tamaños y huella, y solo entonces activa el
 *              documento. Mientras está pendiente no se sirve a nadie.
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
 *
 * Tampoco se interpreta el PDF: solo se mira la cabecera `%PDF-`. El número de
 * páginas lo declara el administrador y **no se verifica automáticamente**.
 */

export interface UploadDependencies {
  documents: PdfDocumentStore;
  catalog: CourseCatalogStore;
  /** Presupuesto para PDF en bytes (cuota gratuita menos reserva). */
  budgetBytes: number;
  /** Límite de peticiones de lectura y de partes; si falta, no se limita (pruebas). */
  limiter?: SlidingWindowLimiter;
  /** Límite de creaciones/finalizaciones; si falta, no se limita (pruebas). */
  uploadLimiter?: SlidingWindowLimiter;
  now?: () => Date;
}

export interface DocumentDependencies extends UploadDependencies {
  enrollments: EnrollmentStore;
  learning: LearningStore;
}

/** Páginas que se pueden pedir en una sola petición. */
export const MAX_PAGES_PER_REQUEST = 20;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Identificador del activo, derivado del contenido y del destino.
 *
 * El cliente no elige identificadores: se calculan aquí a partir de curso,
 * versión, tema, tamaño y huella. Así dos subidas del **mismo** fichero al
 * mismo sitio son la misma operación (no se reserva cuota dos veces) y un
 * fichero distinto —aunque se llame igual— es un activo nuevo.
 */
export function documentIdFor(input: {
  courseId: string;
  version: number;
  topicId: string;
  sha256: string;
  bytes: number;
}): string {
  const digest = createHash("sha256").update(uploadIdentityMaterial(input)).digest("hex");
  return `doc_${digest.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Subida por partes (solo administradores)
// ---------------------------------------------------------------------------

export interface CreateUploadInput {
  actor: Actor;
  courseId: string;
  version: number;
  topicId: string;
  title: string;
  pageCount: number;
  /** Tamaño declarado por el administrador; se verifica al finalizar. */
  bytes: number;
  /** SHA-256 del fichero completo, calculado en el navegador. */
  sha256: string;
}

export interface PdfUploadView {
  documentId: string;
  courseId: string;
  version: number;
  topicId: string;
  title: string;
  pageCount: number;
  bytes: number;
  sha256: string;
  state: PdfDocumentMeta["state"];
  partsTotal: number;
  partsReceived: number;
  percent: number;
  uploadedAt: string;
}

export function uploadView(meta: PdfDocumentMeta): PdfUploadView {
  const progress = uploadProgress(meta.bytes, meta.partsReceived);
  return {
    documentId: meta.documentId,
    courseId: meta.courseId,
    version: meta.version,
    topicId: meta.topicId,
    title: meta.title,
    pageCount: meta.pageCount,
    bytes: meta.bytes,
    sha256: meta.sha256,
    state: meta.state,
    partsTotal: progress.partsTotal,
    partsReceived: progress.partsReceived,
    percent: progress.percent,
    uploadedAt: meta.uploadedAt,
  };
}

/**
 * Abre una subida nueva (o reutiliza la idéntica).
 *
 * Orden de las comprobaciones, de lo barato a lo caro:
 *   1. administrador activo;
 *   2. datos declarados coherentes (tamaño, páginas, huella);
 *   3. la versión existe, está **en borrador** y el tema pertenece a ella;
 *   4. el documento no está ya activo con el mismo contenido (se reutiliza);
 *   5. queda presupuesto: se reserva **dentro** de la transacción del almacén.
 *
 * No se aceptan bytes en este paso: el fichero se envía por partes para no
 * chocar con el límite de cuerpo de las funciones desplegadas.
 */
export async function createPdfUpload(
  input: CreateUploadInput,
  deps: UploadDependencies,
): Promise<{ created: boolean; upload: PdfUploadView }> {
  const admin = assertAdmin(input.actor);
  deps.uploadLimiter?.consumeOrThrow(`upload:${admin.uid}`, 1);

  const bytes = assertDeclaredBytes(input.bytes);
  const sha256 = assertSha256Hex(input.sha256);
  const pageCount = assertPageCountDeclared(input.pageCount, bytes);
  const title = input.title?.trim();
  if (!title) {
    throw new DomainError("DOCUMENT_TITLE_REQUIRED", "El documento necesita un título.", 400);
  }

  const version = await deps.catalog.getVersion(input.courseId, input.version);
  if (!version) {
    throw new DomainError(
      "VERSION_NOT_FOUND",
      "La versión indicada no existe. Crea primero el borrador del curso.",
      404,
    );
  }
  if (version.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Solo se pueden subir documentos a un borrador: una versión publicada es inmutable.",
      409,
    );
  }
  if (!version.topics.some((topic) => topic.id === input.topicId)) {
    throw new DomainError("TOPIC_NOT_IN_COURSE", "El tema no pertenece a esa versión.", 404);
  }

  const now = deps.now?.() ?? new Date();
  const documentId = documentIdFor({
    courseId: input.courseId,
    version: input.version,
    topicId: input.topicId,
    sha256,
    bytes,
  });

  const meta: PdfDocumentMeta = {
    documentId,
    courseId: input.courseId,
    version: input.version,
    topicId: input.topicId,
    title,
    pageCount,
    bytes,
    sha256,
    chunkLengths: Array.from({ length: uploadPartCount(bytes) }, (_, index) =>
      uploadPartLength(bytes, index),
    ),
    uploadedBy: admin.uid,
    uploadedAt: now.toISOString(),
    state: "pending",
    partsReceived: 0,
    finalizedAt: null,
    abortedAt: null,
  };

  const result = await deps.documents.createUpload({ meta, budgetBytes: deps.budgetBytes });
  return { created: result.created, upload: uploadView(result.meta) };
}

/**
 * Guarda una parte del fichero.
 *
 * La parte 0 es especial: además de su tamaño, se comprueba la cabecera
 * `%PDF-`. No se acepta lo que solo *dice* ser un PDF por el nombre o por el
 * `Content-Type` que mande el navegador.
 */
export async function putPdfUploadPart(
  input: { actor: Actor; documentId: string; index: number; bytes: Uint8Array },
  deps: UploadDependencies,
): Promise<{ upload: PdfUploadView; stored: boolean }> {
  const admin = assertAdmin(input.actor);
  deps.limiter?.consumeOrThrow(`pdf:upload:${admin.uid}`, 1);

  const documentId = assertUploadId(input.documentId);
  const meta = await deps.documents.getMeta(documentId);
  if (!meta || meta.state === "aborted") {
    throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
  }
  if (meta.uploadedBy !== admin.uid) {
    throw new DomainError("UPLOAD_NOT_OWNER", "Esta subida la empezó otro administrador.", 403);
  }
  if (meta.state !== "pending") {
    throw new DomainError(
      "UPLOAD_ALREADY_ACTIVE",
      "El documento ya está activo: sus bytes no se modifican.",
      409,
    );
  }

  const index = assertPartIndex(meta.bytes, input.index);
  assertPartLength(meta.bytes, index, input.bytes.length);
  if (index === 0) assertPdfHeader(input.bytes);

  const { partsReceived, stored } = await deps.documents.putPart({
    documentId,
    index,
    data: input.bytes,
    ownerUid: admin.uid,
  });

  return {
    upload: uploadView({ ...meta, partsReceived }),
    stored,
  };
}

export interface FinalizeUploadResult {
  upload: PdfUploadView;
  chunks: number;
  /** `true` si ya estaba activo (doble finalización idempotente). */
  alreadyActive: boolean;
  usage: StorageUsage;
}

/**
 * Verifica y activa el documento.
 *
 * La verificación del SHA-256 se hace **fuera** de la transacción: leer los 11
 * fragmentos de 768 KiB dentro de una transacción se acercaría al límite de
 * 10 MiB por petición de Firestore. Después, una transacción pequeña comprueba
 * que el documento sigue pendiente y pasa la reserva a uso. Los fragmentos son
 * inmutables una vez escritos (un reenvío con otro contenido se rechaza), así
 * que entre la lectura y la transacción nadie puede cambiar el fichero.
 */
export async function finalizePdfUpload(
  input: { actor: Actor; documentId: string },
  deps: UploadDependencies,
): Promise<FinalizeUploadResult> {
  const admin = assertAdmin(input.actor);
  deps.uploadLimiter?.consumeOrThrow(`upload:${admin.uid}`, 1);

  const documentId = assertUploadId(input.documentId);
  const meta = await deps.documents.getMeta(documentId);
  if (!meta || meta.state === "aborted") {
    throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
  }
  if (meta.uploadedBy !== admin.uid) {
    throw new DomainError("UPLOAD_NOT_OWNER", "Esta subida la empezó otro administrador.", 403);
  }

  const now = deps.now?.() ?? new Date();

  if (meta.state === "active") {
    const usage = await storageUsage(deps);
    return {
      upload: uploadView(meta),
      chunks: meta.chunkLengths.length,
      alreadyActive: true,
      usage,
    };
  }

  const total = uploadPartCount(meta.bytes);
  assertUploadComplete(meta.bytes, meta.partsReceived);

  const parts = await readAllParts(meta, deps);
  const joined = concat(parts);

  if (joined.length !== meta.bytes) {
    throw new DomainError(
      "PDF_CHUNK_MISMATCH",
      "Las partes no reconstruyen el tamaño declarado. Cancela la subida y empieza de nuevo.",
      409,
    );
  }
  const computed = sha256Hex(joined);
  if (computed !== meta.sha256) {
    throw new DomainError(
      "PDF_SHA256_MISMATCH",
      "La huella del fichero no coincide con la declarada al empezar. Puede haberse corrompido en el camino: vuelve a subirlo.",
      400,
      { expected: meta.sha256, computed },
    );
  }

  const result = await deps.documents.finalizeUpload({
    documentId,
    bytes: joined.length,
    sha256: computed,
    ownerUid: admin.uid,
    at: now.toISOString(),
  });

  return {
    upload: uploadView(result.meta),
    chunks: total,
    alreadyActive: result.alreadyActive,
    usage: await storageUsage(deps),
  };
}

/** Cancela una subida pendiente y libera su reserva (idempotente). */
export async function abortPdfUpload(
  input: { actor: Actor; documentId: string },
  deps: UploadDependencies,
): Promise<{ releasedBytes: number; chunksDeleted: number; usage: StorageUsage }> {
  const admin = assertAdmin(input.actor);
  deps.uploadLimiter?.consumeOrThrow(`upload:${admin.uid}`, 1);

  const documentId = assertUploadId(input.documentId);
  const now = deps.now?.() ?? new Date();
  const result = await deps.documents.abortUpload({
    documentId,
    ownerUid: admin.uid,
    at: now.toISOString(),
  });

  return { ...result, usage: await storageUsage(deps) };
}

/**
 * Subida de una sola petición (compatibilidad y ficheros pequeños).
 *
 * Usa **el mismo ciclo** que la subida por partes: reserva cuota, escribe los
 * fragmentos y verifica la huella antes de activar. Si algo falla, cancela la
 * subida para no dejar la reserva colgada. No es una segunda vía de escritura.
 */
export interface UploadDocumentInput {
  actor: Actor;
  courseId: string;
  version: number;
  topicId: string;
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
  deps: UploadDependencies,
): Promise<UploadDocumentResult> {
  const admin = assertAdmin(input.actor);

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
  assertPageCountFitsBytes(input.pageCount, input.bytes.length);

  const sha256 = sha256Hex(input.bytes);
  const { upload } = await createPdfUpload(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      topicId: input.topicId,
      title: input.title,
      pageCount: input.pageCount,
      bytes: input.bytes.length,
      sha256,
    },
    deps,
  );

  // Reintento del mismo fichero ya activo: es la misma operación, no se
  // reenvían partes ni se toca un activo inmutable.
  if (upload.state === "active") {
    const usage = await storageUsage(deps);
    return {
      documentId: upload.documentId,
      bytes: upload.bytes,
      chunks: uploadPartCount(upload.bytes),
      sha256: upload.sha256,
      usedBytes: usage.usedBytes,
      budgetBytes: usage.budgetBytes,
    };
  }

  try {
    const total = uploadPartCount(upload.bytes);
    for (let index = 0; index < total; index += 1) {
      await putPdfUploadPart(
        {
          actor: admin,
          documentId: upload.documentId,
          index,
          bytes: input.bytes.subarray(
            index * CHUNK_BYTES,
            Math.min((index + 1) * CHUNK_BYTES, input.bytes.length),
          ),
        },
        deps,
      );
    }

    const finalized = await finalizePdfUpload(
      { actor: admin, documentId: upload.documentId },
      deps,
    );

    return {
      documentId: upload.documentId,
      bytes: upload.bytes,
      chunks: finalized.chunks,
      sha256: finalized.upload.sha256,
      usedBytes: finalized.usage.usedBytes,
      budgetBytes: finalized.usage.budgetBytes,
    };
  } catch (error) {
    // Nada de reservas colgadas por una subida que ya no va a terminar.
    await deps.documents
      .abortUpload({
        documentId: upload.documentId,
        ownerUid: admin.uid,
        at: (deps.now?.() ?? new Date()).toISOString(),
      })
      .catch(() => undefined);
    throw error;
  }
}

async function readAllParts(
  meta: PdfDocumentMeta,
  deps: UploadDependencies,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (let index = 0; index < meta.chunkLengths.length; index += 1) {
    const chunk = await deps.documents.readChunk(meta.documentId, index);
    if (!chunk || chunk.length !== meta.chunkLengths[index]) {
      throw new DomainError(
        "PDF_CHUNK_MISSING",
        `Falta la parte ${index} o su tamaño no coincide. Cancela la subida y empieza de nuevo.`,
        409,
        { part: index },
      );
    }
    parts.push(chunk);
  }
  return parts;
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
 *   2. el documento existe, **está activo** y no está archivado;
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
  // Un documento pendiente o incompleto no existe para nadie: ni siquiera un
  // administrador puede leer bytes que todavía no se han verificado.
  if (!meta || meta.state !== "active") {
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
  /** Reservado por subidas pendientes: no está libre, pero tampoco en uso. */
  reservedBytes: number;
  budgetBytes: number;
  freeBytes: number;
  /** 0..100, sobre lo comprometido (uso + reserva). */
  percent: number;
}

export async function storageUsage(deps: UploadDependencies): Promise<StorageUsage> {
  const [usedBytes, reservedBytes] = await Promise.all([
    deps.documents.usageBytes(),
    deps.documents.reservedBytes(),
  ]);
  const committed = usedBytes + reservedBytes;
  const freeBytes = Math.max(0, deps.budgetBytes - committed);

  return {
    usedBytes,
    reservedBytes,
    budgetBytes: deps.budgetBytes,
    freeBytes,
    percent: deps.budgetBytes === 0 ? 100 : Math.round((committed / deps.budgetBytes) * 1000) / 10,
  };
}

export async function archivePdfDocument(
  input: { actor: Actor; documentId: string },
  deps: UploadDependencies,
): Promise<{ documentId: string; freedBytes: number; chunksDeleted: number; usage: StorageUsage }> {
  assertAdmin(input.actor);

  const meta = await deps.documents.getMeta(input.documentId);
  if (!meta || meta.state !== "active") {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }

  const now = deps.now?.() ?? new Date();
  const result = await deps.documents.archiveDocument(input.documentId, now.toISOString());
  // Un documento archivado deja de ser accesible aunque alguien conservara su
  // identificador: los fragmentos se han borrado y el estado es `aborted`.
  return {
    documentId: input.documentId,
    freedBytes: result.freedBytes,
    chunksDeleted: result.chunksDeleted,
    usage: await storageUsage(deps),
  };
}
