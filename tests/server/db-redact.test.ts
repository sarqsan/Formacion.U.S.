import { describe, expect, it } from "vitest";
import { runChecks, summarize, type AccountLite, type Finding } from "@/server/db/checks";
import { SCHEMA_VERSION } from "@/server/db/schema.constants";
import {
  auditStatus,
  buildRedactionIndex,
  containsPii,
  formatAuditStatus,
  guardLine,
  redactFindings,
  redactGeneric,
  redactText,
} from "@/server/db/redact";

/**
 * Pruebas de la redacción de `npm run db:check -- --redact`.
 *
 * Lo que se acredita aquí:
 *   - ningún identificador personal llega a la salida;
 *   - la redacción NO cambia códigos, niveles, recuentos ni veredicto;
 *   - el estado final (`AUDITORÍA: …`) se deriva de los códigos, de modo que
 *     un fallo técnico nunca se confunde con «no hay administrador».
 */

const account = (overrides: Partial<AccountLite> = {}): AccountLite => ({
  uid: "uid-admin-0001",
  username: "admin.uno",
  role: "admin",
  status: "active",
  claimsVersion: 1,
  createdBy: "bootstrap-script",
  ...overrides,
});

const accounts: AccountLite[] = [
  account(),
  account({
    uid: "uid-admin-0002",
    username: "ana.garcia@example.com",
    createdBy: "excel-import",
  }),
  account({
    uid: "uid-alumno-0003",
    username: "alumno.tres",
    role: "learner",
    createdBy: "excel-import",
  }),
];

const findingsWithPii: Finding[] = runChecks({
  expectedSchemaVersion: SCHEMA_VERSION,
  meta: { schemaVersion: SCHEMA_VERSION },
  accounts,
  courses: [{ courseId: "curso-a", publishedVersion: 2 }],
  versions: [{ courseId: "curso-a", version: 1, status: "published" }],
  answerKeys: [{ courseId: "curso-a", version: 1 }],
  progress: [
    { uid: "uid-alumno-0003", courseId: "curso-inventado", version: 1 },
    { uid: "uid-alumno-0003", courseId: "curso-a", version: 9 },
  ],
  attempts: [
    { uid: "uid-alumno-0003", courseId: "curso-a", version: 1, gradedBy: "client" },
  ],
});

const piiValues = [
  "uid-admin-0001",
  "uid-admin-0002",
  "uid-alumno-0003",
  "admin.uno",
  "ana.garcia@example.com",
  "alumno.tres",
  "excel-import",
];

/** Reproduce lo que imprime el verificador, línea a línea. */
function render(findings: readonly Finding[]): string[] {
  return findings.flatMap((finding) => [
    `[${finding.level}] ${finding.code}: ${finding.message}`,
    ...(finding.refs ?? []).map((ref) => `      ↳ ${ref}`),
  ]);
}

