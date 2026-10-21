import { describe, expect, it } from "vitest";
import {
  assertCourseAccess,
  enrollStudent,
  hasCourseAccess,
  revokeEnrollment,
} from "@/server/enrollments/service";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  PENDING,
  makeDefinition,
} from "../helpers/db-doubles";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * MATRÍCULAS: servicio
 * ====================
 *
 * Lo que se comprueba aquí es la barrera que la Fase 5 no tenía: pertenecer a
 * la aplicación (cuenta activa) ya no basta para leer el contenido de un curso.
 * Hace falta una matrícula activa y que el curso esté publicado.
 *
 * Los almacenes son dobles en memoria con las mismas invariantes que los
 * adaptadores de Firestore; las reglas de Firestore se prueban aparte
 * (`tests/rules/`, pendientes de emulador).
 */

function setup(options: { published?: boolean } = {}) {
  const catalog = new InMemoryCatalogStore();
  const enrollments = new InMemoryEnrollmentStore();

  catalog.seedPublished(makeDefinition());
  if (options.published === false) {
    catalog.courses.set("curso-a", { ...catalog.courses.get("curso-a")!, publishedVersion: null });
  }

  const deps = { catalog, enrollments, now: () => FIXED_NOW };
  return { catalog, enrollments, deps };
}

describe("acceso a un curso", () => {
  it("el alumno matriculado entra", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a");

    await expect(assertCourseAccess(LEARNER, "curso-a", deps)).resolves.toBeUndefined();
    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(true);
  });

  it("estar publicado NO da acceso: sin matrícula se deniega", async () => {
    const { deps } = setup();

    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(false);
    await expect(assertCourseAccess(LEARNER, "curso-a", deps)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
      status: 403,
    });
  });

  it("una matrícula revocada no da acceso", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a", "revoked");

    await expect(assertCourseAccess(LEARNER, "curso-a", deps)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
  });

  it("la matrícula de otro alumno no sirve", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed("otro-uid-00001", "curso-a");

    await expect(assertCourseAccess(LEARNER, "curso-a", deps)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
  });

  it("la matrícula en un curso no abre otro curso", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a");

    await expect(assertCourseAccess(LEARNER, "curso-b", deps)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
  });

  it("un curso no publicado no es accesible aunque haya matrícula", async () => {
    const { deps, enrollments } = setup({ published: false });
    enrollments.seed(LEARNER.uid, "curso-a");

    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(false);
  });

  it("una cuenta pendiente de activación no accede aunque tenga matrícula", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(PENDING.uid, "curso-a");

    // La sesión ya rechaza estas cuentas, pero el servicio no se fía: un actor
    // no activo se deniega aquí también.
    await expect(hasCourseAccess(PENDING, "curso-a", deps)).resolves.toBe(false);
    await expect(assertCourseAccess(PENDING, "curso-a", deps)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
  });

  it("el administrador entra sin matrícula (gestiona el contenido)", async () => {
    const { deps } = setup();
    await expect(hasCourseAccess(ADMIN, "curso-a", deps)).resolves.toBe(true);

    // Ojo: para el administrador esto no comprueba que el curso exista (eso lo
    // hace la lectura del documento). Simplemente no exige matrícula.
    await expect(hasCourseAccess(ADMIN, "curso-inexistente", deps)).resolves.toBe(true);
  });

  it("el mensaje de denegación no revela si el curso existe", async () => {
    const { deps } = setup();
    const messages: string[] = [];

    for (const courseId of ["curso-a", "no-existe"]) {
      try {
        await assertCourseAccess(LEARNER, courseId, deps);
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0].toLowerCase()).not.toContain("existe");
  });
});

