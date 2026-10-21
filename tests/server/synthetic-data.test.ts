import { describe, expect, it } from "vitest";
import { SYNTHETIC_CHUNK, SYNTHETIC_DOCUMENTS } from "../../scripts/lib/synthetic-data";
import { META_DOC, SCHEMA_VERSION } from "@/server/db/schema.constants";

/**
 * DATOS SINTÉTICOS: QUE SEAN SINTÉTICOS, Y COHERENTES
 * ==================================================
 *
 * El ensayo de copias y la siembra del emulador comparten este conjunto. Si
 * alguien introduce un dato con pinta de real, o rompe las referencias entre
 * documentos, la copia de ensayo deja de ser representativa. Estas pruebas son
 * baratas y evitan las dos cosas.
 */

describe("datos sintéticos del emulador", () => {
  it("no repite rutas", () => {
    const paths = SYNTHETIC_DOCUMENTS.map((document) => document.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("usa solo correos de ejemplo, nunca dominios reales", () => {
    const emails = SYNTHETIC_DOCUMENTS.flatMap(({ data }) =>
      Object.values(data).filter((value): value is string => typeof value === "string"),
    ).filter((value) => value.includes("@"));

    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email.endsWith("@example.invalid")).toBe(true);
  });

  it("marca todas las cuentas y el curso como sintéticos", () => {
    const accounts = SYNTHETIC_DOCUMENTS.filter((document) => document.path.startsWith("accounts/"));
    expect(accounts).toHaveLength(2);
    for (const account of accounts) expect(account.data.username).toMatch(/sintetico/);

    const course = SYNTHETIC_DOCUMENTS.find((document) => document.path === "courses/curso-sintetico");
    expect(course?.data.title).toMatch(/sintético/i);
  });

  it("mantiene las referencias entre cuenta, matrícula, progreso y documento", () => {
    const byPath = new Map(SYNTHETIC_DOCUMENTS.map((document) => [document.path, document.data]));
    const enrollment = byPath.get("enrollments/sintetico-alumno_curso-sintetico");
    const progress = byPath.get("progress/sintetico-alumno_curso-sintetico");
    const document = byPath.get("documents/doc-sintetico");
    const chunk = byPath.get("pdfChunks/doc-sintetico_0");

    expect(enrollment?.uid).toBe("sintetico-alumno");
    expect(progress?.uid).toBe(enrollment?.uid);
    expect(progress?.courseId).toBe(enrollment?.courseId);
    expect(document?.pageCount).toBe(
      (progress?.documents as Record<string, { totalPages: number }>)["doc-sintetico"].totalPages,
    );
    expect(chunk?.documentId).toBe("doc-sintetico");
    expect((chunk?.data as Buffer).equals(SYNTHETIC_CHUNK)).toBe(true);
    expect(document?.bytes).toBe(SYNTHETIC_CHUNK.length);
  });

  it("incluye el documento de versión del esquema que espera db:check", () => {
    const meta = SYNTHETIC_DOCUMENTS.find(
      (document) => document.path === `${META_DOC.collection}/${META_DOC.id}`,
    );
    expect(meta?.data.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("cabe en una sola transacción del emulador (muy por debajo de 500 escrituras)", () => {
    expect(SYNTHETIC_DOCUMENTS.length).toBeLessThan(500);
  });
});
