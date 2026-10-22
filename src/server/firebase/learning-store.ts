import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import {
  COLLECTIONS,
  progressDocId,
  progressHistoryDocId,
  validateAttemptDocument,
  validateProgressDocument,
  validateProgressHistoryDocument,
} from "@/server/db/schema";
import type {
  ArchivedProgress,
  AttemptRecord,
  LearningStore,
  StoredProgress,
} from "@/server/learning/store";
import { getAdminDb } from "@/server/firebase/admin";

/**
 * IMPLEMENTACIÓN FIRESTORE DE PROGRESO E INTENTOS
 * ===============================================
 *
 * `commitAttempt` es una transacción que escribe, o no escribe, todo:
 *   1. el intento (registro inmutable de lo que se contestó y cómo se corrigió);
 *   2. el progreso actualizado;
 *   3. si cambió la versión publicada, el progreso anterior en el histórico.
 *
 * Así no puede existir un intento aprobado sin su progreso, ni un progreso
 * actualizado sin la prueba de qué lo justificó.
 */

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "FIREBASE_UNAVAILABLE",
      "El servicio de datos no está disponible en este momento. Inténtalo más tarde.",
      503,
    );
  }
}

function serializeProgress(progress: StoredProgress): Record<string, unknown> {
  validateProgressDocument(progress as unknown as Record<string, unknown>);
  return {
    uid: progress.uid,
    courseId: progress.courseId,
    version: progress.version,
    mandatoryTopicIds: progress.mandatoryTopicIds,
    topics: progress.topics,
    documents: progress.documents,
    finalExam: progress.finalExam,
    completedAt: progress.completedAt,
    updatedAt: progress.updatedAt,
  };
}

/**
 * Registro del histórico.
 *
 * `archivedAt` va como **cadena ISO**, igual que el resto de fechas del
 * esquema. La variante con `serverTimestamp()` que usaba `saveProgress` queda
 * descartada: obligaba a que cada lector normalizara el tipo y hacía que la
 * misma colección guardara dos representaciones de la misma fecha.
 */
function serializeArchivedProgress(
  archive: StoredProgress,
  archivedAt: string,
): Record<string, unknown> {
  const record = { ...serializeProgress(archive), archivedAt };
  validateProgressHistoryDocument(record as unknown as Record<string, unknown>);
  return record;
}

function serializeAttempt(attempt: AttemptRecord): Record<string, unknown> {
  validateAttemptDocument(attempt as unknown as Record<string, unknown>);
  return { ...attempt };
}

/** Fecha de Firestore o cadena → ISO. Devuelve `null` si no se puede leer. */
function toIsoString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toDate" in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date ? date.toISOString() : null;
  }
  return null;
}

/** `progressHistory/{uid}_{courseId}_v{n}` → `courseId`. */
function courseIdFromHistoryId(documentId: string, uid: string): string {
  const value = documentId.slice(`${uid}_`.length);
  const separator = value.lastIndexOf("_v");
  return separator === -1 ? value : value.slice(0, separator);
}

export class FirestoreLearningStore implements LearningStore {
  async getProgress(uid: string, courseId: string): Promise<StoredProgress | null> {
    return guard(async () => {
      const doc = await getAdminDb()
        .collection(COLLECTIONS.progress)
        .doc(progressDocId(uid, courseId))
        .get();
      if (!doc.exists) return null;
      const data = doc.data() as Omit<StoredProgress, "uid" | "courseId">;
      return { ...(data as StoredProgress), uid, courseId };
    });
  }

  async commitAttempt(input: {
    attempt: AttemptRecord;
    progress: StoredProgress;
    archive: StoredProgress | null;
  }): Promise<void> {
    return guard(async () => {
      const db = getAdminDb();
      const progressRef = db
        .collection(COLLECTIONS.progress)
        .doc(progressDocId(input.progress.uid, input.progress.courseId));
      const attemptRef = db.collection(COLLECTIONS.attempts).doc();

      await db.runTransaction(async (transaction) => {
        if (input.archive) {
          transaction.set(
            db
              .collection(COLLECTIONS.progressHistory)
              .doc(
                progressHistoryDocId(input.archive.uid, input.archive.courseId, input.archive.version),
              ),
            serializeArchivedProgress(input.archive, input.progress.updatedAt),
            { merge: true },
          );
        }

        transaction.set(attemptRef, {
          ...serializeAttempt(input.attempt),
          createdAt: FieldValue.serverTimestamp(),
        });

        transaction.set(progressRef, {
          ...serializeProgress(input.progress),
          serverUpdatedAt: FieldValue.serverTimestamp(),
        });
      });
    });
  }

