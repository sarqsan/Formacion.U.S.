import { describe, expect, it } from "vitest";
import {
  deleteCourse,
  type CourseDeletionStore,
  type DeleteCourseInput,
  type DeletableCourse,
} from "@/server/courses/deletion";
import type { CourseVersionStatus } from "@/domain/courses/versioning";
import type { Actor } from "@/domain/auth/authorization";

/**
 * ELIMINAR UN CURSO
 * =================
 *
 * Esta operación destruye datos, así que se prueba al revés que las demás: cada
 * prueba intenta primero lo que **no** debe pasar. Si alguna de estas pruebas
 * falla, alguien puede borrar contenido que personas están cursando.
 */

const ADMIN: Actor = { uid: "admin-1", role: "admin", status: "active" };
const STUDENT: Actor = { uid: "alumno-1", role: "learner", status: "active" };

interface Harness {
  store: CourseDeletionStore;
  deleted: Array<{ courseId: string; versions: number[]; documentIds: string[] }>;
  audits: Array<Record<string, unknown>>;
}

function buildStore(
  options: {
    course?: DeletableCourse | null;
    versions?: Array<{ version: number; status: CourseVersionStatus }>;
    documents?: string[];
    enrollments?: number;
    progress?: number;
    attempts?: number;
    certificates?: number;
  } = {},
): Harness {
  const deleted: Harness["deleted"] = [];
  const audits: Array<Record<string, unknown>> = [];

  const store: CourseDeletionStore = {
    async getCourse() {
      return options.course === undefined
        ? {
            courseId: "curso-prueba",
            title: "Curso de prueba",
            publishedVersion: null,
            lastDraftVersion: 1,
          }
        : options.course;
    },
    async listVersions() {
      return options.versions ?? [{ version: 1, status: "draft" }];
    },
    async listCourseDocumentIds() {
      return options.documents ?? ["doc_abc123"];
    },
    async countEnrollments() {
      return options.enrollments ?? 0;
    },
    async countProgress() {
      return options.progress ?? 0;
    },
    async countAttempts() {
      return options.attempts ?? 0;
    },
    async countCertificates() {
      return options.certificates ?? 0;
    },
    async deleteCourse(input) {
      deleted.push(input);
    },
  };

  return { store, deleted, audits };
}

function deps(harness: Harness) {
  return {
    store: harness.store,
    audit: {
      async record(event: Record<string, unknown> & { type: "course_deleted" }) {
        harness.audits.push(event);
      },
    },
    now: () => new Date("2026-10-25T12:00:00.000Z"),
  } as Parameters<typeof deleteCourse>[1];
}

const INPUT: DeleteCourseInput = {
  actor: ADMIN,
  courseId: "curso-prueba",
  confirmation: "curso-prueba",
};

