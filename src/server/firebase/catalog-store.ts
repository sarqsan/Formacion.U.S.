import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import type { CourseVersionStatus, CourseVersionSummary } from "@/domain/courses/versioning";
import {
  answerKeysDocId,
  COLLECTIONS,
  validateAttemptDocument,
  validateProgressDocument,
  versionPath,
} from "@/server/db/schema";
import type {
  AnswerKeysDocument,
  CourseCatalogStore,
  CourseSummary,
  CourseVersionDocument,
  PublicDocument,
} from "@/server/courses/catalog";
import { getAdminDb } from "@/server/firebase/admin";

/**
 * IMPLEMENTACIÓN FIRESTORE DEL CATÁLOGO
 * =====================================
 *
 * Escrituras:
 * - `saveVersion` usa un lote: documento de versión + claves + ficha del curso
 *   (si es la primera). Las claves nunca acaban dentro de la versión.
 * - `publishVersion` usa una transacción: comprueba que la versión sigue en
 *   borrador y actualiza el puntero del curso a la vez.
 *
 * Lecturas: las que usan los servicios y el panel de administración, cada una
 * respaldada por un índice en `firestore.indexes.json`.
 *
 * No se ha ejecutado contra Firebase (no hay proyecto conectado); está
 * verificado por tipos y por las pruebas de servicio con dobles en memoria.
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

export class FirestoreCourseCatalogStore implements CourseCatalogStore {
  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return guard(async () => {
      const doc = await getAdminDb().collection(COLLECTIONS.courses).doc(courseId).get();
      if (!doc.exists) return null;
      const data = doc.data() as {
        title?: string;
        publishedVersion?: number | null;
        lastDraftVersion?: number | null;
      };
      return {
        courseId,
        title: data.title ?? courseId,
        publishedVersion: data.publishedVersion ?? null,
        lastDraftVersion: data.lastDraftVersion ?? null,
      };
    });
  }

  async listVersions(courseId: string): Promise<CourseVersionSummary[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.courses)
        .doc(courseId)
        .collection(COLLECTIONS.versions)
        .select("version", "status")
        .orderBy("version", "asc")
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data() as { version?: number; status?: CourseVersionStatus };
        return {
          version: data.version ?? Number(doc.id),
          status: (data.status ?? "draft") as CourseVersionStatus,
        };
      });
    });
  }

  async getVersion(courseId: string, version: number): Promise<CourseVersionDocument | null> {
    return guard(async () => {
      const doc = await getAdminDb().doc(versionPath(courseId, version)).get();
      if (!doc.exists) return null;
      return { ...(doc.data() as Omit<CourseVersionDocument, "courseId" | "version">), courseId, version };
    });
  }

  async getAnswerKeys(courseId: string, version: number): Promise<AnswerKeysDocument | null> {
    return guard(async () => {
      const doc = await getAdminDb()
        .collection(COLLECTIONS.answerKeys)
        .doc(answerKeysDocId(courseId, version, "final"))
        .get();
      if (doc.exists) return doc.data() as AnswerKeysDocument;

      // Compatibilidad: si se guardaron por evaluación, se reúnen aquí.
      const all = await getAdminDb()
        .collection(COLLECTIONS.answerKeys)
        .where("courseId", "==", courseId)
        .where("version", "==", version)
        .get();

      if (all.empty) return null;

      const merged: AnswerKeysDocument = {
        courseId,
        version,
        quizByTopic: {},
        finalExam: [],
        createdAt: new Date().toISOString(),
      };
      for (const entry of all.docs) {
        const data = entry.data() as AnswerKeysDocument;
        Object.assign(merged.quizByTopic, data.quizByTopic ?? {});
        if (data.finalExam?.length) merged.finalExam = data.finalExam;
      }
      return merged;
    });
  }

  async saveVersion(input: {
    course: CourseSummary;
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    return guard(async () => {
      const db = getAdminDb();
      const courseRef = db.collection(COLLECTIONS.courses).doc(input.course.courseId);
      const versionRef = courseRef.collection(COLLECTIONS.versions).doc(String(input.version.version));
      const keysRef = db
        .collection(COLLECTIONS.answerKeys)
        .doc(answerKeysDocId(input.version.courseId, input.version.version, "final"));

      throwIfLeaking(input.version);

      await db.runTransaction(async (transaction) => {
        const versionDoc = await transaction.get(versionRef);
        if (versionDoc.exists) {
          throw new DomainError(
            "VERSION_ALREADY_EXISTS",
            "Esa versión ya existe. Las versiones son inmutables.",
            409,
          );
        }

        const courseDoc = await transaction.get(courseRef);
        if (courseDoc.exists) {
          // `publishedVersion` NO se toca aquí: publicar es otra operación. Solo
          // se actualiza la ficha de autoría y el puntero del último borrador.
          transaction.update(courseRef, {
            title: input.course.title,
            lastDraftVersion: input.course.lastDraftVersion,
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          // Alta implícita (compatibilidad): un curso sin ficha que guarda su
          // primera versión. La creación explícita vive en el editor de cursos.
          transaction.set(courseRef, {
            courseId: input.course.courseId,
            title: input.course.title,
            publishedVersion: null,
            lastDraftVersion: input.course.lastDraftVersion,
            createdBy: input.version.createdBy,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        transaction.set(versionRef, { ...input.version, updatedAt: FieldValue.serverTimestamp() });
        transaction.set(keysRef, input.answerKeys);
      });
    });
  }

  async replaceDraftVersion(input: {
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    return guard(async () => {
      const db = getAdminDb();
      const courseRef = db.collection(COLLECTIONS.courses).doc(input.version.courseId);
      const versionRef = courseRef
        .collection(COLLECTIONS.versions)
        .doc(String(input.version.version));
      const keysRef = db
        .collection(COLLECTIONS.answerKeys)
        .doc(answerKeysDocId(input.version.courseId, input.version.version, "final"));

      throwIfLeaking(input.version);

      await db.runTransaction(async (transaction) => {
        const versionDoc = await transaction.get(versionRef);
        if (!versionDoc.exists) {
          throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
        }
        const current = versionDoc.data() as Partial<CourseVersionDocument>;
        if (current.status !== "draft") {
          throw new DomainError(
            "VERSION_NOT_EDITABLE",
            "Una versión publicada no se puede editar: crea una versión nueva.",
            409,
          );
        }

        // Se conserva la fecha de creación original: editar no crea la versión.
        transaction.set(versionRef, {
          ...input.version,
          createdAt: current.createdAt ?? input.version.createdAt,
          publishedAt: null,
          publishedBy: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(keysRef, input.answerKeys);
      });
    });
  }

  async publishVersion(input: {
    courseId: string;
    version: number;
    publishedAt: string;
    publishedBy: string;
  }): Promise<void> {
    return guard(async () => {
      const db = getAdminDb();
      const courseRef = db.collection(COLLECTIONS.courses).doc(input.courseId);
      const versionRef = courseRef.collection(COLLECTIONS.versions).doc(String(input.version));

      await db.runTransaction(async (transaction) => {
        const versionDoc = await transaction.get(versionRef);
        if (!versionDoc.exists) {
          throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
        }

        const status = (versionDoc.data() as { status?: string }).status;
        if (status !== "draft") {
          throw new DomainError(
            "VERSION_NOT_DRAFT",
            "Solo se puede publicar una versión en borrador.",
            409,
          );
        }

        // La versión pasa a publicada y el curso apunta a ella en la misma
        // transacción: no puede quedar un curso apuntando a algo no publicado.
        transaction.update(versionRef, {
          status: "published",
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        });
        transaction.update(courseRef, {
          publishedVersion: input.version,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    });
  }

  async listDocuments(
    courseId: string,
    version: number,
    topicId: string,
  ): Promise<PublicDocument[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.documents)
        .where("courseId", "==", courseId)
        .where("version", "==", version)
        .where("topicId", "==", topicId)
        .get();

      return snapshot.docs.map((doc) => {
        // Los metadatos no incluyen el binario ni ninguna ruta: el PDF se
        // sirve por el endpoint de ventanas, nunca por enlace directo.
        const data = doc.data() as { title?: string; pageCount?: number };
        return {
          id: doc.id,
          title: data.title ?? doc.id,
          pageCount: Number(data.pageCount ?? 0),
        };
      });
    });
  }
}

/** Cortafuegos: el documento público no puede contener claves. */
function throwIfLeaking(version: CourseVersionDocument): void {
  if (JSON.stringify(version).includes("correctOptionIds")) {
    throw new DomainError(
      "CONTENT_LEAK",
      "El contenido público contiene respuestas correctas. Escritura abortada.",
      500,
    );
  }
}

/**
 * Validaciones de esquema reutilizables por los scripts de comprobación.
 * Se exportan aquí para no duplicar las reglas de forma entre módulos.
 */
export const schemaValidators = {
  validateAttemptDocument,
  validateProgressDocument,
} as const;
