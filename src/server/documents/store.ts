import type { PdfUploadState } from "@/domain/storage/pdf-upload";

/**
 * DOCUMENTOS PDF (puerto de persistencia)
 * ======================================
 *
 * Los PDF NO se guardan en Firebase Storage: el plan Spark no lo incluye.
 * Se guardan en Firestore fragmentados:
 *
 *   documents/{documentId}          metadatos y estado (sin el binario)
 *   pdfChunks/{documentId}_{n}      fragmento n, campo `data` de tipo Bytes
 *   meta/storage                    contadores de cuota (`usedBytes`, `reservedBytes`)
 *
 * Reglas de oro de esta capa:
 *   - El binario se guarda como `Bytes`, NUNCA como texto base64: base64
 *     infla un 33 % y 768 KiB pasarían de 1 MiB, el límite por documento.
 *   - Los fragmentos son solo-servidor (`allow read, write: if false`). El
 *     cliente jamás recibe una URL ni un identificador de Storage.
 *   - Un documento nace `pending` y solo pasa a `active` cuando el servicio ha
 *     verificado todas las partes, el tamaño y el SHA-256 global. Mientras
 *     esté pendiente **no se sirve** a nadie y su cuota está reservada.
 *   - La cuota se comprueba DENTRO de la transacción que reserva o activa: dos
 *     subidas simultáneas no pueden superar el presupuesto.
 *
 * Límites reales del modelo de datos, que condicionan el diseño:
 *   - 1 MiB por documento → fragmentos de 768 KiB y ninguna transacción lleva
 *     más de un fragmento (cada parte se escribe en su propia transacción);
 *   - 10 MiB por petición/transacción → la verificación del SHA-256 lee las
 *     partes **fuera** de la transacción (leer 11 × 768 KiB dentro de una
 *     transacción se acercaría al límite) y la transacción final solo cambia
 *     estado y contadores.
 */

/** Estados del ciclo de vida de un documento (definidos en el dominio). */
export type { PdfUploadState };

export interface PdfDocumentMeta {
  documentId: string;
  courseId: string;
  version: number;
  topicId: string;
  title: string;
  pageCount: number;
  /** Tamaño declarado al crear y verificado antes de activar. */
  bytes: number;
  /** SHA-256 del fichero completo (hex): declarado al crear y verificado al activar. */
  sha256: string;
  /** Longitud de cada fragmento; permite saber cuántos hay y cuánto ocupan. */
  chunkLengths: number[];
  uploadedBy: string;
  uploadedAt: string;
  state: PdfUploadState;
  /** Partes contiguas recibidas desde la 0; en `active` es el total. */
  partsReceived: number;
  finalizedAt: string | null;
  abortedAt: string | null;
}

export interface StoredChunk {
  index: number;
  data: Uint8Array;
}

export interface CreateUploadResult {
  /** `false` si ya existía una subida idéntica y se reutiliza. */
  created: boolean;
  meta: PdfDocumentMeta;
}

export interface PdfDocumentStore {
  /**
   * Metadatos de un documento en cualquier estado menos `aborted`.
   *
   * Devuelve también los **pendientes**: los necesita el editor para reanudar
   * y cancelar. Quien sirva contenido al alumnado está obligado a comprobar
   * `state === "active"`.
   */
  getMeta(documentId: string): Promise<PdfDocumentMeta | null>;

  /** Fragmento por índice; `null` si no existe. */
  readChunk(documentId: string, index: number): Promise<Uint8Array | null>;

  /**
   * Crea el documento pendiente y **reserva** su cuota, en una transacción.
   *
   * Contrato que debe cumplir cualquier implementación:
   *   - si `documentId` ya existe con el mismo autor y los mismos datos →
   *     `created: false` con los metadatos existentes y **sin reservar dos
   *     veces** (doble clic, reintento de la petición);
   *   - si existe con otro autor u otros datos → `UPLOAD_ID_CONFLICT`;
   *   - si `usedBytes + reservedBytes + bytes` supera `budgetBytes` →
   *     `STORAGE_BUDGET_EXCEEDED` comprobado dentro de la transacción.
   */
  createUpload(input: { meta: PdfDocumentMeta; budgetBytes: number }): Promise<CreateUploadResult>;

  /**
   * Guarda una parte y avanza `partsReceived` en la misma transacción.
   *
   *   - solo `pending`, y solo su autor (`UPLOAD_NOT_OWNER`);
   *   - en orden: un índice por delante de lo recibido es `PDF_CHUNK_OUT_OF_ORDER`;
   *   - reenviar una parte ya guardada con el mismo contenido es idempotente
   *     (`stored: false`); con otro contenido es `PDF_CHUNK_CONFLICT`.
   */
  putPart(input: {
    documentId: string;
    index: number;
    data: Uint8Array;
    ownerUid: string;
  }): Promise<{ partsReceived: number; stored: boolean }>;

  /**
   * Activa el documento y convierte la reserva en uso, en una transacción.
   *
   *   - exige `pending` con todas las partes (`PDF_UPLOAD_INCOMPLETE`);
   *   - exige que `bytes` y `sha256` coincidan con lo declarado al crear
   *     (`PDF_SHA256_MISMATCH`), es la barrera de la capa de datos frente a un
   *     servicio que se saltara la verificación;
   *   - repetir la finalización de un documento ya activo es idempotente
   *     (`alreadyActive: true`) y no vuelve a contar cuota.
   */
  finalizeUpload(input: {
    documentId: string;
    bytes: number;
    sha256: string;
    ownerUid: string;
    /** Marca de tiempo del servidor; la pone el servicio, no el cliente. */
    at: string;
  }): Promise<{ alreadyActive: boolean; meta: PdfDocumentMeta }>;

  /**
   * Aborta una subida pendiente y libera su reserva.
   *
   * Idempotente: abortar dos veces devuelve `releasedBytes: 0` la segunda. Un
   * documento activo no se aborta (`UPLOAD_ALREADY_ACTIVE`): se archiva.
   * Los fragmentos se borran después de la transacción; `chunksDeleted` dice
   * cuántos se han eliminado de verdad.
   */
  abortUpload(input: {
    documentId: string;
    ownerUid: string;
    at: string;
  }): Promise<{ releasedBytes: number; chunksDeleted: number }>;

  /** Archiva un documento activo, libera cuota y borra sus fragmentos. */
  archiveDocument(
    documentId: string,
    at: string,
  ): Promise<{ freedBytes: number; chunksDeleted: number }>;

  /** Bytes en uso (documentos activos) según el contador atómico. */
  usageBytes(): Promise<number>;

  /** Bytes reservados por subidas pendientes. */
  reservedBytes(): Promise<number>;

  /** Recalcula contadores desde los metadatos (auditoría; no modifica nada). */
  recomputeUsage(): Promise<{ usedBytes: number; reservedBytes: number }>;

  /** Subidas pendientes de una versión, para poder reanudarlas o cancelarlas. */
  listPending(input: { courseId: string; version: number }): Promise<PdfDocumentMeta[]>;
}