describe("matricular", () => {
  it("solo un administrador puede matricular", async () => {
    const { deps, enrollments } = setup();

    await expect(
      enrollStudent({ actor: LEARNER, uid: LEARNER.uid, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Una cuenta pendiente de activación ni siquiera llega a la comprobación
    // de rol: se rechaza antes, con 403 igualmente.
    await expect(
      enrollStudent({ actor: PENDING, uid: PENDING.uid, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ status: 403 });

    expect(enrollments.writes).toBe(0);
  });

  it("el rol no se puede tomar del cuerpo de la petición", async () => {
    const { deps } = setup();
    const sneaky = {
      actor: { ...LEARNER, role: "learner" },
      uid: LEARNER.uid,
      courseId: "curso-a",
      role: "admin",
      isAdmin: true,
    } as unknown as Parameters<typeof enrollStudent>[0];

    await expect(enrollStudent(sneaky, deps)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("crea la matrícula con la versión publicada y el autor real", async () => {
    const { deps, enrollments } = setup();

    const enrollment = await enrollStudent(
      { actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" },
      deps,
    );

    expect(enrollment).toMatchObject({
      uid: LEARNER.uid,
      courseId: "curso-a",
      status: "active",
      version: 1,
      enrolledBy: ADMIN.uid,
      enrolledAt: FIXED_NOW.toISOString(),
    });
    await expect(enrollments.get(LEARNER.uid, "curso-a")).resolves.toMatchObject({
      status: "active",
    });
    // Y a partir de aquí el alumno sí accede.
    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(true);
  });

  it("es idempotente: matricular dos veces conserva la fecha original", async () => {
    const { deps, enrollments } = setup();
    const first = await enrollStudent(
      { actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" },
      deps,
    );

    let later = FIXED_NOW.getTime() + 86_400_000;
    const secondDeps = { ...deps, now: () => new Date(later) };
    const second = await enrollStudent(
      { actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" },
      secondDeps,
    );

    expect(second.enrolledAt).toBe(first.enrolledAt);
    expect(second.updatedAt).toBe(new Date(later).toISOString());
    expect(await enrollments.listByUser(LEARNER.uid)).toHaveLength(1);
    later = 0;
  });

  it("reactiva una matrícula revocada sin perder el progreso", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a", "revoked");
    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(false);

    await enrollStudent({ actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" }, deps);

    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(true);
  });

  it("no matricula en un curso inexistente", async () => {
    const { deps, enrollments } = setup();

    await expect(
      enrollStudent({ actor: ADMIN, uid: LEARNER.uid, courseId: "curso-fantasma" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_FOUND", status: 404 });
    expect(enrollments.writes).toBe(0);
  });

  it("rechaza ids mal formados antes de escribir", async () => {
    const { deps, enrollments } = setup();

    for (const courseId of ["../curso", "curso/a", ""]) {
      await expect(
        enrollStudent({ actor: ADMIN, uid: LEARNER.uid, courseId }, deps),
      ).rejects.toMatchObject({ code: "ENROLLMENT_ID_INVALID" });
    }
    expect(enrollments.writes).toBe(0);
  });
});

describe("revocar", () => {
  it("solo un administrador revoca", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a");

    await expect(
      revokeEnrollment({ actor: LEARNER, uid: LEARNER.uid, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(true);
  });

  it("revocar quita el acceso y no borra el documento", async () => {
    const { deps, enrollments } = setup();
    enrollments.seed(LEARNER.uid, "curso-a");

    await revokeEnrollment({ actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" }, deps);

    await expect(hasCourseAccess(LEARNER, "curso-a", deps)).resolves.toBe(false);
    const stored = await enrollments.get(LEARNER.uid, "curso-a");
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("revoked");
  });

  it("revocar una matrícula inexistente es un 404", async () => {
    const { deps } = setup();
    await expect(
      revokeEnrollment({ actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "ENROLLMENT_NOT_FOUND", status: 404 });
  });

  it("revocar no afecta a la matrícula de otro alumno", async () => {
    const { deps, enrollments } = setup();
    const other = "otro-uid-00001";
    enrollments.seed(LEARNER.uid, "curso-a");
    enrollments.seed(other, "curso-a");

    await revokeEnrollment({ actor: ADMIN, uid: LEARNER.uid, courseId: "curso-a" }, deps);

    await expect(hasCourseAccess({ ...LEARNER, uid: other }, "curso-a", deps)).resolves.toBe(true);
  });
});
