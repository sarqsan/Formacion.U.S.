import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";
import { partOrderAction, uploadPartCount } from "@/domain/storage/pdf-upload";
import type {
  CreateUploadResult,
  PdfDocumentMeta,
  PdfDocumentStore,
} from "@/server/documents/store";

/**
 * ALMACÉN DE PDF EN MEMORIA (demostración y pruebas)
 * ================================================
 *
 * Implementa el MISMO contrato que el adaptador de Firestore, con las mismas
 * reglas: estados, reserva de cuota, orden de partes, idempotencia y borrado de
 * fragmentos al abortar o archivar.
 *
 * Lo que **no** reproduce: transacciones ni concurrencia real. Firestore
 * reintenta transacciones y bloquea documentos; aquí hay un solo proceso y un
 * `Map`, así que cada método es atómico por construcción. Las pruebas de
 * concurrencia comprueban la comprobación de presupuesto contra el contador
 * vigente, no el aislamiento del motor.
 */

export interface PdfMemoryState {
  metas: Map<string, PdfDocumentMeta>;
  chunks: Map<string, Uint8Array>;
  usedBytes: number;
  reservedBytes: number;
}

export function createPdfMemoryState(): PdfMemoryState {
  return { metas: new Map(), chunks: new Map(), usedBytes: 0, reservedBytes: 0 };
}

