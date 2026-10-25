import { FieldValue } from "firebase-admin/firestore";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { guard } from "@/server/firebase/repositories";
import { getAdminDb } from "@/server/firebase/admin";
import type { CourseVersionStatus } from "@/domain/courses/versioning";
import type {
  CourseDeletionStore,
  DeletableCourse,
} from "@/server/courses/deletion";

/**
 * BORRADO DE CURSOS EN FIRESTORE
 * ==============================
 *
 * Qué toca, en este orden y en lotes de 400 operaciones (el máximo por lote es
 * 500 y hay que dejar sitio):
 *
 *   1. `courses/{id}/versions/{n}`         versiones del curso
 *   2. `answerKeys/{id}_v{n}_*`            claves de corrección (consulta por
 *                                          `courseId`, no por id, para no
 *                                          depender de cómo se llamen)
 *   3. `pdfChunks/{doc}_{n}`               fragmentos de sus PDF
 *   4. `documents/{doc}`                   metadatos de esos PDF
 *   5. `courses/{id}`                      la ficha, **la última**
 *
 * La ficha va la última a propósito: si algo falla antes, el curso sigue
 * existiendo y se puede volver a intentar; al revés quedarían versiones y
 * fragmentos invisibles, imposibles de encontrar desde el panel y ocupando
 * cuota para siempre.
 *
 * Los bytes de los PDF borrados se devuelven al contador `meta/storage`, igual
 * que hace `archiveDocument`: si no, la cuota se iría llenando de documentos que
 * ya no existen.
 *
 * No se ha ejecutado contra Firebase (no hay proyecto conectado en el entorno de
 * desarrollo): está verificado por tipos y por las pruebas del servicio con
 * dobles en memoria.
 */

const BATCH_LIMIT = 400;

export class FirestoreCourseDeletionStore implements CourseDeletionStore {
  async getCourse(courseId: string): Promise<DeletableCourse | null> {
    return guard(async () => {
      const snapshot = await getAdminDb().collection(COLLECTIONS.courses).doc(courseId).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data() as {
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

  async listVersions(
    courseId: string,
  ): Promise<Array<{ version: number; status: CourseVersionStatus }>> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.courses)
        .doc(courseId)
        .collection(COLLECTIONS.versions)
        .get();

      return snapshot.docs
        .map((doc) => {
          const data = doc.data() as { version?: unknown; status?: unknown };
          const number = Number(data.version ?? doc.id);
          const status = data.status;
          return {
            version: Number.isInteger(number) ? number : 0,
            status:
              status === "published" || status === "archived" || status === "draft"
                ? (status as CourseVersionStatus)
                : "draft",
          };
        })
        .filter((version) => version.version > 0)
        .sort((a, b) => a.version - b.version);
    });
  }

  async listCourseDocumentIds(courseId: string): Promise<string[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.documents)
        .where("courseId", "==", courseId)
        .get();
      return snapshot.docs.map((doc) => doc.id);
    });
  }

  /** `true` si hay al menos un documento; no hace falta contarlos todos. */
  private async exists(
    collection: string,
    courseId: string,
  ): Promise<boolean> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(collection)
        .where("courseId", "==", courseId)
        .limit(1)
        .get();
      return !snapshot.empty;
    });
  }

  async countEnrollments(courseId: string): Promise<number> {
    return (await this.exists(COLLECTIONS.enrollments, courseId)) ? 1 : 0;
  }

  async countProgress(courseId: string): Promise<number> {
    return (await this.exists(COLLECTIONS.progress, courseId)) ? 1 : 0;
  }

  async countAttempts(courseId: string): Promise<number> {
    return (await this.exists(COLLECTIONS.attempts, courseId)) ? 1 : 0;
  }

  async countCertificates(courseId: string): Promise<number> {
    return (await this.exists(COLLECTIONS.certificates, courseId)) ? 1 : 0;
  }

  async deleteCourse(input: {
    courseId: string;
    versions: number[];
    documentIds: string[];
  }): Promise<void> {
    await guard(async () => {
      const db = getAdminDb();

      let batch = db.batch();
      let pending = 0;
      const flush = async () => {
        if (pending === 0) return;
        await batch.commit();
        batch = db.batch();
        pending = 0;
      };
      const remove = async (ref: FirebaseFirestore.DocumentReference) => {
        batch.delete(ref);
        pending += 1;
        if (pending >= BATCH_LIMIT) await flush();
      };

      // 1. Versiones.
      for (const version of input.versions) {
        await remove(
          db
            .collection(COLLECTIONS.courses)
            .doc(input.courseId)
            .collection(COLLECTIONS.versions)
            .doc(String(version)),
        );
      }

      // 2. Claves de corrección de esas versiones.
      const keys = await db
        .collection(COLLECTIONS.answerKeys)
        .where("courseId", "==", input.courseId)
        .get();
      for (const doc of keys.docs) await remove(doc.ref);

      // 3. y 4. Fragmentos y metadatos de los documentos del curso.
      let freedBytes = 0;
      for (const documentId of input.documentIds) {
        const metaRef = db.collection(COLLECTIONS.documents).doc(documentId);
        const meta = await metaRef.get();
        const data = meta.data() as { chunkLengths?: unknown; bytes?: unknown } | undefined;
        const lengths = Array.isArray(data?.chunkLengths) ? data?.chunkLengths.length : 0;
        for (let index = 0; index < lengths; index += 1) {
          await remove(db.collection(COLLECTIONS.pdfChunks).doc(`${documentId}_${index}`));
        }
        freedBytes += Number(data?.bytes ?? 0);
        await remove(metaRef);
      }

      // 5. La ficha del curso, al final.
      await remove(db.collection(COLLECTIONS.courses).doc(input.courseId));
      await flush();

      // Devolver los bytes al contador de cuota. Se usa `increment` sobre el
      // valor existente (negativo) en lugar de leer y escribir: así dos borrados
      // simultáneos no se pisan.
      if (freedBytes > 0) {
        await db
          .collection(COLLECTIONS.meta)
          .doc("storage")
          .set(
            {
              usedBytes: FieldValue.increment(-freedBytes),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
      }
    });
  }
}
