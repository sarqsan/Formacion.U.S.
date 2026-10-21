import { describe, expect, it } from "vitest";
import {
  checkAccounts,
  checkAdminOrigins,
  checkContent,
  checkLearning,
  checkSchema,
  runChecks,
  summarize,
} from "@/server/db/checks";
import { SCHEMA_VERSION } from "@/server/db/schema.constants";

/**
 * Pruebas de la auditoría de base de datos. Es la lógica que ejecuta
 * `npm run db:check`, así que cada caso corresponde a un fallo real que
 * queremos detectar antes de que lo sufra un alumno.
 */

const account = (overrides: Record<string, unknown> = {}) => ({
  uid: "uid-admin-0001",
  username: "admin.uno",
  role: "admin",
  status: "active",
  claimsVersion: 1,
  createdBy: "bootstrap-script",
  ...overrides,
});

describe("checkSchema", () => {
  it("detecta la base de datos sin inicializar", () => {
    const findings = checkSchema(null, SCHEMA_VERSION);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: "error", code: "SCHEMA_NOT_INITIALIZED" });
  });

  it("acepta la versión exacta", () => {
    const findings = checkSchema({ schemaVersion: SCHEMA_VERSION }, SCHEMA_VERSION);
    expect(findings[0]).toMatchObject({ level: "info", code: "SCHEMA_VERSION_OK" });
  });

  it("avisa si el código es más nuevo que la base de datos", () => {
    const findings = checkSchema({ schemaVersion: SCHEMA_VERSION - 1 }, SCHEMA_VERSION);
    expect(findings[0].code).toBe("SCHEMA_VERSION_OLDER");
    expect(findings[0].level).toBe("warning");
  });

  it("falla si la base de datos es más nueva que el código", () => {
    const findings = checkSchema({ schemaVersion: SCHEMA_VERSION + 1 }, SCHEMA_VERSION);
    expect(findings[0]).toMatchObject({ level: "error", code: "SCHEMA_VERSION_NEWER" });
  });

  it("trata un schemaVersion no numérico como error", () => {
    const findings = checkSchema({ schemaVersion: "1" }, SCHEMA_VERSION);
    expect(findings[0]).toMatchObject({ level: "error", code: "SCHEMA_VERSION_MISSING" });
  });
});

describe("checkAdminOrigins", () => {
  it("falla si no hay ningún administrador", () => {
    const findings = checkAdminOrigins([account({ role: "learner", username: "alumno" })]);
    expect(findings[0]).toMatchObject({ level: "error", code: "NO_ADMIN" });
  });

  it("acepta administradores creados por el script de arranque", () => {
    const findings = checkAdminOrigins([account(), account({ uid: "uid-admin-0002", username: "admin.dos" })]);
    expect(findings.some((finding) => finding.level === "error")).toBe(false);
    expect(findings[0].refs).toEqual(["admin.uno", "admin.dos"]);
  });

  it("avisa si un administrador no viene del procedimiento de arranque", () => {
    const findings = checkAdminOrigins([account({ createdBy: "excel-import" })]);
    expect(findings.find((finding) => finding.code === "ADMIN_ORIGIN_UNEXPECTED")).toMatchObject({
      level: "warning",
    });
  });
});

describe("checkAccounts", () => {
  it("detecta usuarios duplicados", () => {
    const findings = checkAccounts([
      account({ uid: "uid-1", username: "igual" }),
      account({ uid: "uid-2", username: "igual" }),
    ]);
    expect(findings).toContainEqual(
      expect.objectContaining({ level: "error", code: "DUPLICATE_USERNAME" }),
    );
  });

  it("detecta roles y estados inválidos", () => {
    const findings = checkAccounts([account({ role: "superadmin", status: "activo" })]);
    const codes = findings.filter((finding) => finding.level === "error").map((finding) => finding.code);
    expect(codes).toContain("ACCOUNT_INVALID_ROLE");
    expect(codes).toContain("ACCOUNT_INVALID_STATUS");
  });

  it("detecta claimsVersion no entero (rompe las reglas por comparación estricta)", () => {
    for (const value of ["1", 1.5, undefined, null]) {
      const findings = checkAccounts([account({ claimsVersion: value })]);
      expect(
        findings.some((finding) => finding.code === "ACCOUNT_INVALID_CLAIMS_VERSION"),
        String(value),
      ).toBe(true);
    }
  });

  it("detecta cuentas sin nombre de usuario", () => {
    const findings = checkAccounts([account({ username: "" })]);
    expect(findings.some((finding) => finding.code === "ACCOUNT_WITHOUT_USERNAME")).toBe(true);
  });

  it("informa del recuento por estado", () => {
    const findings = checkAccounts([
      account(),
      account({ uid: "uid-2", username: "dos", status: "pending_activation" }),
    ]);
    expect(findings.find((finding) => finding.code === "ACCOUNT_TOTALS")?.message).toContain("1 pendientes");
  });
});