describe("deleteCourse", () => {
  it("borra un curso en borrador con sus versiones y documentos", async () => {
    const harness = buildStore();
    const result = await deleteCourse(INPUT, deps(harness));

    expect(result).toEqual({ courseId: "curso-prueba", versions: 1, documents: 1 });
    expect(harness.deleted).toHaveLength(1);
    expect(harness.deleted[0]).toEqual({
      courseId: "curso-prueba",
      versions: [1],
      documentIds: ["doc_abc123"],
    });
  });

  it("deja constancia en el registro de actividad", async () => {
    const harness = buildStore();
    await deleteCourse(INPUT, deps(harness));

    expect(harness.audits).toHaveLength(1);
    expect(harness.audits[0]).toMatchObject({
      type: "course_deleted",
      actorUid: "admin-1",
      courseId: "curso-prueba",
      courseTitle: "Curso de prueba",
      versions: 1,
      documents: 1,
      at: "2026-10-25T12:00:00.000Z",
    });
  });

  it("solo lo puede hacer administración", async () => {
    const harness = buildStore();
    await expect(
      deleteCourse({ ...INPUT, actor: STUDENT }, deps(harness)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(harness.deleted).toHaveLength(0);
  });

  it("acepta la confirmación con espacios de más alrededor", async () => {
    const harness = buildStore();
    await expect(
      deleteCourse({ ...INPUT, confirmation: "  curso-prueba  " }, deps(harness)),
    ).resolves.toMatchObject({ courseId: "curso-prueba" });
    expect(harness.deleted).toHaveLength(1);
  });

  it("no borra si la confirmación no es el identificador del curso", async () => {
    const harness = buildStore();
    await expect(
      deleteCourse({ ...INPUT, confirmation: "otro-curso" }, deps(harness)),
    ).rejects.toMatchObject({ code: "COURSE_DELETE_CONFIRMATION", status: 400 });
    expect(harness.deleted).toHaveLength(0);
  });

  it("rechaza un identificador que no es válido", async () => {
    const harness = buildStore();
    await expect(
      deleteCourse({ ...INPUT, courseId: "../otro", confirmation: "../otro" }, deps(harness)),
    ).rejects.toMatchObject({ code: "COURSE_ID_INVALID", status: 400 });
  });

  it("no borra un curso que no existe", async () => {
    const harness = buildStore({ course: null });
    await expect(deleteCourse(INPUT, deps(harness))).rejects.toMatchObject({
      code: "COURSE_NOT_FOUND",
      status: 404,
    });
    expect(harness.deleted).toHaveLength(0);
  });

  it("nunca borra un curso publicado, ni aunque tenga una versión en borrador", async () => {
    const published = buildStore({
      course: {
        courseId: "curso-prueba",
        title: "Curso publicado",
        publishedVersion: 1,
        lastDraftVersion: 2,
      },
      versions: [
        { version: 1, status: "published" },
        { version: 2, status: "draft" },
      ],
    });
    await expect(deleteCourse(INPUT, deps(published))).rejects.toMatchObject({
      code: "COURSE_DELETE_PUBLISHED",
      status: 409,
    });
    expect(published.deleted).toHaveLength(0);

    // Aunque el puntero de publicación se haya perdido, una versión publicada
    // en el historial basta para negarse.
    const archived = buildStore({
      course: {
        courseId: "curso-prueba",
        title: "Curso archivado",
        publishedVersion: null,
        lastDraftVersion: 3,
      },
      versions: [
        { version: 1, status: "archived" },
        { version: 3, status: "draft" },
      ],
    });
    await expect(deleteCourse(INPUT, deps(archived))).rejects.toMatchObject({
      code: "COURSE_DELETE_PUBLISHED",
    });
    expect(archived.deleted).toHaveLength(0);
  });

  it("no borra un curso con personas matriculadas", async () => {
    const harness = buildStore({ enrollments: 1 });
    await expect(deleteCourse(INPUT, deps(harness))).rejects.toMatchObject({
      code: "COURSE_DELETE_ENROLLED",
      status: 409,
    });
    expect(harness.deleted).toHaveLength(0);
  });

  it("no borra un curso con progreso, intentos o certificados", async () => {
    for (const extra of [{ progress: 1 }, { attempts: 1 }, { certificates: 1 }]) {
      const harness = buildStore(extra);
      await expect(deleteCourse(INPUT, deps(harness))).rejects.toMatchObject({
        code: "COURSE_DELETE_IN_USE",
        status: 409,
      });
      expect(harness.deleted).toHaveLength(0);
    }
  });

  it("no toca nada si el almacén falla al borrar", async () => {
    const harness = buildStore();
    const failing: Parameters<typeof deleteCourse>[1] = {
      ...deps(harness),
      store: {
        ...harness.store,
        async deleteCourse() {
          throw new Error("Firestore caído");
        },
      },
    };

    await expect(deleteCourse(INPUT, failing)).rejects.toThrow("Firestore caído");
    // Sin borrado no hay anotación: el registro diría algo que no pasó.
    expect(harness.audits).toHaveLength(0);
  });
});
