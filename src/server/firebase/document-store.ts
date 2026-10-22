import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import { partOrderAction, uploadPartCount } from "@/domain/storage/pdf-upload";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";
import type {
  CreateUploadResult,
  PdfDocumentMeta,
  PdfDocumentStore,
  PdfUploadState,
} from "@/server/documents/store";

/**
 * PDF EN FIRESTORE (adaptador)
 * ===========================
 *
 *   documents/{documentId}       metadatos y estado. SOLO SERVIDOR.
 *   pdfChunks/{documentId}_{n}   `data` como Bytes. Solo servidor.
 *   meta/storage                 contadores `usedBytes` y `reservedBytes`.
 *
 * La subida es **por partes**, y cada parte es su propia transacción:
 *
 *   create    reserva la cuota y deja el documento `pending`   (2 docs)
 *   part n    escribe el fragmento y suma `partsReceived`      (2 docs)
 *   finalize  `pending` → `active`; reserva → uso              (2 docs)
 *   abort     `pending` → `aborted`; libera la reserva         (2 docs)
 *
 * Por qué no todo en una transacción: Firestore limita cada petición a 10 MiB
 * y cada documento a 1 MiB. Con 8 MiB de PDF, escribir los 11 fragmentos en
 * una sola transacción quedaba al borde del límite de tamaño, y **verificar el
 * SHA-256 exigiría leerlos todos dentro de ella**. Aquí la verificación se hace
 * fuera (lecturas normales) y la transacción final solo comprueba estado y
 * mueve contadores: cambia 3 documentos pequeños y no depende del tamaño del
 * PDF.
 *
 * Concurrencia: las comprobaciones de presupuesto y de estado se hacen con el
 * documento releído DENTRO de la transacción. Firestore reintenta la
 * transacción perdedora, que vuelve a leer el contador ya incrementado.
 */

const CHUNKS = COLLECTIONS.pdfChunks;

function chunkRef(documentId: string, index: number) {
  return getAdminDb().collection(CHUNKS).doc(`${documentId}_${index}`);
}

function metaRef(documentId: string) {
  return getAdminDb().collection(COLLECTIONS.documents).doc(documentId);
}

function storageCounterRef() {
  return getAdminDb().collection(COLLECTIONS.meta).doc("storage");
}

interface StoredChunkDoc {
  documentId: string;
  index: number;
  data?: Uint8Array;
  sha256?: string;
}

interface StoredMetaDoc extends Partial<PdfDocumentMeta> {
  archived?: boolean;
  originVersion?: number;
}

/**
 * Normaliza un documento leído.
 *
 * Compatibilidad: los documentos anteriores a este bloque no tienen `state` y
 * usan `archived`. Se leen como `active` (nunca fueron pendientes) sin migrar
 * nada, para no romper cursos ya subidos.
 */
function toMeta(documentId: string, data: StoredMetaDoc): PdfDocumentMeta {
  const state: PdfUploadState =
    data.state ?? (data.archived === true ? "aborted" : "active");

  return {
    documentId,
    courseId: String(data.courseId ?? ""),
    // v2 guarda `originVersion`; v1 solo `version`.
    version: Number(data.originVersion ?? data.version ?? 0),
    topicId: String(data.topicId ?? ""),
    title: String(data.title ?? ""),
    pageCount: Number(data.pageCount ?? 0),
    bytes: Number(data.bytes ?? 0),
    sha256: String(data.sha256 ?? ""),
    chunkLengths: Array.isArray(data.chunkLengths)
      ? data.chunkLengths.map((length) => Number(length))
      : [],
    uploadedBy: String(data.uploadedBy ?? ""),
    uploadedAt: String(data.uploadedAt ?? ""),
    state,
    partsReceived: Number(
      data.partsReceived ?? (state === "active" ? (data.chunkLengths?.length ?? 0) : 0),
    ),
    finalizedAt: data.finalizedAt ?? null,
    abortedAt: data.abortedAt ?? null,
  };
}

function metaFields(meta: PdfDocumentMeta) {
  return {
    documentId: meta.documentId,
    courseId: meta.courseId,
    // Se escribe el campo nuevo y se conserva el antiguo por compatibilidad.
    version: meta.version,
    originVersion: meta.version,
    topicId: meta.topicId,
    title: meta.title,
    pageCount: meta.pageCount,
    bytes: meta.bytes,
    sha256: meta.sha256,
    chunkLengths: meta.chunkLengths,
    uploadedBy: meta.uploadedBy,
    uploadedAt: meta.uploadedAt,
    state: meta.state,
    partsReceived: meta.partsReceived,
    finalizedAt: meta.finalizedAt,
    abortedAt: meta.abortedAt,
    archived: meta.state === "aborted",
  };
}