describe("redactFindings", () => {
  it("no deja ningún identificador personal en la salida", () => {
    const index = buildRedactionIndex(accounts);
    const visible = redactFindings(findingsWithPii, index);
    const output = render(visible).join("\n");

    for (const value of piiValues) {
      expect(output).not.toContain(value);
    }
    expect(containsPii(output, index)).toBe(false);
  });

  it("conserva niveles, códigos y número de referencias", () => {
    const index = buildRedactionIndex(accounts);
    const visible = redactFindings(findingsWithPii, index);

    expect(visible.map((finding) => [finding.level, finding.code])).toEqual(
      findingsWithPii.map((finding) => [finding.level, finding.code]),
    );
    expect(visible.map((finding) => finding.refs?.length ?? 0)).toEqual(
      findingsWithPii.map((finding) => finding.refs?.length ?? 0),
    );
  });

  it("no cambia el veredicto de la comprobación", () => {
    const index = buildRedactionIndex(accounts);
    expect(summarize(redactFindings(findingsWithPii, index))).toEqual(summarize(findingsWithPii));
  });

  it("mantiene la correlación: mismo valor, misma etiqueta; distinto valor, distinta", () => {
    const index = buildRedactionIndex(accounts);
    const a = redactText("progress de uid-alumno-0003 en curso-inventado", index);
    const b = redactText("intento de uid-alumno-0003", index);
    const token = /uid#\d+/.exec(a)?.[0];

    expect(token).toBeDefined();
    expect(b).toContain(token ?? "¬");
    expect(redactText("admin.uno", index)).not.toBe(redactText("alumno.tres", index));
  });

  it("asigna las etiquetas por orden alfabético, no por orden de lectura", () => {
    const first = buildRedactionIndex(accounts);
    const reversed = buildRedactionIndex([...accounts].reverse());

    expect(reversed.entries).toEqual(first.entries);
    expect(redactText("admin.uno / alumno.tres", first)).toBe(
      redactText("admin.uno / alumno.tres", reversed),
    );
  });

  it("no oculta identificadores técnicos de contenido", () => {
    const index = buildRedactionIndex(accounts);
    const text = redactText("El curso curso-a apunta a la v2", index);
    expect(text).toContain("curso-a");
    expect(redactText("creado por bootstrap-script", index)).toContain("bootstrap-script");
  });

  it("redacta también el origen de creación no estándar (ADMIN_ORIGIN_UNEXPECTED)", () => {
    const index = buildRedactionIndex(accounts);
    const visible = redactFindings(findingsWithPii, index);
    const origin = visible.find((finding) => finding.code === "ADMIN_ORIGIN_UNEXPECTED");
    const output = JSON.stringify(origin);

    expect(output).not.toContain("excel-import");
    expect(output).toMatch(/origen#\d+/);
  });
});

describe("filtro genérico", () => {
  it("redacta correos, claves privadas y tokens", () => {
    const text = redactGeneric(
      "fallo con persona@example.com, clave -----BEGIN PRIVATE KEY-----MIIEvQIBADANBg-----END PRIVATE KEY----- y token ya29.a0AfH6SMBx",
    );

    expect(text).not.toContain("persona@example.com");
    expect(text).not.toContain("MIIEvQIBADANBg");
    expect(text).not.toContain("ya29.");
    expect(text).toContain("[correo omitido]");
    expect(text).toContain("[clave privada omitida]");
    expect(text).toContain("[token omitido]");
  });

  it("redacta cadenas opacas largas (por ejemplo, una clave pegada por error)", () => {
    const secret = "A".repeat(48);
    expect(redactGeneric(`valor: ${secret}`)).not.toContain(secret);
  });

  it("no toca un mensaje técnico normal", () => {
    const message = "Missing or insufficient permissions.";
    expect(redactGeneric(message)).toBe(message);
  });
});

describe("guardLine (segunda capa antes de imprimir)", () => {
  it("sustituye la línea entera si todavía contiene un identificador conocido", () => {
    const index = buildRedactionIndex(accounts);
    expect(guardLine("      ↳ admin.uno", index)).toBe(
      "[línea omitida: contenía un identificador]",
    );
  });

  it("sustituye la línea si contiene un correo no inventariado", () => {
    const index = buildRedactionIndex(accounts);
    expect(guardLine("      ↳ otra@example.com", index)).toBe(
      "[línea omitida: contenía un identificador]",
    );
  });

  it("deja pasar una línea sin datos personales", () => {
    const index = buildRedactionIndex(accounts);
    const line = "[info] ACCOUNT_TOTALS: Cuentas: 3 (2 activas, 0 pendientes, 1 deshabilitada).";
    expect(guardLine(line, index)).toBe(line);
  });
});

describe("auditStatus", () => {
  const codes = (...list: string[]): Finding[] =>
    list.map((code) => ({ level: "info", code, message: "" }));

  it("con administradores informa del recuento", () => {
    expect(
      auditStatus({ findings: codes("SCHEMA_VERSION_OK", "INDEXES_OK"), adminCount: 2 }),
    ).toEqual({ audit: "ADMIN_COUNT 2", schema: "OK", indexes: "OK" });
  });

  it("sin administradores informa NO_ADMIN (no es un bloqueo técnico)", () => {
    expect(
      auditStatus({ findings: codes("NO_ADMIN", "SCHEMA_VERSION_OK", "INDEXES_OK"), adminCount: 0 }),
    ).toEqual({ audit: "NO_ADMIN", schema: "OK", indexes: "OK" });
  });

  it("un fallo de ejecución es AUDIT_BLOCKED, nunca NO_ADMIN", () => {
    expect(auditStatus({ findings: [], adminCount: null, blocked: true })).toEqual({
      audit: "AUDIT_BLOCKED",
      schema: "NO COMPROBABLE",
      indexes: "NO COMPROBABLE",
    });
  });

  it("traduce los códigos de esquema e índices", () => {
    expect(auditStatus({ findings: codes("SCHEMA_NOT_INITIALIZED"), adminCount: 1 }).schema).toBe(
      "AUSENTE",
    );
    expect(auditStatus({ findings: codes("SCHEMA_VERSION_NEWER"), adminCount: 1 }).schema).toBe(
      "INCOMPATIBLE",
    );
    expect(auditStatus({ findings: codes("SCHEMA_VERSION_MISSING"), adminCount: 1 }).schema).toBe(
      "INCOMPATIBLE",
    );
    expect(auditStatus({ findings: codes("MISSING_INDEXES"), adminCount: 1 }).indexes).toBe("FALTAN");
    expect(auditStatus({ findings: [], adminCount: 1 }).indexes).toBe("NO COMPROBABLE");
  });

  it("el desglose no contiene datos personales", () => {
    const index = buildRedactionIndex(accounts);
    const line = formatAuditStatus(auditStatus({ findings: findingsWithPii, adminCount: 2 }));
    expect(containsPii(line, index)).toBe(false);
    expect(line).toBe("AUDITORÍA: ADMIN_COUNT 2 · ESQUEMA: OK · ÍNDICES: NO COMPROBABLE");
  });
});
