import { DomainError } from "@/domain/text";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { validateCourseDocument } from "@/server/db/schema";
import type { CourseSummary } from "@/server/courses/catalog";
import type { CourseEditorStore } from "@/server/courses/editor";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";

/**
 * ESCRITURA DE CURSOS EN FIRESTORE
 * ================================
 *
 *   courses/{courseId}  ficha del curso: título, puntero de publicación y
 *                       última versión de borrador.
 *
 * Crear es **una sola escritura** (`create`, no `set`): atómica por sí misma y
 * sin posibilidad de sobrescribir un curso existente. Una segunda petición
 * concurrente recibe `COURSE_ALREADY_EXISTS` en lugar de reemplazar el curso.
 *
 * No se ha ejecutado contra Firebase: el adaptador está verificado por tipos y
 * por las pruebas de servicio con dobles en memoria.
 */

/** Código gRPC de "el documento ya existe". */
function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 6 || code === "6" || code === "already-exists") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ALREADY_EXISTS|already exists/i.test(message);
}

export class FirestoreCourseEditorStore implements CourseEditorStore {
  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.courses)
        .doc(courseId)
        .get();
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

  async createCourse(
    summary: CourseSummary & { createdAt: string; createdBy: string },
  ): Promise<void> {
    const document = {
      courseId: summary.courseId,
      title: summary.title,
      publishedVersion: null,
      lastDraftVersion: null,
      createdAt: summary.createdAt,
      createdBy: summary.createdBy,
      updatedAt: summary.createdAt,
    };

    // Se valida antes de escribir: un error de programación no debe dejar una
    // ficha que las reglas o el panel interpreten mal.
    validateCourseDocument(document);

    await guard(async () => {
      try {
        // `create` falla si el documento existe. `set` lo habría sobrescrito.
        await getAdminDb().collection(COLLECTIONS.courses).doc(summary.courseId).create(document);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new DomainError(
            "COURSE_ALREADY_EXISTS",
            "Ya existe un curso con ese identificador. Elige otro.",
            409,
          );
        }
        throw error;
      }
    });
  }
}
