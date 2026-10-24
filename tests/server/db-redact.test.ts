import { describe, expect, it } from "vitest";
import { runChecks, summarize, type AccountLite, type Finding } from "@/server/db/checks";
import { SCHEMA_VERSION } from "@/server/db/schema.constants";
import {
  auditStatus,
  buildRedactionIndex,
  containsPii,
  formatAuditStatus,
  formatFindingLines,
  guardLine,
  guardStreamChunk,
  installStreamGuard,
  redactFindings,
  redactGeneric,
  redactText,
  sanitizeText,
} from "@/server/db/redact";

/**
 * Pruebas de la redacción de `npm run db:check -- --redact`.
 *
 * Lo que se acredita aquí:
 *   - ningún identificador personal llega a la salida, incluidos los `uid`
 *     huérfanos de `progress`/`attempts` (hallazgo H1 de la revisión F3-E);
 *   - el límite `MAX_DOCS` no puede dejar identificadores fuera del índice;
 *   - ningún dato puede inyectar líneas en el registro ni en el resumen de
 *     GitHub Actions (hallazgo H5);
 *   - la redacción NO cambia códigos, niveles, recuentos ni veredicto;
 *   - el estado final (`AUDITORÍA: …`) se deriva de los códigos.
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

/** Índice con las mismas fuentes que usa `db-check.ts`. */
function indexFor(input: {
  accounts: readonly AccountLite[];
  progress?: ReadonlyArray<{ uid: string }>;
  attempts?: ReadonlyArray<{ uid: string }>;
}) {
  return buildRedactionIndex({
    accounts: input.accounts,
    extraUids: [
      ...(input.progress ?? []).map((entry) => entry.uid),
      ...(input.attempts ?? []).map((entry) => entry.uid),
    ],
  });
}

/** Reproduce la salida completa del verificador (hallazgos + resumen + estado). */
function renderOutput(
  findings: readonly Finding[],
  index: ReturnType<typeof buildRedactionIndex>,
  adminCount: number | null,
): string[] {
  return [
    ...findings.flatMap((finding) => formatFindingLines(finding, index)),
    `Resumen: ${summarize(findings).errors} error(es), ${summarize(findings).warnings} aviso(s), ${summarize(findings).infos} informativo(s).`,
    ...(adminCount === null
      ? [formatAuditStatus(auditStatus({ findings: [], adminCount: null, blocked: true }))]
      : [formatAuditStatus(auditStatus({ findings, adminCount }))]),
  ];
}