  async saveProgress(
    progress: StoredProgress,
    archive: StoredProgress | null = null,
  ): Promise<void> {
    return guard(async () => {
      const db = getAdminDb();
      const progressRef = db
        .collection(COLLECTIONS.progress)
        .doc(progressDocId(progress.uid, progress.courseId));

      // Sin versión anterior que archivar, basta un `set` idempotente.
      if (!archive) {
        await progressRef.set(
          {
            ...serializeProgress(progress),
            serverUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return;
      }

      // Con archivo, las dos escrituras van en una transacción: no puede
      // quedar el histórico sin el progreso nuevo (ni al revés).
      const archiveRef = db
        .collection(COLLECTIONS.progressHistory)
        .doc(progressHistoryDocId(archive.uid, archive.courseId, archive.version));

      await db.runTransaction(async (transaction) => {
        transaction.set(archiveRef, serializeArchivedProgress(archive, progress.updatedAt));
        transaction.set(progressRef, {
          ...serializeProgress(progress),
          serverUpdatedAt: FieldValue.serverTimestamp(),
        });
      });
    });
  }

  async listProgressByCourse(
    courseId: string,
    version: number,
  ): Promise<Array<Pick<StoredProgress, "uid" | "completedAt" | "version">>> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.progress)
        .where("courseId", "==", courseId)
        .where("version", "==", version)
        .orderBy("completedAt", "desc")
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data() as { uid: string; completedAt: string | null; version: number };
        return { uid: data.uid, completedAt: data.completedAt, version: data.version };
      });
    });
  }

  async listProgressByUser(uid: string): Promise<StoredProgress[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.progress)
        .where("uid", "==", uid)
        .orderBy("updatedAt", "desc")
        .get();

      return snapshot.docs.map((doc) => doc.data() as StoredProgress);
    });
  }

  /**
   * Histórico de versiones anteriores.
   *
   * Se filtra **solo por `uid`** (campo único, índice automático) y se ordena en
   * memoria con `sortHistory`. Un `orderBy("archivedAt")` habría exigido un
   * índice compuesto nuevo, y publicar índices es una operación reservada para
   * la sesión de Firebase.
   *
   * `archivedAt` se escribe con `serverTimestamp()`: al leerlo llega como
   * `Timestamp`, no como cadena. Se normaliza aquí para que el resto del código
   * no tenga que saberlo (ni la demostración se comporte distinto).
   */
  async listArchivedProgress(uid: string): Promise<ArchivedProgress[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.progressHistory)
        .where("uid", "==", uid)
        .limit(200)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data() as ArchivedProgress & {
          archivedAt?: unknown;
          completedAt?: string | null;
        };
        return {
          ...data,
          uid,
          // `courseId` puede faltar en documentos antiguos: se deduce del id,
          // que es `{uid}_{courseId}_v{n}`.
          courseId: data.courseId ?? courseIdFromHistoryId(doc.id, uid),
          archivedAt: toIsoString(data.archivedAt),
        } as ArchivedProgress;
      });
    });
  }

  async listAttemptsByUser(uid: string): Promise<AttemptRecord[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.attempts)
        .where("uid", "==", uid)
        .orderBy("at", "desc")
        .limit(200)
        .get();
      return snapshot.docs.map((doc) => doc.data() as AttemptRecord);
    });
  }

  async listAttemptsByCourse(courseId: string, version: number): Promise<AttemptRecord[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.attempts)
        .where("courseId", "==", courseId)
        .where("version", "==", version)
        .orderBy("at", "desc")
        .limit(500)
        .get();
      return snapshot.docs.map((doc) => doc.data() as AttemptRecord);
    });
  }
}
