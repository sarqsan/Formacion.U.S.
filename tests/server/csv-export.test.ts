import { describe, expect, it } from "vitest";
import {
  CSV_BOM,
  buildCsv,
  csvFilename,
  neutralizeFormula,
  toCsvCell,
  type CsvColumn,
} from "@/domain/exports/csv";
import {
  ACTIVITY_COLUMNS,
  PROGRESS_COLUMNS,
  activityCsv,
  activityRows,
  progressCsv,
  type ProgressExportRow,
} from "@/server/exports/reports";
import type { ActivityEntry } from "@/server/audit/activity";

/**
 * EXPORTACIÓN A CSV
 * =================
 *
 * El fichero lo abre una persona en Excel, así que lo que se prueba aquí no es
 * «genera texto» sino que **se abra bien** y que **no ejecute nada**:
 *
 *   · BOM UTF-8 y `;` como separador: sin eso, «García» sale con basura y todo
 *     acaba en una sola celda en el Excel en español;
 *   · comillas dobles y saltos de línea dentro de una celda, sin romper filas;
 *   · **inyección de fórmulas**: un texto que empieza por `=`, `+`, `-` o `@`
 *     se ejecuta al abrir el fichero; se neutraliza con una comilla;
 *   · el registro exportado no lleva nada fuera de la lista blanca.
 */

const ROW: ProgressExportRow = {
  username: "rol1.garcia",
  personRol: "ROL 1",
  courseTitle: "Prevención de riesgos",
  courseId: "curso-prevencion-riesgos",
  status: "active",
  percent: 100,
  topicsPassed: 2,
  topicsTotal: 2,
  finalExamPassed: true,
  completed: true,
  pending: [],
  attempts: 3,
  enrolledAt: "2026-10-24T09:00:00.000Z",
};

