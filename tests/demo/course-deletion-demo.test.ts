import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import { adminCreateCourse, adminDeleteCourse } from "@/demo/service";
import { demoState, resetDemoState } from "@/demo/store";

/**
 * ELIMINAR UN CURSO — CABLEADO DE LA DEMOSTRACIÓN
 * ===============================================
 *
 * El servicio ya se prueba aparte; esto comprueba lo que puede fallar en el
 * cableado: que el curso desaparezca de verdad del almacén, que se pueda crear
 * y borrar seguido, y que un curso publicado del catálogo de ejemplo no se
 * borre ni aunque el campo de confirmación esté bien escrito.
 */

const ADMIN: Actor = { uid: "demo-admin", role: "admin", status: "active" };

beforeEach(() => {
  resetDemoState();
});

describe("adminDeleteCourse (demostración)", () => {
  it("crea un curso y lo borra dejando el almacén limpio", async () => {
    const created = await adminCreateCourse(ADMIN, {
      courseId: "curso-prueba-borrado",
      title: "Prueba de borrado",
    });

    expect(demoState().courses.has(created.courseId)).toBe(true);

    const result = await adminDeleteCourse(ADMIN, {
      courseId: created.courseId,
      confirmation: created.courseId,
    });

    expect(result).toEqual({ courseId: "curso-prueba-borrado", versions: 0, documents: 0 });
    expect(demoState().courses.has("curso-prueba-borrado")).toBe(false);
    expect(demoState().audits[0]).toMatchObject({
      type: "course_deleted",
      courseId: "curso-prueba-borrado",
    });
  });

  it("no borra un curso publicado del catálogo de ejemplo", async () => {
    await expect(
      adminDeleteCourse(ADMIN, {
        courseId: "curso-prevencion-riesgos",
        confirmation: "curso-prevencion-riesgos",
      }),
    ).rejects.toMatchObject({ code: "COURSE_DELETE_PUBLISHED" });

    expect(demoState().courses.has("curso-prevencion-riesgos")).toBe(true);
  });

  it("no borra con la confirmación mal escrita", async () => {
    await adminCreateCourse(ADMIN, { courseId: "curso-prueba-2", title: "Otra prueba" });

    await expect(
      adminDeleteCourse(ADMIN, { courseId: "curso-prueba-2", confirmation: "sí" }),
    ).rejects.toMatchObject({ code: "COURSE_DELETE_CONFIRMATION" });

    expect(demoState().courses.has("curso-prueba-2")).toBe(true);
  });
});
