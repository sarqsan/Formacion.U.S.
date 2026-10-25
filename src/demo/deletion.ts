import type { CourseVersionStatus } from "@/domain/courses/versioning";
import type { CourseDeletionStore, DeletableCourse } from "@/server/courses/deletion";
import { demoState, type DemoAuditEntry } from "@/demo/store";

/**
 * BORRADO DE CURSOS EN LA DEMOSTRACIÓN
 * ====================================
 *
 * Mismo contrato que el adaptador de Firestore, sobre el estado en memoria.
 * Existe para que la pantalla de eliminar se pueda probar de verdad en la
 * demostración (y en las pruebas automáticas) en lugar de quedar como un botón
 * que solo funciona en producción.
 *
 * Se borra lo mismo que en Firestore: ficha, versiones, claves de corrección y
 * PDF del curso, con sus fragmentos y devolviendo los bytes a la cuota.
 */
export class DemoCourseDeletionStore implements CourseDeletionStore {
  async getCourse(courseId: string): Promise<DeletableCourse | null> {
    const record = demoState().courses.get(courseId);
    if (!record) return null;
    return {
      courseId,
      title: record.summary.title,
      publishedVersion: record.summary.publishedVersion,
      lastDraftVersion: record.summary.lastDraftVersion,
    };
  }

  async listVersions(
    courseId: string,
  ): Promise<Array<{ version: number; status: CourseVersionStatus }>> {
    const record = demoState().courses.get(courseId);
    if (!record) return [];
    return [...record.versions.entries()]
      .map(([version, entry]) => ({ version, status: entry.version.status }))
      .sort((a, b) => a.version - b.version);
  }

  async listCourseDocumentIds(courseId: string): Promise<string[]> {
    const state = demoState();
    return [...state.pdf.metas.values()]
      .filter((meta) => meta.courseId === courseId)
      .map((meta) => meta.documentId);
  }

  async countEnrollments(courseId: string): Promise<number> {
    const state = demoState();
    return [...state.enrollments.values()].some(
      (enrollment) => enrollment.courseId === courseId,
    )
      ? 1
      : 0;
  }

  async countProgress(courseId: string): Promise<number> {
    const state = demoState();
    return [...state.progress.values()].some((entry) => entry.courseId === courseId) ? 1 : 0;
  }

  async countAttempts(courseId: string): Promise<number> {
    return demoState().attempts.some((attempt) => attempt.courseId === courseId) ? 1 : 0;
  }

  async countCertificates(courseId: string): Promise<number> {
    const state = demoState();
    return [...state.certificates.values()].some(
      (certificate) => certificate.courseId === courseId,
    )
      ? 1
      : 0;
  }

  async deleteCourse(input: {
    courseId: string;
    versions: number[];
    documentIds: string[];
  }): Promise<void> {
    const state = demoState();

    state.courses.delete(input.courseId);

    // PDF: fragmentos, metadatos y cuota, igual que al archivar un documento.
    for (const documentId of input.documentIds) {
      const meta = state.pdf.metas.get(documentId);
      if (meta) {
        for (let index = 0; index < meta.chunkLengths.length; index += 1) {
          state.pdf.chunks.delete(`${documentId}_${index}`);
        }
        state.pdf.usedBytes = Math.max(0, state.pdf.usedBytes - meta.bytes);
      }
      state.pdf.metas.delete(documentId);
    }
  }
}

/** Registro de actividad: la demostración guarda lo mismo que `audits`. */
export class DemoDeletionAudit {
  async record(event: {
    type: "course_deleted";
    actorUid: string;
    at: string;
    courseId: string;
    courseTitle: string;
    versions: number;
    documents: number;
  }): Promise<void> {
    const entry: DemoAuditEntry = {
      type: event.type,
      actorUid: event.actorUid,
      targetUid: event.actorUid,
      at: event.at,
      courseId: event.courseId,
      courseTitle: event.courseTitle,
      versions: event.versions,
      documents: event.documents,
    };
    demoState().audits.unshift(entry);
  }
}
