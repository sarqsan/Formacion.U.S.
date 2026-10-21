import { DomainError } from "@/domain/text";
import type {
  PdfDocumentMeta,
  PdfDocumentStore,
  StoredChunk,
} from "@/server/documents/store";

/**
 * Almacén de PDF en memoria con las mismas invariantes que el adaptador
 * Firestore: documentos inmutables, fragmentos por índice, contador de cuota
 * que solo cambia al guardar o archivar.
 */
export class InMemoryPdfDocumentStore implements PdfDocumentStore {
  metas = new Map<string, PdfDocumentMeta & { archived?: boolean }>();
  chunks = new Map<string, Uint8Array>();
  usedBytes = 0;
  saves = 0;
  chunkReads = 0;
  private failOnChunkIndex: number | null = null;

  async getMeta(documentId: string): Promise<PdfDocumentMeta | null> {
    const meta = this.metas.get(documentId);
    if (!meta || meta.archived) return null;
    return structuredClone(meta);
  }

  async readChunk(documentId: string, index: number): Promise<Uint8Array | null> {
    this.chunkReads += 1;
    const chunk = this.chunks.get(`${documentId}_${index}`);
    return chunk ? new Uint8Array(chunk) : null;
  }

  async saveDocument(input: {
    meta: PdfDocumentMeta;
    chunks: StoredChunk[];
    bytes: number;
    budgetBytes: number;
  }): Promise<void> {
    if (this.metas.has(input.meta.documentId)) {
      throw new DomainError("DOCUMENT_ALREADY_EXISTS", "Duplicado", 409);
    }
    // Igual que la transacción real: el presupuesto se comprueba contra el
    // contador del momento de escribir, no contra el que leyó el servicio.
    if (this.usedBytes + input.bytes > input.budgetBytes) {
      throw new DomainError("STORAGE_BUDGET_EXCEEDED", "Presupuesto agotado", 507);
    }
    // Fase de preparación: nada se publica hasta que todo está listo.
    const stagedChunks = new Map<string, Uint8Array>();
    for (const chunk of input.chunks) {
      if (this.failOnChunkIndex === chunk.index) {
        this.failOnChunkIndex = null;
        throw new Error("FALLO SIMULADO DE ESCRITURA: la transacción se aborta");
      }
      stagedChunks.set(`${input.meta.documentId}_${chunk.index}`, new Uint8Array(chunk.data));
    }

    // Fase de publicación (lo que en Firestore hace el commit).
    this.saves += 1;
    this.metas.set(input.meta.documentId, structuredClone(input.meta));
    for (const [key, data] of stagedChunks) this.chunks.set(key, data);
    this.usedBytes += input.bytes;
  }

  async archiveDocument(documentId: string): Promise<void> {
    const meta = this.metas.get(documentId);
    if (!meta || meta.archived) return;
    meta.archived = true;
    this.usedBytes = Math.max(0, this.usedBytes - meta.bytes);
  }

  async usageBytes(): Promise<number> {
    return this.usedBytes;
  }

  async recomputeUsageBytes(): Promise<number> {
    return [...this.metas.values()]
      .filter((meta) => !meta.archived)
      .reduce((sum, meta) => sum + meta.bytes, 0);
  }

  /**
   * Simula un fallo de escritura en el fragmento indicado.
   *
   * El doble reproduce el contrato "todo o nada" del adaptador real: prepara
   * todo en memoria y solo publica al final. Así una prueba puede exigir que un
   * fallo a mitad no deje fragmentos huérfanos ni contador tocado.
   *
   * **Lo que esta prueba NO demuestra**: que la transacción real de Firestore
   * sea atómica. Eso requiere el emulador, que sigue bloqueado (ver informe).
   */
  failOnChunk(chunkIndex: number): void {
    this.failOnChunkIndex = chunkIndex;
  }

  /** Nº de fragmentos almacenados (para comprobar que un fallo no deja restos). */
  chunkCount(): number {
    return this.chunks.size;
  }

  /** Simula corrupción: elimina un fragmento. */
  dropChunk(documentId: string, index: number): void {
    this.chunks.delete(`${documentId}_${index}`);
  }
}