function readCounter(data: { usedBytes?: unknown; reservedBytes?: unknown } | undefined) {
  return {
    usedBytes: Number(data?.usedBytes ?? 0),
    reservedBytes: Number(data?.reservedBytes ?? 0),
  };
}

export class FirestorePdfDocumentStore implements PdfDocumentStore {
  async getMeta(documentId: string): Promise<PdfDocumentMeta | null> {
    return guard(async () => {
      const snapshot = await metaRef(documentId).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data() as StoredMetaDoc | undefined;
      if (!data) return null;
      const meta = toMeta(documentId, data);
      return meta.state === "aborted" ? null : meta;
    });
  }

  async readChunk(documentId: string, index: number): Promise<Uint8Array | null> {
    return guard(async () => {
      const snapshot = await chunkRef(documentId, index).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data() as StoredChunkDoc | undefined;
      return data?.data ?? null;
    });
  }

  async createUpload(input: { meta: PdfDocumentMeta; budgetBytes: number }): Promise<CreateUploadResult> {
    return guard(async () => {
      const db = getAdminDb();
      const ref = metaRef(input.meta.documentId);
      const counterRef = storageCounterRef();

      return db.runTransaction(async (transaction) => {
        const [existing, counter] = await Promise.all([
          transaction.get(ref),
          transaction.get(counterRef),
        ]);

        if (existing.exists) {
          const current = toMeta(input.meta.documentId, existing.data() as StoredMetaDoc);
          const sameUpload =
            current.uploadedBy === input.meta.uploadedBy &&
            current.courseId === input.meta.courseId &&
            current.version === input.meta.version &&
            current.topicId === input.meta.topicId &&
            current.sha256 === input.meta.sha256 &&
            current.bytes === input.meta.bytes;

          if (!sameUpload) {
            throw new DomainError(
              "UPLOAD_ID_CONFLICT",
              "Ese identificador de documento ya está en uso por otra subida.",
              409,
            );
          }
          if (current.state === "aborted") {
            // Reabrir una subida cancelada o un activo archivado: mismo
            // fichero, mismo destino. Se borran los restos y se reserva otra
            // vez con las mismas comprobaciones de presupuesto.
            const { usedBytes, reservedBytes } = readCounter(counter.data());
            if (usedBytes + reservedBytes + input.meta.bytes > input.budgetBytes) {
              throw new DomainError(
                "STORAGE_BUDGET_EXCEEDED",
                "No queda espacio para este documento: el presupuesto de PDF está agotado. Archiva documentos antiguos o cancela subidas pendientes.",
                507,
              );
            }

            for (let index = 0; index < current.chunkLengths.length; index += 1) {
              transaction.delete(chunkRef(input.meta.documentId, index));
            }
            transaction.set(ref, metaFields(input.meta));
            transaction.set(
              counterRef,
              {
                usedBytes,
                reservedBytes: reservedBytes + input.meta.bytes,
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
            return { created: true, meta: input.meta };
          }
          return { created: false, meta: current };
        }

        const { usedBytes, reservedBytes } = readCounter(counter.data());
        if (usedBytes + reservedBytes + input.meta.bytes > input.budgetBytes) {
          throw new DomainError(
            "STORAGE_BUDGET_EXCEEDED",
            "No queda espacio para este documento: el presupuesto de PDF está agotado. Archiva documentos antiguos o cancela subidas pendientes.",
            507,
          );
        }

        transaction.set(ref, metaFields(input.meta));
        transaction.set(
          counterRef,
          {
            usedBytes,
            reservedBytes: reservedBytes + input.meta.bytes,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return { created: true, meta: input.meta };
      });
    });
  }

  async putPart(input: {
    documentId: string;
    index: number;
    data: Uint8Array;
    ownerUid: string;
  }): Promise<{ partsReceived: number; stored: boolean }> {
    return guard(async () => {
      const db = getAdminDb();
      const ref = metaRef(input.documentId);
      const partRef = chunkRef(input.documentId, input.index);

      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
        }

        const meta = toMeta(input.documentId, snapshot.data() as StoredMetaDoc);
        if (meta.state === "aborted") {
          throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
        }
        if (meta.uploadedBy !== input.ownerUid) {
          throw new DomainError(
            "UPLOAD_NOT_OWNER",
            "Esta subida la empezó otro administrador.",
            403,
          );
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

        if (action === "retry") {
          const stored = await transaction.get(partRef);
          if (!stored.exists) {
            throw new DomainError(
              "PDF_CHUNK_MISSING",
              "Esa parte se marcó como recibida pero ya no está: cancela la subida y empieza de nuevo.",
              409,
            );
          }
          const data = stored.data() as StoredChunkDoc | undefined;
          // El fragmento guarda la huella del contenido: un reenvío con otros
          // bytes es un fichero distinto a mitad de subida, no un reintento.
          if (data?.sha256 && data.sha256 !== sha256Of(input.data)) {
            throw new DomainError(
              "PDF_CHUNK_CONFLICT",
              `La parte ${input.index} ya se guardó con otro contenido. El fichero ha cambiado a mitad de la subida.`,
              409,
            );
          }
          return { partsReceived: meta.partsReceived, stored: false };
        }

        transaction.set(partRef, {
          documentId: input.documentId,
          index: input.index,
          data: Buffer.from(input.data),
          sha256: sha256Of(input.data),
          sha256OfDocument: meta.sha256,
        });
        transaction.update(ref, {
          partsReceived: meta.partsReceived + 1,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return { partsReceived: meta.partsReceived + 1, stored: true };
      });
    });
  }

  async finalizeUpload(input: {
    documentId: string;
    bytes: number;
    sha256: string;
    ownerUid: string;
    at: string;
  }): Promise<{ alreadyActive: boolean; meta: PdfDocumentMeta }> {
    return guard(async () => {
      const db = getAdminDb();
      const ref = metaRef(input.documentId);
      const counterRef = storageCounterRef();

      return db.runTransaction(async (transaction) => {
        const [snapshot, counter] = await Promise.all([
          transaction.get(ref),
          transaction.get(counterRef),
        ]);
        if (!snapshot.exists) {
          throw new DomainError("UPLOAD_NOT_FOUND", "La subida no existe.", 404);
        }

        const meta = toMeta(input.documentId, snapshot.data() as StoredMetaDoc);
        if (meta.uploadedBy !== input.ownerUid) {
          throw new DomainError(
            "UPLOAD_NOT_OWNER",
            "Esta subida la empezó otro administrador.",
            403,
          );
        }
        if (meta.state === "aborted") {
          throw new DomainError("UPLOAD_ABORTED", "Esta subida se canceló: vuelve a empezarla.", 409);
        }
        if (meta.state === "active") {
          if (meta.bytes !== input.bytes || meta.sha256 !== input.sha256) {
            throw new DomainError(
              "UPLOAD_ALREADY_ACTIVE",
              "El documento ya está activo con otro contenido.",
              409,
            );
          }
          return { alreadyActive: true, meta };
        }

        const total = uploadPartCount(meta.bytes);
        if (meta.partsReceived !== total) {
          throw new DomainError(
            "PDF_UPLOAD_INCOMPLETE",
            `La subida está incompleta: faltan ${total - meta.partsReceived} de ${total} partes.`,
            409,
          );
        }
        // Barrera de la capa de datos: aunque el servicio ya ha verificado la
        // huella leyendo los fragmentos, aquí se exige que lo declarado y lo
        // verificado sean lo mismo antes de mover un solo byte de cuota.
        if (meta.bytes !== input.bytes || meta.sha256 !== input.sha256) {
          throw new DomainError(
            "PDF_SHA256_MISMATCH",
            "El tamaño o la huella no coinciden con lo declarado al empezar la subida.",
            400,
          );
        }

        const { usedBytes, reservedBytes } = readCounter(counter.data());
        transaction.update(ref, {
          state: "active",
          finalizedAt: input.at,
          partsReceived: total,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(
          counterRef,
          {
            usedBytes: usedBytes + meta.bytes,
            reservedBytes: Math.max(0, reservedBytes - meta.bytes),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return {
          alreadyActive: false,
          meta: { ...meta, state: "active", finalizedAt: input.at, partsReceived: total },
        };
      });
    });
  }

  async abortUpload(input: {
    documentId: string;
    ownerUid: string;
    at: string;
  }): Promise<{ releasedBytes: number; chunksDeleted: number }> {
    const result = await guard(async () => {
      const db = getAdminDb();
      const ref = metaRef(input.documentId);
      const counterRef = storageCounterRef();

      return db.runTransaction(async (transaction) => {
        const [snapshot, counter] = await Promise.all([
          transaction.get(ref),
          transaction.get(counterRef),
        ]);

        if (!snapshot.exists) return { releasedBytes: 0, meta: null };

        const meta = toMeta(input.documentId, snapshot.data() as StoredMetaDoc);
        if (meta.state === "aborted") return { releasedBytes: 0, meta };
        if (meta.uploadedBy !== input.ownerUid) {
          throw new DomainError(
            "UPLOAD_NOT_OWNER",
            "Esta subida la empezó otro administrador.",
            403,
          );
        }
        if (meta.state === "active") {
          throw new DomainError(
            "UPLOAD_ALREADY_ACTIVE",
            "El documento ya está activo: no se cancela, se archiva.",
            409,
          );
        }

        const { usedBytes, reservedBytes } = readCounter(counter.data());
        transaction.update(ref, {
          state: "aborted",
          abortedAt: input.at,
          archived: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(
          counterRef,
          {
            usedBytes,
            reservedBytes: Math.max(0, reservedBytes - meta.bytes),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return { releasedBytes: meta.bytes, meta };
      });
    });

    if (!result.meta) return { releasedBytes: 0, chunksDeleted: 0 };
    return {
      releasedBytes: result.releasedBytes,
      chunksDeleted: await this.deleteChunks(input.documentId, result.meta),
    };
  }

  async archiveDocument(
    documentId: string,
    at: string,
  ): Promise<{ freedBytes: number; chunksDeleted: number }> {
    const result = await guard(async () => {
      const db = getAdminDb();
      const ref = metaRef(documentId);
      const counterRef = storageCounterRef();

      return db.runTransaction(async (transaction) => {
        const [snapshot, counter] = await Promise.all([
          transaction.get(ref),
          transaction.get(counterRef),
        ]);
        if (!snapshot.exists) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
        }

        const meta = toMeta(documentId, snapshot.data() as StoredMetaDoc);
        if (meta.state === "aborted") {
          throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
        }
        if (meta.state === "pending") {
          throw new DomainError(
            "UPLOAD_NOT_ACTIVE",
            "La subida todavía no se ha completado: cancélala en lugar de archivarla.",
            409,
          );
        }

        const { usedBytes, reservedBytes } = readCounter(counter.data());
        transaction.update(ref, {
          state: "aborted",
          abortedAt: at,
          archived: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(
          counterRef,
          {
            usedBytes: Math.max(0, usedBytes - meta.bytes),
            reservedBytes,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        return { freedBytes: meta.bytes, meta };
      });
    });

    return {
      freedBytes: result.freedBytes,
      chunksDeleted: await this.deleteChunks(documentId, result.meta),
    };
  }

  async usageBytes(): Promise<number> {
    return guard(async () => {
      const snapshot = await storageCounterRef().get();
      return Number(snapshot.data()?.usedBytes ?? 0);
    });
  }

  async reservedBytes(): Promise<number> {
    return guard(async () => {
      const snapshot = await storageCounterRef().get();
      return Number(snapshot.data()?.reservedBytes ?? 0);
    });
  }

  async recomputeUsage(): Promise<{ usedBytes: number; reservedBytes: number }> {
    return guard(async () => {
      // Auditoría: recorre los metadatos (pocos documentos) y recalcula. No
      // escribe nada; si no cuadra con el contador, hay una incoherencia que
      // revisar antes de seguir subiendo.
      const snapshot = await getAdminDb().collection(COLLECTIONS.documents).get();
      let usedBytes = 0;
      let reservedBytes = 0;

      for (const doc of snapshot.docs) {
        const meta = toMeta(doc.id, doc.data() as StoredMetaDoc);
        if (meta.state === "active") usedBytes += meta.bytes;
        else if (meta.state === "pending") reservedBytes += meta.bytes;
      }

      return { usedBytes, reservedBytes };
    });
  }

  async listPending(input: { courseId: string; version: number }): Promise<PdfDocumentMeta[]> {
    return guard(async () => {
      // Igualdad simple sobre el campo y filtro en memoria: no exige un índice
      // compuesto que haya que publicar, y el número de subidas de una versión
      // es pequeño por construcción.
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.documents)
        .where("courseId", "==", input.courseId)
        .get();

      return snapshot.docs
        .map((doc) => toMeta(doc.id, doc.data() as StoredMetaDoc))
        .filter((meta) => meta.state === "pending" && meta.version === input.version)
        .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
    });
  }

  private async deleteChunks(documentId: string, meta: PdfDocumentMeta): Promise<number> {
    if (meta.chunkLengths.length === 0) return 0;
    const db = getAdminDb();
    const batch = db.batch();
    for (let index = 0; index < meta.chunkLengths.length; index += 1) {
      batch.delete(chunkRef(documentId, index));
    }
    await guard(async () => {
      await batch.commit();
    });
    return meta.chunkLengths.length;
  }
}

/** SHA-256 de una parte, para detectar un reenvío con otro contenido. */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
