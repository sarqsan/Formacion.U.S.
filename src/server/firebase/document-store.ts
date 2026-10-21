import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import { COLLECTIONS, META_DOC } from "@/server/db/schema.constants";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";
import type { PdfDocumentMeta, PdfDocumentStore, StoredChunk } from "@/server/documents/store";

/**
 * PDF EN FIRESTORE (adaptador)
 * ===========================
 *
 *   documents/{documentId}       metadatos. SOLO SERVIDOR desde el esquema v2:
 *                                el cliente no los lee ni conociendo el id.
 *   pdfChunks/{documentId}_{n}   `data` como Bytes. Solo servidor.
 *   meta/storage                 contador `usedBytes` de la cuota de PDF.
 *
 * La subida es una transacción: se relee el contador, se comprueba que el
 * documento no exista y se escriben TODOS los fragmentos junto con el
 * contador y los metadatos. Si algo falla, no queda basura a medias.
 *
 * Nota de coste: una transacción de Firestore admite hasta 500 escrituras, así
 * que 27 fragmentos + metadatos + contador (29) quedan muy lejos del límite.
 */

const CHUNKS = COLLECTIONS.pdfChunks;

function chunkRef(documentId: string, index: number) {
  return getAdminDb().collection(CHUNKS).doc(`${documentId}_${index}`);
}

function storageCounterRef() {
  return getAdminDb()
    .collection(META_DOC.collection)
    .doc("storage");
}

interface StoredChunkDoc {
  documentId: string;
  index: number;
  data?: Uint8Array;
}

export class FirestorePdfDocumentStore implements PdfDocumentStore {
  async getMeta(documentId: string): Promise<PdfDocumentMeta | null> {
    return guard(async () => {
      const snapshot = await getAdminDb().collection(COLLECTIONS.documents).doc(documentId).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data() as
        | (Partial<PdfDocumentMeta> & { archived?: boolean; originVersion?: number })
        | undefined;
      if (!data || data.archived === true) return null;

      return {
        documentId,
        courseId: String(data.courseId ?? ""),
        // Compatibilidad v1 → v2: los documentos nuevos guardan `originVersion`
        // (la versión en la que se subieron) y los antiguos solo `version`. Se
        // lee el primero y se cae al segundo, sin migrar ningún dato.
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
      };
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

  async saveDocument(input: {
    meta: PdfDocumentMeta;
    chunks: StoredChunk[];
    bytes: number;
    budgetBytes: number;
  }): Promise<void> {
    await guard(async () => {
      const db = getAdminDb();
      const metaRef = db.collection(COLLECTIONS.documents).doc(input.meta.documentId);
      const counterRef = storageCounterRef();

      await db.runTransaction(async (transaction) => {
        const [existing, counter] = await Promise.all([
          transaction.get(metaRef),
          transaction.get(counterRef),
        ]);

        if (existing.exists) {
          throw new DomainError(
            "DOCUMENT_ALREADY_EXISTS",
            "Ya existe un documento con ese identificador. Los documentos son inmutables.",
            409,
          );
        }

        const usedBytes = Number(counter.data()?.usedBytes ?? 0);

        // Autoridad final del presupuesto: se comprueba DENTRO de la
        // transacción, con el contador leído en ella. Dos administradores
        // subiendo a la vez no pueden superar el total: Firestore reintenta
        // una de las dos transacciones y el segundo reintento ve el contador
        // ya incrementado.
        if (usedBytes + input.bytes > input.budgetBytes) {
          throw new DomainError(
            "STORAGE_BUDGET_EXCEEDED",
            "No queda espacio para este documento: el presupuesto de PDF está agotado. Archiva documentos antiguos.",
            507,
          );
        }

        transaction.set(metaRef, {
          documentId: input.meta.documentId,
          courseId: input.meta.courseId,
          // Se escribe el campo nuevo y se conserva el antiguo para que una
          // versión anterior del código siga leyendo lo mismo.
          version: input.meta.version,
          originVersion: input.meta.version,
          topicId: input.meta.topicId,
          title: input.meta.title,
          pageCount: input.meta.pageCount,
          bytes: input.meta.bytes,
          sha256: input.meta.sha256,
          chunkLengths: input.meta.chunkLengths,
          uploadedBy: input.meta.uploadedBy,
          uploadedAt: input.meta.uploadedAt,
          archived: false,
        });

        for (const chunk of input.chunks) {
          transaction.set(chunkRef(input.meta.documentId, chunk.index), {
            documentId: input.meta.documentId,
            index: chunk.index,
            data: Buffer.from(chunk.data),
            sha256OfDocument: input.meta.sha256,
          });
        }

        transaction.set(
          counterRef,
          { usedBytes: usedBytes + input.bytes, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      });
    });
  }

  async archiveDocument(documentId: string): Promise<void> {
    await guard(async () => {
      const db = getAdminDb();
      const metaRef = db.collection(COLLECTIONS.documents).doc(documentId);
      const counterRef = storageCounterRef();

      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(metaRef);
        if (!snapshot.exists) {
          throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
        }
        if (snapshot.data()?.archived === true) return;

        const bytes = Number(snapshot.data()?.bytes ?? 0);
        const counter = await transaction.get(counterRef);
        const usedBytes = Number(counter.data()?.usedBytes ?? 0);

        transaction.update(metaRef, {
          archived: true,
          archivedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(
          counterRef,
          { usedBytes: Math.max(0, usedBytes - bytes), updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      });
    });
  }

  async usageBytes(): Promise<number> {
    return guard(async () => {
      const snapshot = await storageCounterRef().get();
      return Number(snapshot.data()?.usedBytes ?? 0);
    });
  }

  async recomputeUsageBytes(): Promise<number> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.documents)
        .where("archived", "==", false)
        .get();

      return snapshot.docs.reduce((sum, doc) => sum + Number(doc.data().bytes ?? 0), 0);
    });
  }
}
