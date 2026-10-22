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
 *   borrador, archiva la que estaba publicada y actualiza el puntero del curso
 *   a la vez. Así nunca hay dos versiones `published`.
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
        // Todas las lecturas van antes de la primera escritura (requisito de
        // las transacciones de Firestore).
        const courseDoc = await transaction.get(courseRef);
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

        // La versión publicada anterior pasa a `archived` en la MISMA
        // transacción. Sin esto quedarían dos versiones `published` a la vez:
        // `assertPublishable` lo detecta después como estado inconsistente y la
        // siguiente publicación fallaría con un 500. La demostración y los
        // dobles ya lo hacían así; el adaptador real no, y por eso no se veía.
        const previousVersion =
          (courseDoc.data() as { publishedVersion?: number | null } | undefined)?.publishedVersion ??
          null;
        if (typeof previousVersion === "number" && previousVersion !== input.version) {
          const previousRef = courseRef
            .collection(COLLECTIONS.versions)
            .doc(String(previousVersion));
          const previousDoc = await transaction.get(previousRef);
          if (
            previousDoc.exists &&
            (previousDoc.data() as { status?: string }).status === "published"
          ) {
            transaction.update(previousRef, { status: "archived" });
          }
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
          // Publicar consume el borrador: el puntero no puede quedar apuntando a
          // una versión que ya es inmutable (el editor dejaría de reanudar).
          lastDraftVersion: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    });
  }

  /**
   * Crea el borrador y fija el puntero del curso en la MISMA transacción.
   *
   * Transacción y no lote: hay que **leer** el estado de la ficha y decidir con
   * él (¿cambió?, ¿existe ya la versión?). Un lote escribiría sin mirar y una
   * carrera dejaría dos borradores o un puntero perdido.
   *
   * Coste: 2 lecturas y 2–3 escrituras de documentos pequeños (≤ 800 KiB el de
   * contenido, ~KB el de claves), muy por debajo de los límites de Firestore
   * (10 MiB por transacción; el tope de 500 escrituras ya no existe).
   */
  async createDraftVersion(input: {
    courseId: string;
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument | null;
    expected: { publishedVersion: number | null; lastDraftVersion: number | null };
  }): Promise<{ adopted: boolean }> {
    throwIfLeaking(input.versionDoc);

    return guard(async () => {
      const db = getAdminDb();
      const courseRef = db.collection(COLLECTIONS.courses).doc(input.courseId);
      const versionRef = courseRef
        .collection(COLLECTIONS.versions)
        .doc(String(input.versionDoc.version));
      const keysRef = db
        .collection(COLLECTIONS.answerKeys)
        .doc(answerKeysDocId(input.courseId, input.versionDoc.version, "final"));

      return db.runTransaction(async (transaction) => {
        const [courseDoc, versionDoc] = await Promise.all([
          transaction.get(courseRef),
          transaction.get(versionRef),
        ]);

        if (!courseDoc.exists) {
          throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
        }

        const data = courseDoc.data() as {
          publishedVersion?: number | null;
          lastDraftVersion?: number | null;
        };
        const published = data.publishedVersion ?? null;
        const draft = data.lastDraftVersion ?? null;

        if (
          published !== input.expected.publishedVersion ||
          draft !== input.expected.lastDraftVersion
        ) {
          // Otra operación creó un borrador o publicó. No se escribe NADA: la
          // persona que llama releerá y decidirá (reanudar o reintentar).
          throw new DomainError(
            "DRAFT_CONFLICT",
            "El curso cambió mientras se preparaba el borrador.",
            409,
          );
        }

        if (versionDoc.exists) {
          const status = (versionDoc.data() as { status?: string } | undefined)?.status;
          if (status !== "draft") {
            throw new DomainError(
              "VERSION_ALREADY_EXISTS",
              "Esa versión ya existe y no es un borrador.",
              409,
            );
          }

          // Adopción: la versión ya era un borrador (datos anteriores al
          // puntero). Solo se fija el puntero; no se toca su contenido.
          transaction.update(courseRef, {
            lastDraftVersion: input.versionDoc.version,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return { adopted: true };
        }

        transaction.set(versionRef, {
          ...input.versionDoc,
          revision: input.versionDoc.revision ?? 1,
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (input.answerKeys) {
          transaction.set(keysRef, input.answerKeys);
        }
        transaction.update(courseRef, {
          lastDraftVersion: input.versionDoc.version,
          updatedAt: FieldValue.serverTimestamp(),
        });

        return { adopted: false };
      });
    });
  }

  /**
   * Guarda contenido y claves del borrador en la MISMA transacción.
   *
   * Son dos documentos (la versión, sin respuestas, y el documento de claves).
   * Escribirlos por separado dejaría estados intermedios en los que una
   * pregunta existe sin su respuesta correcta, y al eliminar un tema sus claves
   * quedarían huérfanas. Dentro de la transacción, o se guardan los dos o no se
   * guarda ninguno.
   */
  async replaceDraftContent(input: {
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
    expectedRevision: number;
  }): Promise<void> {
    throwIfLeaking(input.versionDoc);

    await guard(async () => {
      const db = getAdminDb();
      const versionRef = db
        .collection(COLLECTIONS.courses)
        .doc(input.versionDoc.courseId)
        .collection(COLLECTIONS.versions)
        .doc(String(input.versionDoc.version));
      const keysRef = db
        .collection(COLLECTIONS.answerKeys)
        .doc(answerKeysDocId(input.versionDoc.courseId, input.versionDoc.version, "final"));

      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(versionRef);
        if (!current.exists) {
          throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
        }

        const data = current.data() as Partial<CourseVersionDocument>;
        if (data.status !== "draft") {
          throw new DomainError(
            "VERSION_NOT_EDITABLE",
            "Solo se puede editar un borrador. Una versión publicada no se modifica.",
            409,
          );
        }

        const revision = Number(data.revision ?? 0);
        if (revision !== input.expectedRevision) {
          throw new DomainError(
            "DRAFT_STALE",
            "El borrador se ha modificado desde que abriste el editor. Recarga la página antes de guardar.",
            409,
          );
        }

        transaction.set(versionRef, {
          ...input.versionDoc,
          revision: revision + 1,
          // Editar no cambia ni la fecha ni la autoría de la versión.
          createdAt: data.createdAt ?? input.versionDoc.createdAt,
          createdBy: data.createdBy ?? input.versionDoc.createdBy,
          publishedAt: null,
          publishedBy: null,
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Las claves se sustituyen enteras: las de una pregunta eliminada no
        // sobreviven. El servicio conserva el `createdAt` original.
        transaction.set(keysRef, { ...input.answerKeys });
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
