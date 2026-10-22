import { beforeEach, describe, expect, it } from "vitest";
import { createCourse } from "@/server/courses/editor";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCourseEditorStore,
  LEARNER,
  PENDING,
} from "../helpers/db-doubles";
import { adminCreateCourse, adminCourses } from "@/demo/service";
import { listVersionsOf, resetDemoState } from "@/demo/store";

/**
 * ALTA DE CURSOS
 * ==============
 *
 * Lo que se comprueba, y por qué importa:
 *   · un curso recién creado **no** tiene versión publicada ni borrador;
 *   · crear no sobrescribe un curso existente (perdería su historial);
 *   · solo un administrador activo puede crear;
 *   · la demostración enseña exactamente el mismo estado inicial.
 *
 * Son pruebas con dobles y con el almacén en memoria: **no** demuestran que
 * Firestore escriba nada. Eso sigue sin verificarse en este entorno.
 */

function setup() {
  const store = new InMemoryCourseEditorStore();
  return { store, deps: { store, now: () => FIXED_NOW } };
}

describe("createCourse", () => {
  it("crea el curso sin versión publicada y sin borrador", async () => {
    const { store, deps } = setup();

    const result = await createCourse(
      { actor: ADMIN, courseId: "curso-nuevo", title: "Curso nuevo" },
      deps,
    );

    expect(result).toEqual({
      courseId: "curso-nuevo",
      title: "Curso nuevo",
      publishedVersion: null,
      lastDraftVersion: null,
    });

    const stored = await store.getCourse("curso-nuevo");
    expect(stored).toEqual({
      courseId: "curso-nuevo",
      title: "Curso nuevo",
      publishedVersion: null,
      lastDraftVersion: null,
    });
    // Un único alta, sin ninguna versión asociada.
    expect(store.createCalls).toBe(1);
    expect(store.created).toEqual([
      {
        courseId: "curso-nuevo",
        createdAt: FIXED_NOW.toISOString(),
        createdBy: ADMIN.uid,
      },
    ]);
  });

  it("no exige contenido: no hay temas ni examen y aun así se crea", async () => {
    const { store, deps } = setup();

    await createCourse({ actor: ADMIN, courseId: "curso-vacio", title: "Vacío" }, deps);

    // El curso existe; que no tenga contenido no es un error, es el estado
    // inicial. La validación completa se exigirá al publicar, no al crear.
    expect(await store.getCourse("curso-vacio")).not.toBeNull();
  });

  it("acepta la plantilla vacía de forma explícita", async () => {
    const { deps } = setup();

    await expect(
      createCourse(
        { actor: ADMIN, courseId: "curso-a", title: "Curso A", template: "empty" },
        deps,
      ),
    ).resolves.toMatchObject({ publishedVersion: null });
  });

  it("rechaza una plantilla desconocida sin escribir nada", async () => {
    const { store, deps } = setup();

    await expect(
      // @ts-expect-error: se simula una plantilla que no existe en el tipo.
      createCourse({ actor: ADMIN, courseId: "curso-a", title: "Curso A", template: "excel" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_TEMPLATE_UNKNOWN" });

    expect(store.createCalls).toBe(0);
  });

  it("no sobrescribe un curso existente", async () => {
    const { store, deps } = setup();
    await createCourse({ actor: ADMIN, courseId: "curso-a", title: "Original" }, deps);

    await expect(
      createCourse({ actor: ADMIN, courseId: "curso-a", title: "Suplantado" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_ALREADY_EXISTS", status: 409 });

    expect((await store.getCourse("curso-a"))?.title).toBe("Original");
  });

  it("exige administrador activo", async () => {
    const { store, deps } = setup();

    await expect(
      createCourse({ actor: LEARNER, courseId: "curso-a", title: "Curso A" }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      createCourse({ actor: PENDING, courseId: "curso-a", title: "Curso A" }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });

    // @ts-expect-error: sin sesión.
    await expect(createCourse({ courseId: "curso-a", title: "Curso A" }, deps)).rejects.toMatchObject(
      { code: "UNAUTHENTICATED" },
    );

    expect(store.createCalls).toBe(0);
  });

  it("rechaza identificadores y títulos inválidos antes de escribir", async () => {
    const { store, deps } = setup();

    await expect(
      createCourse({ actor: ADMIN, courseId: "Curso A", title: "Curso A" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_ID_INVALID" });

    await expect(
      createCourse({ actor: ADMIN, courseId: "curso-a", title: "  " }, deps),
    ).rejects.toMatchObject({ code: "COURSE_TITLE_REQUIRED" });

    expect(store.createCalls).toBe(0);
  });

  it("no crea ninguna versión fantasma", async () => {
    const { store, deps } = setup();
    await createCourse({ actor: ADMIN, courseId: "curso-a", title: "Curso A" }, deps);

    // El doble de creación ni siquiera tiene una operación para guardar
    // versiones: si el servicio intentara crearla, no compilaría.
    expect(store.courses.size).toBe(1);
    expect((await store.getCourse("curso-a"))?.lastDraftVersion).toBeNull();
  });
});

describe("creación en modo demostración", () => {
  const DEMO_ADMIN = { uid: "demo-admin", role: "admin", status: "active" } as const;

  beforeEach(() => {
    resetDemoState();
  });

  it("deja el curso en el mismo estado inicial que en modo real", async () => {
    const before = adminCourses().length;

    const created = await adminCreateCourse(DEMO_ADMIN, {
      courseId: "curso-nuevo-demo",
      title: "Curso nuevo de la demo",
    });

    expect(created).toEqual({
      courseId: "curso-nuevo-demo",
      title: "Curso nuevo de la demo",
      publishedVersion: null,
      lastDraftVersion: null,
    });

    expect(adminCourses()).toHaveLength(before + 1);

    const row = adminCourses().find((course) => course.courseId === "curso-nuevo-demo");
    expect(row).toMatchObject({
      publishedVersion: null,
      lastDraftVersion: null,
      versions: [],
      drafts: 0,
    });

    // Sin versiones: nada que publicar y nada que el alumnado pueda ver.
    expect(listVersionsOf("curso-nuevo-demo")).toEqual([]);
  });

  it("no altera los cursos que ya estaban sembrados", async () => {
    const before = adminCourses();

    await adminCreateCourse(DEMO_ADMIN, { courseId: "curso-nuevo-demo", title: "Nuevo" });

    const after = adminCourses().filter((course) => course.courseId !== "curso-nuevo-demo");
    expect(after).toEqual(before);
  });

  it("rechaza un identificador repetido sin tocar el curso existente", async () => {
    const existing = adminCourses()[0];

    await expect(
      adminCreateCourse(DEMO_ADMIN, { courseId: existing.courseId, title: "Suplantado" }),
    ).rejects.toMatchObject({ code: "COURSE_ALREADY_EXISTS" });

    const after = adminCourses().find((course) => course.courseId === existing.courseId);
    expect(after).toEqual(existing);
  });

  it("rechaza a un alumno aunque esté activo", async () => {
    const learner = { uid: "demo-alumno-1", role: "learner", status: "active" } as const;

    await expect(
      adminCreateCourse(learner, { courseId: "curso-nuevo-demo", title: "Nuevo" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