describe("checkContent", () => {
  const course = (publishedVersion: number | null) => ({ courseId: "curso-a", publishedVersion });

  it("no considera error un curso sin publicar", () => {
    const findings = checkContent([course(null)], [], []);
    expect(findings[0]).toMatchObject({ level: "info", code: "COURSE_WITHOUT_PUBLICATION" });
  });

  it("detecta un curso que apunta a una versión inexistente", () => {
    const findings = checkContent([course(1)], [], []);
    expect(findings.some((finding) => finding.code === "PUBLISHED_VERSION_MISSING")).toBe(true);
  });

  it("detecta una versión apuntada que no está publicada", () => {
    const findings = checkContent([course(1)], [{ courseId: "curso-a", version: 1, status: "draft" }], []);
    expect(findings.some((finding) => finding.code === "PUBLISHED_VERSION_NOT_PUBLISHED")).toBe(true);
  });

  it("detecta que faltan las claves de la versión publicada", () => {
    const findings = checkContent([course(1)], [{ courseId: "curso-a", version: 1, status: "published" }], []);
    expect(findings.some((finding) => finding.code === "PUBLISHED_VERSION_WITHOUT_KEYS")).toBe(true);
  });

  it("un curso correcto no genera errores", () => {
    const findings = checkContent(
      [course(1)],
      [{ courseId: "curso-a", version: 1, status: "published" }],
      [{ courseId: "curso-a", version: 1 }],
    );
    expect(findings.every((finding) => finding.level !== "error")).toBe(true);
  });

  it("avisa de claves huérfanas", () => {
    const findings = checkContent(
      [course(null)],
      [],
      [{ courseId: "curso-a", version: 7 }],
    );
    expect(findings.some((finding) => finding.code === "ORPHAN_ANSWER_KEYS")).toBe(true);
  });
});

describe("checkLearning", () => {
  const published = [{ courseId: "curso-a", publishedVersion: 2 }];
  const progress = (overrides: Record<string, unknown> = {}) => ({
    uid: "uid-1",
    courseId: "curso-a",
    version: 2,
    completedAt: null,
    ...overrides,
  });
  const attempt = (overrides: Record<string, unknown> = {}) => ({
    uid: "uid-1",
    courseId: "curso-a",
    version: 2,
    assessmentType: "topic",
    passed: false,
    correctCount: 0,
    totalQuestions: 3,
    gradedBy: "server",
    ...overrides,
  });

  it("detecta progreso en versiones futuras", () => {
    const findings = checkLearning([progress({ version: 5 })], [], published);
    expect(findings.some((finding) => finding.code === "PROGRESS_VERSION_AHEAD")).toBe(true);
  });

  it("avisa de progreso en cursos sin publicar", () => {
    const findings = checkLearning([progress()], [], [{ courseId: "curso-a", publishedVersion: null }]);
    expect(findings.find((finding) => finding.code === "PROGRESS_FOR_UNPUBLISHED_COURSE")?.level).toBe(
      "warning",
    );
  });

  it("detecta intentos no corregidos en servidor", () => {
    const findings = checkLearning([], [attempt({ gradedBy: "client" })], published);
    expect(findings.some((finding) => finding.code === "ATTEMPT_NOT_SERVER_GRADED")).toBe(true);
  });

  it("detecta un aprobado imposible (todo o nada)", () => {
    const findings = checkLearning([], [attempt({ passed: true, correctCount: 2 })], published);
    expect(findings.some((finding) => finding.code === "ATTEMPT_INCONSISTENT_PASS")).toBe(true);
  });

  it("acepta un aprobado con todas las correctas", () => {
    const findings = checkLearning(
      [progress()],
      [attempt({ passed: true, correctCount: 3 })],
      published,
    );
    expect(findings.every((finding) => finding.level !== "error")).toBe(true);
  });
});

describe("runChecks / summarize", () => {
  it("una base de datos sana no produce errores", () => {
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: [account()],
      courses: [{ courseId: "curso-a", publishedVersion: 1 }],
      versions: [{ courseId: "curso-a", version: 1, status: "published" }],
      answerKeys: [{ courseId: "curso-a", version: 1 }],
      progress: [],
      attempts: [],
    });

    const summary = summarize(findings);
    expect(summary.ok).toBe(true);
    expect(summary.errors).toBe(0);
  });

  it("una base de datos sin inicializar y sin admin no está sana", () => {
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: null,
      accounts: [],
      courses: [],
      versions: [],
      answerKeys: [],
      progress: [],
      attempts: [],
    });

    const summary = summarize(findings);
    expect(summary.ok).toBe(false);
    expect(summary.errors).toBeGreaterThanOrEqual(2);
  });

  it("summarize separa niveles", () => {
    const summary = summarize([
      { level: "error", code: "A", message: "" },
      { level: "warning", code: "B", message: "" },
      { level: "info", code: "C", message: "" },
      { level: "info", code: "D", message: "" },
    ]);
    expect(summary).toEqual({ errors: 1, warnings: 1, infos: 2, ok: false });
  });
});
