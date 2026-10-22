import { DomainError } from "@/domain/text";
import { createPdfMemoryState, MemoryPdfDocumentStore } from "@/demo/pdf-store";
import type { PdfDocumentMeta, StoredChunk } from "@/server/documents/store";

/**
 * DOBLE DE ALMACÉN DE PDF CON FALLOS INDUCIDOS
 * ============================================
 *
 * Reutiliza la implementación en memoria de la demostración —el mismo contrato
 * y las mismas comprobaciones que Firestore— y añade dos ganchos para probar lo
 * que en un test normal no ocurre:
 *
 *   - `failOnPart(index)`: la escritura de esa parte falla, y se comprueba que
 *     el documento no avanza (`partsReceived` no sube) ni queda basura;
 *   - `dropChunk(...)`: simula un fragmento perdido.
 *
 * **Lo que NO demuestra**: que la transacción de Firestore sea atómica ni que
 * dos transacciones reales se serialicen. Eso requiere el emulador, que sigue
 * bloqueado (sin JVM); queda declarado en `docs/PRUEBAS.md`.
 */
export class InMemoryPdfDocumentStore extends MemoryPdfDocumentStore {
  private failOnPartIndex: number | null = null;
  private readFailure: Error | null = null;

  constructor() {
    super(createPdfMemoryState());
  }

  override async putPart(input: {
    documentId: string;
    index: number;
    data: Uint8Array;
    ownerUid: string;
  }): Promise<{ partsReceived: number; stored: boolean }> {
    if (this.failOnPartIndex === input.index) {
      this.failOnPartIndex = null;
      throw new Error("FALLO SIMULADO DE ESCRITURA: la transacción se aborta");
    }
    return super.putPart(input);
  }

  /** Programa un fallo en la escritura de la parte indicada. */
  failOnPart(index: number): void {
    this.failOnPartIndex = index;
  }

  /**
   * Hace que la próxima lectura de un fragmento falle (caída del almacén). Se
   * usa para comprobar que la ruta responde con un error seguro y sin bytes.
   */
  failNextRead(
    error: Error = new DomainError("FIRESTORE_UNAVAILABLE", "La base de datos no responde.", 503),
  ): void {
    this.readFailure = error;
  }

  override async readChunk(documentId: string, index: number): Promise<Uint8Array | null> {
    if (this.readFailure) {
      const error = this.readFailure;
      this.readFailure = null;
      throw error;
    }
    return super.readChunk(documentId, index);
  }

  /**
   * Modifica los metadatos sin pasar por el ciclo de subida (para simular un
   * documento incompleto o con el tamaño declarado mal).
   */
  mutateMeta(documentId: string, mutate: (meta: PdfDocumentMeta) => void): void {
    const meta = this.state.metas.get(documentId);
    if (!meta) throw new Error(`No existe el documento ${documentId}`);
    mutate(meta);
  }

  /** Nº de fragmentos almacenados (para comprobar que no quedan restos). */
  chunkCount(): number {
    return this.state.chunks.size;
  }

  /**
   * Corrompe un fragmento **sin** cambiar su longitud (simula un byte alterado
   * en el almacén). Se escribe directamente en el estado, saltándose el orden y
   * la comprobación de contenido, que es justo lo que se quiere probar después.
   */
  corruptChunk(documentId: string, index: number, mutate: (data: Uint8Array) => void): void {
    const key = `${documentId}_${index}`;
    const data = this.state.chunks.get(key);
    if (!data) throw new Error(`No existe el fragmento ${key}`);
    const copy = new Uint8Array(data);
    mutate(copy);
    this.state.chunks.set(key, copy);
  }

  /** Simula corrupción: elimina un fragmento del almacén. */
  dropChunk(documentId: string, index: number): void {
    this.state.chunks.delete(`${documentId}_${index}`);
  }

  /** Metadatos aunque estén abortados (para inspecciones de prueba). */
  rawMeta(documentId: string): PdfDocumentMeta | undefined {
    const meta = this.state.metas.get(documentId);
    return meta ? structuredClone(meta) : undefined;
  }

  /** Fragmentos completos de un documento, como los guarda el almacén. */
  storedChunks(documentId: string): StoredChunk[] {
    const chunks: StoredChunk[] = [];
    for (const [key, data] of this.state.chunks) {
      if (!key.startsWith(`${documentId}_`)) continue;
      chunks.push({ index: Number(key.slice(documentId.length + 1)), data });
    }
    return chunks.sort((a, b) => a.index - b.index);
  }
}

/** Error explícito para pruebas que esperan un fallo del almacén. */
export function failStorage(): never {
  throw new DomainError("FIRESTORE_UNAVAILABLE", "La base de datos no responde.", 503);
}
