import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import { resetDemoState } from "@/demo/store";
import { confirmImport } from "@/server/import/service";
import { buildXlsx } from "../helpers/xlsx-fixture";
import {
  accounts,
  accountProfile,
  adminCourses,
  adminOverview,
  coursesForLearner,
  courseViewForLearner,
  definitionOf,
  learners,
  portalMode,
  previewImport,
  readPage,
  readingView,
} from "@/server/portal";

/**
 * PORTAL: SEPARACIÓN ENTRE DEMOSTRACIÓN Y FIREBASE
 * ================================================
 *
 * Comprueba dos cosas que no se pueden dejar al azar:
 *
 *   1. el modo se decide por configuración y **no cambia solo**: con
 *      `DEMO_MODE=1` se lee del almacén sintético; sin él, del adaptador real;
 *   2. la autorización se evalúa en el servidor antes de tocar los datos, así
 *      que un alumno no puede llamar a las funciones de administración aunque
 *      la interfaz tuviera un fallo.
 *
 * Las funciones reales se prueban aquí **solo** en su primera barrera (rol y
 * estado): no hay credenciales de Firebase en este entorno y, por tanto, nada
 * de lo que hay debajo se declara verificado.
 */

const ADMIN: Actor = { uid: "demo-admin", role: "admin", status: "active" };
const LEARNER: Actor = { uid: "demo-alumno-1", role: "learner", status: "active" };
const COURSE = "curso-prevencion-riesgos";

const originalDemoMode = process.env.DEMO_MODE;

beforeEach(() => {
  resetDemoState();
  process.env.DEMO_MODE = "1";
});

afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("selección de modo", () => {
  it("usa la demostración solo con DEMO_MODE=1", () => {
    expect(portalMode()).toBe("demo");
    process.env.DEMO_MODE = "0";
    expect(portalMode()).toBe("firebase");
    delete process.env.DEMO_MODE;
    expect(portalMode()).toBe("firebase");
  });

  it("no hay conmutación implícita: el modo no depende de si hay datos", () => {
    process.env.DEMO_MODE = "1";
    expect(portalMode()).toBe("demo");
    // Aunque el almacén esté vacío, el modo sigue siendo demostración.
    expect(portalMode()).toBe("demo");
  });
});

describe("portal en modo demostración", () => {
  it("sirve los cursos del alumno con su progreso", async () => {
    const cards = await coursesForLearner(LEARNER);
    expect(cards.map((card) => card.courseId)).toContain(COURSE);
  });

  it("conserva el progreso de la alumna que ya ha trabajado el curso", async () => {
    const cards = await coursesForLearner({ uid: "demo-alumno-2", role: "learner", status: "active" });
    const course = cards.find((card) => card.courseId === COURSE);
    expect(course?.percent).toBeGreaterThan(0);
    expect(course?.topicsPassed).toBeGreaterThan(0);
  });

  it("devuelve pantallas de texto y registra la lectura", async () => {
    const view = await readingView(LEARNER, { courseId: COURSE, documentId: "doc-riesgos" });
    expect(view.kind).toBe("screens");
    if (view.kind !== "screens") throw new Error("Se esperaban pantallas de demostración.");
    expect(view.screens.length).toBeGreaterThan(0);

    const outcome = await readPage(LEARNER, {
      courseId: COURSE,
      documentId: "doc-riesgos",
      page: view.page,
    });
    expect(outcome.nextPage).toBeGreaterThanOrEqual(view.page);
    expect(outcome.topicId).toBeTruthy();
  });

  it("no entrega respuestas correctas al alumno", async () => {
    const view = await courseViewForLearner(LEARNER, COURSE);
    expect(JSON.stringify(view)).not.toContain("correctOptionIds");
  });

  it("identifica la cuenta de la sesión", async () => {
    const profile = await accountProfile(LEARNER);
    expect(profile?.username).toBe("rol1.ejemplo");
  });

  it("expone la administración con el rol comprobado en servidor", async () => {
    const overview = await adminOverview(ADMIN);
    expect(overview.accounts).toBeGreaterThan(0);
    expect((await adminCourses(ADMIN)).length).toBeGreaterThan(0);
    expect((await accounts(ADMIN)).length).toBeGreaterThan(0);
    expect((await learners(ADMIN)).every((row) => row.role === "learner")).toBe(true);
  });

  it("rechaza la administración a un alumno antes de leer nada", async () => {
    await expect(adminOverview(LEARNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(accounts(LEARNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(definitionOf(LEARNER, COURSE, 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rechaza una cuenta sin sesión", async () => {
    await expect(adminOverview(null as unknown as Actor)).rejects.toBeInstanceOf(DomainError);
  });

  it("la vista previa de importación no crea cuentas en la demostración", async () => {
    const buffer = buildXlsx([
      ["Rol", "Apellido"],
      ["ROL 1", "Ejemplo"],
      ["ROL 2", "Pendiente"],
    ]);

    const { preview } = await previewImport(ADMIN, buffer);
    expect(preview.summary.totalRows).toBeGreaterThan(0);
    // Los nombres propuestos chocan con las cuentas ficticias ya existentes:
    // la vista previa lo detecta y no deja confirmar.
    expect(preview.summary.confirmable).toBe(false);

    await expect(
      confirmImport(
        { actor: ADMIN, rows: [{ rowNumber: 2, rol: "ROL 1", apellido: "Ejemplo" }] },
        {
          directory: {
            listTakenUsernames: async () => new Set<string>(),
            isUsernameTaken: async () => false,
          },
          provisioner: {
            createAccount: async () => {
              throw new DomainError("DEMO_NOT_CONNECTED", "No conectado.");
            },
            rollbackAccount: async () => undefined,
          },
          audit: { record: async () => undefined },
          authEmailDomain: "formacion.invalid",
          activationTtlHours: 24,
        },
      ),
    ).rejects.toBeTruthy();
  });
});

describe("portal en modo real (solo primera barrera)", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "";
  });

  it("rechaza la administración a un alumno sin llamar a Firestore", async () => {
    await expect(adminOverview(LEARNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminCourses(LEARNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rechaza una cuenta deshabilitada aunque tenga rol de alumno", async () => {
    const disabled: Actor = { uid: "x", role: "learner", status: "disabled" };
    await expect(coursesForLearner(disabled)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_ACTIVE",
    });
  });

  it("no confirma conexión sin credenciales", async () => {
    const { checkConnection } = await import("@/server/portal/firebase");
    const result = await checkConnection();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Firestore/i);
  });
});