function chunkKey(documentId: string, index: number): string {
  return `${documentId}_${index}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class MemoryPdfDocumentStore implements PdfDocumentStore {
  /** Escrituras de partes (las pruebas comprueban que no hay duplicados). */
  partWrites = 0;
  /** Documentos activados (para la prueba de doble finalización). */
  finalizations = 0;
  /** Bytes borrados de la base (fragmentos) al abortar o archivar. */
  chunksDeleted = 0;

  constructor(protected readonly state: PdfMemoryState = createPdfMemoryState()) {}

  async getMeta(documentId: string): Promise<PdfDocumentMeta | null> {
    const meta = this.state.metas.get(documentId);
    if (!meta || meta.state === "aborted") return null;
    return structuredClone(meta);
  }

  async readChunk(documentId: string, index: number): Promise<Uint8Array | null> {
    const chunk = this.state.chunks.get(chunkKey(documentId, index));
    return chunk ? new Uint8Array(chunk) : null;
  }

  async createUpload(input: { meta: PdfDocumentMeta; budgetBytes: number }): Promise<CreateUploadResult> {
    const existing = this.state.metas.get(input.meta.documentId);

    if (existing) {
      // Misma operación (misma huella y mismo destino): se reutiliza.
      const sameUpload =
        existing.uploadedBy === input.meta.uploadedBy &&
        existing.courseId === input.meta.courseId &&
        existing.version === input.meta.version &&
        existing.topicId === input.meta.topicId &&
        existing.sha256 === input.meta.sha256 &&
        existing.bytes === input.meta.bytes;

      if (!sameUpload) {
        throw new DomainError(
          "UPLOAD_ID_CONFLICT",
          "Ese identificador de documento ya está en uso por otra subida.",
          409,
        );
      }
      if (existing.state === "aborted") {
        // Una subida cancelada (o un activo archivado) se puede reabrir: es el
        // mismo fichero en el mismo sitio. Se borran sus restos y se reserva de
        // nuevo, con las mismas comprobaciones de presupuesto que una nueva.
        const committed = this.state.usedBytes + this.state.reservedBytes + input.meta.bytes;
        if (committed > input.budgetBytes) {
          throw new DomainError(
            "STORAGE_BUDGET_EXCEEDED",
            "No queda espacio para este documento: el presupuesto de PDF está agotado. Archiva documentos antiguos o cancela subidas pendientes.",
            507,
          );
        }

        this.deleteChunks(input.meta.documentId, existing);
        const reopened: PdfDocumentMeta = {
          ...input.meta,
          state: "pending",
          partsReceived: 0,
          finalizedAt: null,
          abortedAt: null,
        };
        this.state.metas.set(input.meta.documentId, reopened);
        this.state.reservedBytes += reopened.bytes;
        return { created: true, meta: structuredClone(reopened) };
      }
      return { created: false, meta: structuredClone(existing) };
    }

    if (input.meta.uploadedBy.trim() === "") {
      throw new DomainError("UPLOAD_OWNER_REQUIRED", "La subida necesita un autor.", 400);
    }

    const committed = this.state.usedBytes + this.state.reservedBytes + input.meta.bytes;
    if (committed > input.budgetBytes) {
      throw new DomainError(
        "STORAGE_BUDGET_EXCEEDED",
        "No queda espacio para este documento: el presupuesto de PDF está agotado. Archiva documentos antiguos o cancela subidas pendientes.",
        507,
      );
    }

    this.state.metas.set(input.meta.documentId, structuredClone(input.meta));
    this.state.reservedBytes += input.meta.bytes;
    return { created: true, meta: structuredClone(input.meta) };
  }

  async putPart(input: {
    documentId: string;
    index: number;
    data: Uint8Array;
    ownerUid: string;
  }): Promise<{ partsReceived: number; stored: boolean }> {
    const meta = this.state.metas.get(input.documentId);
    if (!meta || meta.state === "aborted") {
      throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
    }
    if (meta.uploadedBy !== input.ownerUid) {
      throw new DomainError("UPLOAD_NOT_OWNER", "Esta subida la empezó otro administrador.", 403);
    }
    if (meta.state !== "pending") {
      throw new DomainError(
        "UPLOAD_ALREADY_ACTIVE",
        "El documento ya está activo: sus bytes no se modifican.",
        409,
      );
    }

    const total = uploadPartCount(meta.bytes);
    const action = partOrderAction(meta.partsReceived, input.index, total);
    const key = chunkKey(input.documentId, input.index);

    if (action === "retry") {
      const stored = this.state.chunks.get(key);
      if (!stored) {
        throw new DomainError(
          "PDF_CHUNK_MISSING",
          "Esa parte se marcó como recibida pero ya no está: cancela la subida y empieza de nuevo.",
          409,
        );
      }
      if (sha256Hex(stored) !== sha256Hex(input.data)) {
        throw new DomainError(
          "PDF_CHUNK_CONFLICT",
          `La parte ${input.index} ya se guardó con otro contenido. El fichero ha cambiado a mitad de la subida.`,
          409,
        );
      }
      return { partsReceived: meta.partsReceived, stored: false };
    }

    this.state.chunks.set(key, new Uint8Array(input.data));
    meta.partsReceived += 1;
    this.partWrites += 1;
    return { partsReceived: meta.partsReceived, stored: true };
  }

  async finalizeUpload(input: {
    documentId: string;
    bytes: number;
    sha256: string;
    ownerUid: string;
    at: string;
  }): Promise<{ alreadyActive: boolean; meta: PdfDocumentMeta }> {
    const meta = this.state.metas.get(input.documentId);
    if (!meta || meta.state === "aborted") {
      throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
    }
    if (meta.uploadedBy !== input.ownerUid) {
      throw new DomainError("UPLOAD_NOT_OWNER", "Esta subida la empezó otro administrador.", 403);
    }
    if (meta.state === "active") {
      if (meta.bytes !== input.bytes || meta.sha256 !== input.sha256) {
        throw new DomainError(
          "UPLOAD_ALREADY_ACTIVE",
          "El documento ya está activo con otro contenido.",
          409,
        );
      }
      return { alreadyActive: true, meta: structuredClone(meta) };
    }

    const total = uploadPartCount(meta.bytes);
    if (meta.partsReceived !== total) {
      throw new DomainError(
        "PDF_UPLOAD_INCOMPLETE",
        `La subida está incompleta: faltan ${total - meta.partsReceived} de ${total} partes.`,
        409,
      );
    }
    if (meta.bytes !== input.bytes || meta.sha256 !== input.sha256) {
      throw new DomainError(
        "PDF_SHA256_MISMATCH",
        "El tamaño o la huella no coinciden con lo declarado al empezar la subida.",
        400,
      );
    }

    meta.state = "active";
    meta.finalizedAt = meta.finalizedAt ?? input.at;
    this.state.reservedBytes = Math.max(0, this.state.reservedBytes - meta.bytes);
    this.state.usedBytes += meta.bytes;
    this.finalizations += 1;
    return { alreadyActive: false, meta: structuredClone(meta) };
  }

  async abortUpload(input: {
    documentId: string;
    ownerUid: string;
    at: string;
  }): Promise<{ releasedBytes: number; chunksDeleted: number }> {
    const meta = this.state.metas.get(input.documentId);
    if (!meta || meta.state === "aborted") {
      // Idempotente: cancelar dos veces no libera dos veces.
      return { releasedBytes: 0, chunksDeleted: 0 };
    }
    if (meta.uploadedBy !== input.ownerUid) {
      throw new DomainError("UPLOAD_NOT_OWNER", "Esta subida la empezó otro administrador.", 403);
    }
    if (meta.state === "active") {
      throw new DomainError(
        "UPLOAD_ALREADY_ACTIVE",
        "El documento ya está activo: no se cancela, se archiva.",
        409,
      );
    }

    meta.state = "aborted";
    meta.abortedAt = input.at;
    const released = meta.bytes;
    this.state.reservedBytes = Math.max(0, this.state.reservedBytes - released);
    const chunksDeleted = this.deleteChunks(input.documentId, meta);
    return { releasedBytes: released, chunksDeleted };
  }

  async archiveDocument(
    documentId: string,
    at: string,
  ): Promise<{ freedBytes: number; chunksDeleted: number }> {
    const meta = this.state.metas.get(documentId);
    if (!meta || meta.state === "aborted") {
      throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
    }
    if (meta.state === "pending") {
      throw new DomainError(
        "UPLOAD_NOT_ACTIVE",
        "La subida todavía no se ha completado: cancélala en lugar de archivarla.",
        409,
      );
    }

    meta.state = "aborted";
    meta.abortedAt = at;
    this.state.usedBytes = Math.max(0, this.state.usedBytes - meta.bytes);
    const chunksDeleted = this.deleteChunks(documentId, meta);
    return { freedBytes: meta.bytes, chunksDeleted };
  }

  async usageBytes(): Promise<number> {
    return this.state.usedBytes;
  }

  async reservedBytes(): Promise<number> {
    return this.state.reservedBytes;
  }

  async recomputeUsage(): Promise<{ usedBytes: number; reservedBytes: number }> {
    let usedBytes = 0;
    let reservedBytes = 0;
    for (const meta of this.state.metas.values()) {
      if (meta.state === "active") usedBytes += meta.bytes;
      else if (meta.state === "pending") reservedBytes += meta.bytes;
    }
    return { usedBytes, reservedBytes };
  }

  async listPending(input: { courseId: string; version: number }): Promise<PdfDocumentMeta[]> {
    return [...this.state.metas.values()]
      .filter(
        (meta) =>
          meta.state === "pending" &&
          meta.courseId === input.courseId &&
          meta.version === input.version,
      )
      .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))
      .map((meta) => structuredClone(meta));
  }

  private deleteChunks(documentId: string, meta: PdfDocumentMeta): number {
    let deleted = 0;
    for (let index = 0; index < meta.chunkLengths.length; index += 1) {
      if (this.state.chunks.delete(chunkKey(documentId, index))) deleted += 1;
    }
    this.chunksDeleted += deleted;
    return deleted;
  }
}
