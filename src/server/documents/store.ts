/**
 * DOCUMENTOS PDF (puerto de persistencia)
 * ======================================
 *
 * Los PDF NO se guardan en Firebase Storage: el plan Spark no lo incluye.
 * Se guardan en Firestore fragmentados:
 *
 *   documents/{documentId}          metadatos (sin el binario, sin rutas)
 *   pdfChunks/{documentId}_{n}      fragmento n, campo `data` de tipo Bytes
 *
 * Reglas de oro de esta capa:
 *   - El binario se guarda como `Bytes`, NUNCA como texto base64: base64
 *     infla un 33 % y 768 KiB pasarían de 1 MiB, el límite por documento.
 *   - Los fragmentos son solo-servidor (`allow read, write: if false`). El
 *     cliente jamás recibe una URL ni un identificador de Storage.
 *   - La escritura de todos los fragmentos y de la cuota es una transacción:
 *     o entra el documento completo, o no entra nada.
 */

export interface PdfDocumentMeta {
  documentId: string;
  courseId: string;
  version: number;
  topicId: string;
  title: string;
  pageCount: number;
  /** Tamaño real del PDF en bytes. */
  bytes: number;
  /** SHA-256 del fichero completo (hex), para detectar corrupción. */
  sha256: string;
  /** Longitud de cada fragmento; permite saber cuántos hay y cuánto ocupan. */
  chunkLengths: number[];
  uploadedBy: string;
  uploadedAt: string;
}

export interface StoredChunk {
  index: number;
  data: Uint8Array;
}

export interface PdfDocumentStore {
  getMeta(documentId: string): Promise<PdfDocumentMeta | null>;

  /** Fragmento por índice; `null` si no existe. */
  readChunk(documentId: string, index: number): Promise<Uint8Array | null>;

  /**
   * Escritura atómica de metadatos + fragmentos + contador de cuota.
   *
   * Contrato que debe cumplir cualquier implementación:
   *   - si el documento ya existe → falla, sin escribir nada;
   *   - si `usedBytes + bytes > budgetBytes` → falla con
   *     `STORAGE_BUDGET_EXCEEDED`, **comprobado dentro de la transacción**
   *     (dos subidas simultáneas no pueden pasar ambas);
   *   - si algo falla a mitad → no queda ni un fragmento huérfano ni el
   *     contador tocado (todo va en la misma transacción).
   */
  saveDocument(input: {
    meta: PdfDocumentMeta;
    chunks: StoredChunk[];
    /** Bytes que ocupa este documento (== meta.bytes, explícito para la cuota). */
    bytes: number;
    /** Presupuesto global; la comprobación definitiva se hace al escribir. */
    budgetBytes: number;
  }): Promise<void>;

  /** Marca como archivado (no sirve contenido) y libera cuota. */
  archiveDocument(documentId: string): Promise<void>;

  /** Bytes en uso según el contador atómico `meta/storage`. */
  usageBytes(): Promise<number>;

  /** Recalcula desde los metadatos (auditoría; no modifica nada). */
  recomputeUsageBytes(): Promise<number>;
}