describe("redactFindings", () => {
  const index = indexFor({ accounts, progress: findingsWithPii.length ? [] : [] });

  it("no deja ningún identificador personal en la salida", () => {
    const visible = redactFindings(findingsWithPii, index);
    const output = visible.flatMap((finding) => formatFindingLines(finding, index)).join("\n");

    for (const value of piiValues) {
      expect(output).not.toContain(value);
    }
    expect(containsPii(output, index)).toBe(false);
  });

  it("conserva niveles, códigos y número de referencias", () => {
    const visible = redactFindings(findingsWithPii, index);

    expect(visible.map((finding) => [finding.level, finding.code])).toEqual(
      findingsWithPii.map((finding) => [finding.level, finding.code]),
    );
    expect(visible.map((finding) => finding.refs?.length ?? 0)).toEqual(
      findingsWithPii.map((finding) => finding.refs?.length ?? 0),
    );
  });

  it("no cambia el veredicto de la comprobación", () => {
    expect(summarize(redactFindings(findingsWithPii, index))).toEqual(summarize(findingsWithPii));
  });

  it("mantiene la correlación: mismo valor, misma etiqueta; distinto valor, distinta", () => {
    const a = redactText("progress de uid-alumno-0003 en curso-inventado", index);
    const b = redactText("intento de uid-alumno-0003", index);
    const token = /uid#\d+/.exec(a)?.[0];

    expect(token).toBeDefined();
    expect(b).toContain(token ?? "¬");
    expect(redactText("admin.uno", index)).not.toBe(redactText("alumno.tres", index));
  });

  it("asigna las etiquetas por orden alfabético, no por orden de lectura", () => {
    const first = indexFor({ accounts });
    const reversed = indexFor({ accounts: [...accounts].reverse() });

    expect(reversed.entries).toEqual(first.entries);
    expect(redactText("admin.uno / alumno.tres", first)).toBe(
      redactText("admin.uno / alumno.tres", reversed),
    );
  });

  it("no oculta identificadores técnicos de contenido", () => {
    const text = redactText("El curso curso-a apunta a la v2", index);
    expect(text).toContain("curso-a");
    expect(redactText("creado por bootstrap-script", index)).toContain("bootstrap-script");
  });

  it("redacta también el origen de creación no estándar (ADMIN_ORIGIN_UNEXPECTED)", () => {
    const visible = redactFindings(findingsWithPii, index);
    const origin = visible.find((finding) => finding.code === "ADMIN_ORIGIN_UNEXPECTED");
    const output = JSON.stringify(origin);

    expect(output).not.toContain("excel-import");
    expect(output).toMatch(/origen#\d+/);
  });
});

// ---------------------------------------------------------------------------
// H1 — UID huérfanos: `progress` y `attempts` pueden apuntar a cuentas borradas
// ---------------------------------------------------------------------------

describe("H1: UID cuya cuenta ya no existe", () => {
  const accountsOneAdmin = [account()];
  const orphanUid = "UID-HUERFANO-SIN-CUENTA";

  const findings = runChecks({
    expectedSchemaVersion: SCHEMA_VERSION,
    meta: { schemaVersion: SCHEMA_VERSION },
    accounts: accountsOneAdmin,
    courses: [{ courseId: "curso-a", publishedVersion: null }],
    versions: [],
    answerKeys: [],
    progress: [{ uid: orphanUid, courseId: "curso-a", version: 1 }],
    attempts: [{ uid: orphanUid, courseId: "curso-a", version: 1, gradedBy: "client" }],
  });

  it("redacta el UID de progress aunque no exista la cuenta", () => {
    const index = indexFor({
      accounts: accountsOneAdmin,
      progress: [{ uid: orphanUid }],
      attempts: [{ uid: orphanUid }],
    });
    const output = renderOutput(findings, index, 1).join("\n");

    expect(findings.some((finding) => finding.code === "PROGRESS_FOR_UNPUBLISHED_COURSE")).toBe(true);
    expect(output).not.toContain(orphanUid);
    expect(output).toMatch(/uid#\d+/);
  });

  it("redacta el UID de attempts aunque no exista la cuenta", () => {
    const index = indexFor({
      accounts: accountsOneAdmin,
      progress: [{ uid: orphanUid }],
      attempts: [{ uid: orphanUid }],
    });
    const attemptsFindings = findings.filter(
      (finding) => finding.code === "ATTEMPT_NOT_SERVER_GRADED",
    );
    expect(attemptsFindings).toHaveLength(1);

    const lines = attemptsFindings.flatMap((finding) => formatFindingLines(finding, index));
    expect(lines.join("\n")).not.toContain(orphanUid);
    // Mensaje y referencia siguen ahí, solo cambia el valor.
    expect(lines[0]).toContain("uid#");
    expect(lines[1]).toContain("↳");
  });

  it("redacta un UID con formato UUID y un UID opaco de 28 caracteres", () => {
    const uuid = "8f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
    const opaque = "Xk29fJd83kQmZ1pLrT6vBn4sYc0w";

    const orphanFindings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: accountsOneAdmin,
      courses: [{ courseId: "curso-a", publishedVersion: null }],
      versions: [],
      answerKeys: [],
      progress: [
        { uid: uuid, courseId: "curso-a", version: 1 },
        { uid: opaque, courseId: "curso-a", version: 1 },
      ],
      attempts: [],
    });

    const index = indexFor({
      accounts: accountsOneAdmin,
      progress: [{ uid: uuid }, { uid: opaque }],
    });
    const output = orphanFindings
      .flatMap((finding) => formatFindingLines(finding, index))
      .join("\n");

    expect(output).not.toContain(uuid);
    expect(output).not.toContain(opaque);
    expect(output).toMatch(/uid#\d+/);
  });

  it("redacta esas mismas formas aunque no estén en ninguna lista (última red)", () => {
    // Sin índice que las conozca: el filtro por forma debe cubrirlas.
    const uuid = "8f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8";
    const opaque = "Xk29fJd83kQmZ1pLrT6vBn4sYc0w";

    expect(redactGeneric(`progreso de ${uuid}`)).not.toContain(uuid);
    expect(redactGeneric(`progreso de ${opaque}`)).not.toContain(opaque);
    expect(redactGeneric("progreso de curso-a v2")).toBe("progreso de curso-a v2");
    expect(redactGeneric("INDEXES_OK / SCHEMA_VERSION_OK")).toBe("INDEXES_OK / SCHEMA_VERSION_OK");
  });
});

// ---------------------------------------------------------------------------
// H1 — límite MAX_DOCS = 2000
// ---------------------------------------------------------------------------

describe("H1: el límite MAX_DOCS no deja identificadores fuera del índice", () => {
  const MAX_DOCS = 2000;
  // 2001 cuentas: la última queda fuera de la lectura truncada.
  const manyAccounts: AccountLite[] = Array.from({ length: MAX_DOCS + 1 }, (_, position) =>
    account({
      uid: `uid-sintetico-${String(position).padStart(5, "0")}`,
      username: `persona.${String(position).padStart(5, "0")}`,
      role: position === 0 ? "admin" : "learner",
    }),
  );
  const loaded = manyAccounts.slice(0, MAX_DOCS); // lo que devuelve readCollection
  const outsideUid = manyAccounts[MAX_DOCS].uid;

  it("redacta el UID de una cuenta que quedó fuera de la lectura truncada", () => {
    // Escenario realista: esa cuenta se borró y su progreso sigue ahí.
    const progress = [{ uid: outsideUid, courseId: "curso-a", version: 1 }];
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: loaded,
      courses: [{ courseId: "curso-a", publishedVersion: null }],
      versions: [],
      answerKeys: [],
      progress,
      attempts: [],
    });

    const index = indexFor({ accounts: loaded, progress });
    const output = renderOutput(findings, index, 1).join("\n");

    expect(loaded).toHaveLength(MAX_DOCS);
    expect(output).not.toContain(outsideUid);
    expect(output).toMatch(/uid#\d+/);
  });

  it("lo que no se leyó tampoco se imprime: ninguna cuenta fuera del límite aparece", () => {
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: loaded,
      courses: [],
      versions: [],
      answerKeys: [],
      progress: [],
      attempts: [],
    });
    const index = indexFor({ accounts: loaded });
    const output = renderOutput(findings, index, loaded.filter((a) => a.role === "admin").length).join("\n");

    // El recuento es una cota inferior (comportamiento previo, no se cambia)…
    expect(findings.find((finding) => finding.code === "ADMIN_COUNT")?.message).toContain("1");
    // …y ningún identificador de las 2001 cuentas sale en claro.
    for (const value of ["persona.00000", "persona.01999", outsideUid]) {
      expect(output).not.toContain(value);
    }
  });

  it("con 2001 cuentas no queda ningún identificador conocido en toda la salida", () => {
    const progress = [{ uid: outsideUid, courseId: "curso-a", version: 3 }];
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: loaded,
      courses: [{ courseId: "curso-a", publishedVersion: 1 }],
      versions: [{ courseId: "curso-a", version: 1, status: "published" }],
      answerKeys: [{ courseId: "curso-a", version: 1 }],
      progress,
      attempts: [{ uid: loaded[5].uid as string, courseId: "curso-a", version: 1, gradedBy: "client" }],
    });
    const index = indexFor({ accounts: loaded, progress, attempts: [{ uid: loaded[5].uid }] });
    const output = renderOutput(findings, index, 1);

    expect(containsPii(output.join("\n"), index)).toBe(false);
    expect(output.join("\n")).not.toContain(outsideUid);
    expect(output.join("\n")).not.toContain(loaded[5].username as string);
    expect(output.some((line) => /persona\.\d{5}/.test(line))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H5 — inyección de líneas
// ---------------------------------------------------------------------------

describe("H5: un dato no puede fabricar líneas ni un estado falso", () => {
  const FAKE = "AUDITORÍA: ADMIN_COUNT 99 · ESQUEMA: OK · ÍNDICES: OK";
  const poisonedCourseId = `curso-x\n${FAKE}\nResumen: 0 error(es), 0 aviso(s), 0 informativo(s).`;

  const poisonedFindings = runChecks({
    expectedSchemaVersion: SCHEMA_VERSION,
    meta: { schemaVersion: SCHEMA_VERSION },
    accounts: [account()],
    courses: [{ courseId: poisonedCourseId, publishedVersion: null }],
    versions: [],
    answerKeys: [],
    progress: [],
    attempts: [],
  });

  it("sanea \\n, \\r y \\t dejando visible que el dato venía manipulado", () => {
    expect(sanitizeText("a\nb\rc\td")).toBe("a␤b␍c␉d");
    expect(sanitizeText("normal")).toBe("normal");
    expect(sanitizeText("separador\u2028de línea")).toBe("separador?de línea");
  });

  it("el CLI no imprime ninguna línea que empiece por AUDITORÍA: salvo la real", () => {
    const index = indexFor({ accounts: [account()] });
    const output = renderOutput(poisonedFindings, index, 1);
    const auditLines = output.filter((line) => line.startsWith("AUDITORÍA: "));

    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toBe("AUDITORÍA: ADMIN_COUNT 1 · ESQUEMA: OK · ÍNDICES: NO COMPROBABLE");
    expect(output.join("\n")).not.toContain(`\n${FAKE}`);
  });

  it("el texto inyectado queda escapado dentro de una sola línea", () => {
    const index = indexFor({ accounts: [account()] });
    const lines = poisonedFindings.flatMap((finding) => formatFindingLines(finding, index));
    const courseLine = lines.find((line) => line.includes("COURSE_WITHOUT_PUBLICATION"));

    expect(courseLine).toBeDefined();
    expect(courseLine).toContain("␤");
    expect(courseLine).toContain("AUDITORÍA: ADMIN_COUNT 99"); // se ve, pero dentro de la línea
    expect(courseLine).toMatch(/^· \[info\] COURSE_WITHOUT_PUBLICATION/);
  });

  it("sanea también sin --redact (modo normal)", () => {
    const lines = poisonedFindings.flatMap((finding) => formatFindingLines(finding, null));
    expect(lines.filter((line) => line.startsWith("AUDITORÍA: "))).toHaveLength(0);
    expect(lines.join("\n")).toContain("␤");
  });

  it("sanea el estado de una versión y una referencia con saltos de línea", () => {
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: [account()],
      courses: [{ courseId: "curso-a", publishedVersion: 1 }],
      versions: [{ courseId: "curso-a", version: 1, status: "borrador\nESQUEMA: OK" }],
      answerKeys: [{ courseId: "curso-a", version: 1 }],
      progress: [],
      attempts: [],
    });
    const index = indexFor({ accounts: [account()] });
    const output = renderOutput(findings, index, 1);

    expect(output.join("\n")).not.toMatch(/\nESQUEMA: OK/);
    expect(output.some((line) => line.startsWith("ESQUEMA: "))).toBe(false);
    expect(output.join("\n")).toContain("borrador␤ESQUEMA: OK");
  });

  it("sanea el origen de creación manipulado antes de redactarlo", () => {
    const poisoned = account({ createdBy: "excel-import\nowned-by-attacker" });
    const findings = runChecks({
      expectedSchemaVersion: SCHEMA_VERSION,
      meta: { schemaVersion: SCHEMA_VERSION },
      accounts: [poisoned],
      courses: [],
      versions: [],
      answerKeys: [],
      progress: [],
      attempts: [],
    });
    const index = indexFor({ accounts: [poisoned] });
    const output = renderOutput(findings, index, 1).join("\n");

    expect(output).not.toContain("excel-import");
    expect(output).not.toContain("owned-by-attacker");
    expect(output).not.toMatch(/\nowned-by-attacker/);
  });

  it("el saneado no altera niveles, códigos ni recuento de referencias", () => {
    const index = indexFor({ accounts: [account()] });
    const before = poisonedFindings.map((finding) => [
      finding.level,
      finding.code,
      finding.refs?.length ?? 0,
    ]);
    const after = redactFindings(poisonedFindings, index).map((finding) => [
      finding.level,
      finding.code,
      finding.refs?.length ?? 0,
    ]);
    expect(after).toEqual(before);
    expect(summarize(redactFindings(poisonedFindings, index))).toEqual(summarize(poisonedFindings));
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
  const index = indexFor({ accounts });

  it("sustituye la línea entera si todavía contiene un identificador conocido", () => {
    expect(guardLine("      ↳ admin.uno", index)).toBe(
      "[línea omitida: contenía un identificador]",
    );
  });

  it("sustituye la línea si contiene un correo no inventariado", () => {
    expect(guardLine("      ↳ otra@example.com", index)).toBe(
      "[línea omitida: contenía un identificador]",
    );
  });

  it("sustituye la línea si aparece una forma de identificador desconocida", () => {
    expect(guardLine("      ↳ Xk29fJd83kQmZ1pLrT6vBn4sYc0w", index)).toBe(
      "[línea omitida: contenía un identificador]",
    );
  });

  it("deja pasar una línea sin datos personales", () => {
    const line = "[info] ACCOUNT_TOTALS: Cuentas: 3 (2 activas, 0 pendientes, 1 deshabilitada).";
    expect(guardLine(line, index)).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// H6 — canal `stderr`: lo que escribe el SDK de Firebase/gRPC
// ---------------------------------------------------------------------------

describe("H6: el canal stderr del SDK pasa por la redacción", () => {
  const index = indexFor({ accounts });

  // Mensajes reales del SDK/gRPC observados o documentados: no traen datos de
  // documentos, pero sí pueden traer el correo de la cuenta de servicio, el
  // identificador de proyecto o un token en el mensaje de error.
  const sdkWarning =
    "(node:2312) MetadataLookupWarning: received unexpected error = Getting metadata from plugin failed with error: cuenta@ejemplo.iam.gserviceaccount.com code = 401";
  const grpcError =
    "14 UNAVAILABLE: No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:9. token ya29.a0AfH6SMBxEjemplo";

  it("redacta correos y tokens emitidos fuera de nuestras funciones", () => {
    const guarded = guardStreamChunk(sdkWarning, index);

    expect(guarded).not.toContain("cuenta@ejemplo.iam.gserviceaccount.com");
    expect(guarded).toContain("[correo omitido]");
    expect(guardStreamChunk(grpcError, index)).not.toContain("ya29.");
  });

  it("redacta también los identificadores conocidos que aparezcan en stderr", () => {
    const guarded = guardStreamChunk("aviso: usuario admin.uno con uid-alumno-0003", index);
    expect(guarded).not.toContain("admin.uno");
    expect(guarded).not.toContain("uid-alumno-0003");
  });

  it("no altera la estructura: conserva los saltos de línea legítimos", () => {
    const chunk = "linea uno\nlinea dos\n";
    expect(guardStreamChunk(chunk, index)).toBe(chunk);
  });

  it("una línea falsa emitida antes del sellado se reconoce como tal y no se sella el estado", () => {
    const injected = "error: curso-x\r\nAUDITORÍA: ADMIN_COUNT 99 · ESQUEMA: OK · ÍNDICES: OK\n";
    const guarded = guardStreamChunk(injected, index);

    // Antes del sellado solo se escapa el `\r` (la estructura se conserva);
    // quien decide es la regla «última línea AUDITORÍA» del workflow, y la del
    // verificador se imprime después de todos los hallazgos.
    expect(guarded.split("\n")[0]).toBe("error: curso-x␍");

    // Con el sellado activo (después de imprimir el estado real) ya no pasa.
    const sealed = guardStreamChunk(injected, index, { sealed: true });
    expect(sealed.split("\n").filter((line) => line.startsWith("AUDITORÍA: "))).toHaveLength(0);
    expect(sealed).toContain("[omitido] AUDITORÍA: ADMIN_COUNT 99");
  });

  it("tras el sellado, ninguna línea posterior puede suplantar el estado", () => {
    const writes: string[] = [];
    const fake = {
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    };
    const guard = installStreamGuard([fake], () => indexFor({ accounts }));

    guard.seal();
    fake.write("AUDITORÍA: ADMIN_COUNT 99 · ESQUEMA: OK · ÍNDICES: OK\n");
    fake.write("Resumen: 0 error(es), 0 aviso(s), 0 informativo(s).\n");

    const lines = writes.join("").split("\n");
    expect(lines.filter((line) => line.startsWith("AUDITORÍA: "))).toHaveLength(0);
    expect(lines.filter((line) => line.startsWith("Resumen: "))).toHaveLength(0);
    expect(lines[0]).toContain("[omitido] AUDITORÍA: ADMIN_COUNT 99");

    guard.restore();
  });

  it("límite conocido: los saltos de línea simples del propio stream son estructura", () => {
    // Un stream no permite distinguir un salto legítimo de uno inyectado sin
    // romper la salida. Por eso la garantía real es que el verificador sanea
    // los DATOS antes de escribirlos (pruebas H5) y que el workflow se queda
    // con la ÚLTIMA línea `AUDITORÍA:` (prueba del workflow). Lo que sí hace
    // este filtro es redactar el contenido de cada línea.
    const injected = "error: curso-x\nAUDITORÍA: ADMIN_COUNT 99 · ESQUEMA: OK · ÍNDICES: OK\n";
    const guarded = guardStreamChunk(injected, index);
    expect(guarded.split("\n")[0]).toBe("error: curso-x");
    expect(guardStreamChunk("aviso de cuenta@ejemplo.iam.gserviceaccount.com\n", index)).toContain(
      "[correo omitido]",
    );
  });

  it("funciona sin índice (antes de leer cuentas): redacta por forma", () => {
    expect(guardStreamChunk(sdkWarning, null)).not.toContain("@ejemplo.iam");
    expect(guardStreamChunk("aviso con Xk29fJd83kQmZ1pLrT6vBn4sYc0w", null)).not.toContain(
      "Xk29fJd83kQmZ1pLrT6vBn4sYc0w",
    );
  });

  it("installStreamGuard intercepta de verdad las escrituras y se puede desinstalar", () => {
    const writes: string[] = [];
    const fake = {
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    };
    const fakeIndex = indexFor({ accounts });
    const guard = installStreamGuard([fake], () => fakeIndex);

    fake.write(`${sdkWarning}\n`);
    expect(writes.join("")).not.toContain("cuenta@ejemplo.iam.gserviceaccount.com");

    guard.restore();
    fake.write("cuenta@ejemplo.iam.gserviceaccount.com\n");
    expect(writes.join("")).toContain("cuenta@ejemplo.iam.gserviceaccount.com");
  });

  it("el índice vivo se aplica a escrituras posteriores", () => {
    const writes: string[] = [];
    let current: ReturnType<typeof buildRedactionIndex> | null = null;
    const fake = {
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    };
    const guard = installStreamGuard([fake], () => current);

    fake.write("aviso con admin.uno\n"); // sin índice: no es PII detectable por forma
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("admin.uno");

    current = indexFor({ accounts });
    fake.write("aviso con admin.uno\n");
    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toContain("admin.uno");
    expect(writes[1]).toContain("usuario#");

    guard.restore();
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
    const index = indexFor({ accounts });
    const line = formatAuditStatus(auditStatus({ findings: findingsWithPii, adminCount: 2 }));
    expect(containsPii(line, index)).toBe(false);
    expect(line).toBe("AUDITORÍA: ADMIN_COUNT 2 · ESQUEMA: OK · ÍNDICES: NO COMPROBABLE");
  });
});
