import { describe, expect, it } from "vitest";
import { MAX_BULK_ENROLL, enrollMany } from "@/server/enrollments/service";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  makeDefinition,
} from "../helpers/db-doubles";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * MATRICULACIÓN EN BLOQUE
 * =======================
 *
 * Motivo: matricular a 40 personas eran 40 formularios. Esto hace lo mismo en
 * una operación, sin inventarse una segunda regla de matriculación: se apoya en
 * el mismo `enrollStudent` de siempre.
 *
 * Lo que se fija aquí:
 *   · solo administradores;
 *   · idempotente: quien ya estaba no cambia de fecha ni se duplica;
 *   · el resumen dice la verdad: nuevas, ya estaban y fallos, por separado;
 *   · un fallo de una persona no tumba el lote ni lo deja a medias en silencio;
 *   · no se revoca nada y hay un tope defensivo.
 */

/**
 * Uids con la forma real (Firebase Auth): el servicio valida su longitud al
 * calcular el id del documento, así que «uid-1» no sirve como identificador.
 */
const U1 = "learner-uid-0001";
const U2 = "learner-uid-0002";
const U3 = "learner-uid-0003";

function setup() {
  const catalog = new InMemoryCatalogStore();
  const enrollments = new InMemoryEnrollmentStore();
  catalog.seedPublished(makeDefinition());
  return { enrollments, deps: { catalog, enrollments, now: () => FIXED_NOW } };
}

describe("matrícula en bloque: camino correcto", () => {
  it("matricula a varias personas y las cuenta por separado", async () => {
    const { enrollments, deps } = setup();
    enrollments.seed(U2, "curso-a");

    const result = await enrollMany(
      { actor: ADMIN, courseId: "curso-a", uids: [U1, U2, U3] },
      deps,
    );

    expect(result.enrolled).toEqual([U1, U3]);
    expect(result.already).toEqual([U2]);
    expect(result.failed).toEqual([]);
    expect(result.requested).toBe(3);

    expect((await enrollments.get(U1, "curso-a"))?.status).toBe("active");
    expect((await enrollments.get(U3, "curso-a"))?.status).toBe("active");
  });

  it("no cambia la fecha de quien ya estaba matriculado", async () => {
    const { enrollments, deps } = setup();
    enrollments.seed(U2, "curso-a");

    await enrollMany({ actor: ADMIN, courseId: "curso-a", uids: [U2] }, deps);

    expect((await enrollments.get(U2, "curso-a"))?.enrolledAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("quita huecos y repetidos de la lista antes de contar", async () => {
    const { deps } = setup();

    const result = await enrollMany(
      { actor: ADMIN, courseId: "curso-a", uids: [U1, ` ${U1} `, "", "   ", U2] },
      deps,
    );

    expect(result.requested).toBe(2);
    expect(result.enrolled).toEqual([U1, U2]);
  });

  it("rematricular a alguien cuya matrícula estaba revocada la reactiva", async () => {
    const { enrollments, deps } = setup();
    enrollments.seed(U1, "curso-a", "revoked");

    const result = await enrollMany({ actor: ADMIN, courseId: "curso-a", uids: [U1] }, deps);

    expect(result.enrolled).toEqual([U1]);
    expect(result.already).toEqual([]);
    expect((await enrollments.get(U1, "curso-a"))?.status).toBe("active");
  });
});

describe("matrícula en bloque: lo que se rechaza", () => {
  it("un alumno no puede matricular a nadie", async () => {
    const { enrollments, deps } = setup();

    await expect(
      enrollMany({ actor: LEARNER, courseId: "curso-a", uids: [U1] }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(enrollments.writes).toBe(0);
  });

  it("un curso que no existe da 404 y no escribe nada", async () => {
    const { enrollments, deps } = setup();

    await expect(
      enrollMany({ actor: ADMIN, courseId: "curso-fantasma", uids: [U1] }, deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_FOUND", status: 404 });

    expect(enrollments.writes).toBe(0);
  });

  it("una lista vacía no es una operación válida", async () => {
    const { deps } = setup();

    await expect(
      enrollMany({ actor: ADMIN, courseId: "curso-a", uids: ["", "  "] }, deps),
    ).rejects.toMatchObject({ code: "ENROLLMENT_NOTHING_TO_DO", status: 400 });
  });

  it("un lote por encima del tope se rechaza entero", async () => {
    const { enrollments, deps } = setup();
    const uids = Array.from({ length: MAX_BULK_ENROLL + 1 }, (_, index) => `learner-uid-${String(index).padStart(4, "0")}`);

    await expect(
      enrollMany({ actor: ADMIN, courseId: "curso-a", uids }, deps),
    ).rejects.toMatchObject({ code: "ENROLLMENT_TOO_LARGE", status: 400 });

    expect(enrollments.writes).toBe(0);
  });
});

describe("matrícula en bloque: fallos parciales", () => {
  it("un fallo en una persona no impide matricular a las demás y se informa", async () => {
    const { enrollments, deps } = setup();
    const originalUpsert = enrollments.upsert.bind(enrollments);
    let calls = 0;
    enrollments.upsert = async (enrollment) => {
      calls += 1;
      if (calls === 2) throw new Error("fallo simulado de Firestore");
      return originalUpsert(enrollment);
    };

    const result = await enrollMany(
      { actor: ADMIN, courseId: "curso-a", uids: [U1, U2, U3] },
      deps,
    );

    expect(result.enrolled).toEqual([U1, U3]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.uid).toBe(U2);
  });
});