describe("el fichero se abre bien en Excel", () => {
  it("empieza por BOM y usa punto y coma y CRLF", () => {
    const csv = progressCsv([ROW]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain(";");
    expect(csv).toContain("\r\n");
    // Nunca hay un salto suelto: rompería filas en algunas versiones.
    expect(csv.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("la cabecera sale en el orden declarado y en castellano", () => {
    const header = progressCsv([]).replace(CSV_BOM, "").split("\r\n")[0];
    expect(header).toBe(PROGRESS_COLUMNS.map((column) => column.header).join(";"));
    expect(header).toContain("Usuario");
    expect(header).toContain("Progreso (%)");
  });

  it("una fila completa tiene tantas celdas como columnas", () => {
    const lines = progressCsv([ROW]).replace(CSV_BOM, "").split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.split(";")).toHaveLength(PROGRESS_COLUMNS.length);
    expect(lines[1]).toContain("rol1.garcia");
    expect(lines[1]).toContain("Apto");
    // Un booleano se escribe en castellano, no como `true`.
    expect(lines[1]).toContain("Sí");
    expect(lines[1]).not.toContain("true");
  });

  it("la fecha del alta va en ISO corto, no con la hora", () => {
    const lines = progressCsv([ROW]).replace(CSV_BOM, "").split("\r\n").filter(Boolean);
    expect(lines[1]).toContain("2026-10-24");
    expect(lines[1]).not.toContain("T09:00");
  });

  it("un texto con punto y coma o comillas no rompe la fila", () => {
    const csv = progressCsv([
      { ...ROW, courseTitle: 'Curso; "avanzado"', pending: ["Tema 1", "Examen final"] },
    ]);
    const lines = csv.replace(CSV_BOM, "").split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(csv).toContain('"Curso; ""avanzado"""');
    expect(csv).toContain("Tema 1 · Examen final");
  });

  it("un salto de línea dentro de un campo se entrecomilla", () => {
    const csv = progressCsv([{ ...ROW, courseTitle: "Curso\ncon salto" }]);
    expect(csv).toContain('"Curso\ncon salto"');
  });
});

describe("inyección de fórmulas", () => {
  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=cmd|' /C calc'!A0"])(
    "neutraliza «%s»",
    (dangerous) => {
      const cell = toCsvCell(dangerous);
      expect(cell.startsWith("'")).toBe(true);
      expect(neutralizeFormula(dangerous).startsWith("'")).toBe(true);
    },
  );

  it("un nombre normal no se toca", () => {
    expect(toCsvCell("García López")).toBe("García López");
    expect(toCsvCell("rol1.garcia")).toBe("rol1.garcia");
    expect(toCsvCell("")).toBe("");
  });

  it("un motivo escrito como fórmula en la auditoría no llega ejecutable al fichero", () => {
    const entry: ActivityEntry = {
      id: "x",
      type: "account_disabled",
      at: "2026-10-24T09:00:00.000Z",
      actorUid: "admin-1",
      targetUid: "uid-9",
      title: "Cuenta deshabilitada",
      detail: "=HYPERLINK(\"http://mal\",\"pulsa\")",
      severity: null,
    };

    const csv = activityCsv([entry]);
    // La celda empieza por comilla: Excel la muestra como texto.
    expect(csv).toContain("'=HYPERLINK");
  });

  it("los números y los nulos no se entrecomillan", () => {
    expect(toCsvCell(0)).toBe("0");
    expect(toCsvCell(100)).toBe("100");
    expect(toCsvCell(null)).toBe("");
    expect(toCsvCell(undefined)).toBe("");
    expect(toCsvCell(Number.NaN)).toBe("");
  });
});

describe("qué sale en cada informe", () => {
  it("el progreso cuenta los intentos, no los enumera", () => {
    const lines = progressCsv([{ ...ROW, attempts: 7 }]).replace(CSV_BOM, "").split("\r\n");
    expect(lines[1]?.split(";")).toContain("7");
  });

  it("lo pendiente se une en una celda legible", () => {
    const lines = progressCsv([
      { ...ROW, completed: false, percent: 40, pending: ["Tema 2", "Examen final"] },
    ])
      .replace(CSV_BOM, "")
      .split("\r\n");
    expect(lines[1]).toContain("Tema 2 · Examen final");
    expect(lines[1]).toContain("No");
  });

  it("la actividad usa las mismas columnas declaradas y no inventa otras", () => {
    const entries: ActivityEntry[] = [
      {
        id: "a",
        type: "person_created",
        at: "2026-10-24T09:00:00.000Z",
        actorUid: "admin-1",
        targetUid: null,
        title: "Alta de una persona",
        detail: "Se creó la cuenta «rol1.garcia».",
        severity: null,
      },
    ];

    const header = activityCsv(entries).replace(CSV_BOM, "").split("\r\n")[0];
    expect(header).toBe(ACTIVITY_COLUMNS.map((column) => column.header).join(";"));

    const rows = activityRows(entries);
    expect(rows[0]).toEqual({
      at: "2026-10-24T09:00:00.000Z",
      type: "person_created",
      title: "Alta de una persona",
      actorUid: "admin-1",
      targetUid: "",
      detail: "Se creó la cuenta «rol1.garcia».",
    });
  });

  it("un evento sin fecha sale vacío, no como «null»", () => {
    const rows = activityRows([
      {
        id: null,
        type: "unknown",
        at: null,
        actorUid: null,
        targetUid: null,
        title: "Otro evento",
        detail: "…",
        severity: null,
      },
    ]);
    expect(rows[0]?.at).toBe("");
    expect(JSON.stringify(rows)).not.toContain("null");
  });

  it("las columnas de progreso no incluyen datos que no existen en el panel", () => {
    // Si alguien añade una columna con el uid o el correo, esto lo recuerda.
    const headers = PROGRESS_COLUMNS.map((column) => column.header);
    expect(headers).not.toContain("uid");
    expect(headers.some((header) => header.toLowerCase().includes("correo"))).toBe(false);
  });
});

describe("nombre del fichero", () => {
  it("sin tildes, sin espacios y con la fecha", () => {
    expect(csvFilename("Progreso del alumnado", new Date("2026-10-24T22:30:00.000Z"))).toBe(
      "progreso-del-alumnado-2026-10-24.csv",
    );
  });

  it("un nombre vacío no produce un fichero sin nombre", () => {
    expect(csvFilename("   ", new Date("2026-10-24T00:00:00.000Z"))).toBe(
      "exportacion-2026-10-24.csv",
    );
  });
});

describe("construcción genérica", () => {
  it("respeta columnas calculadas y valores nulos", () => {
    const columns: CsvColumn<{ a: string; b: number | null }>[] = [
      { header: "A", value: (row) => row.a },
      { header: "B", value: (row) => row.b },
    ];
    const csv = buildCsv([{ a: "x", b: null }], columns);
    expect(csv.replace(CSV_BOM, "")).toBe("A;B\r\nx;\r\n");
  });
});
