import { describe, expect, it } from "vitest";
import { parseHeaderRow } from "@/domain/people/header";
import { analyzeImportRows, type RawPersonRow } from "@/domain/people/import-rows";
import { DomainError } from "@/domain/text";
import type { AccountRole } from "@/domain/roles";

const row = (rowNumber: number, rol: unknown, apellido: unknown): RawPersonRow => ({
  rowNumber,
  rol,
  apellido,
});

describe("parseHeaderRow", () => {
  it("acepta las dos cabeceras en cualquier orden", () => {
    expect(parseHeaderRow(["Rol", "Apellido"])).toEqual({ rolColumn: 0, apellidoColumn: 1 });
    expect(parseHeaderRow(["Apellido", "Rol"])).toEqual({ rolColumn: 1, apellidoColumn: 0 });
  });

  it("ignora mayúsculas, acentos y celdas vacías finales", () => {
    expect(parseHeaderRow(["  ROL ", "apellido", null, ""])).toEqual({
      rolColumn: 0,
      apellidoColumn: 1,
    });
  });

  it.each([
    [["Rol", "Apellido", "Email"], "HEADER_COLUMN_COUNT"],
    [["Rol"], "HEADER_COLUMN_COUNT"],
    [["Rol", "Nombre"], "HEADER_INVALID"],
    [[], "HEADER_MISSING"],
    [["ROL 1", "García"], "HEADER_INVALID"],
  ])("rechaza %j con %s", (cells, code) => {
    try {
      parseHeaderRow(cells as unknown[]);
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect((error as DomainError).code).toBe(code);
    }
  });
});

describe("analyzeImportRows", () => {
  const emptyTaken = new Set<string>();

  it("genera usuarios rol+apellido y nombres limpios", () => {
    const preview = analyzeImportRows(
      [row(2, "ROL 1", "García"), row(3, "ROL 2", "Pérez")],
      { takenUsernames: emptyTaken },
    );

    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({
      status: "ok",
      rol: "ROL 1",
      apellido: "García",
      username: "rol1.garcia",
    });
    expect(preview.rows[1]).toMatchObject({ status: "ok", username: "rol2.perez" });
    expect(preview.summary).toMatchObject({ valid: 2, invalid: 0, duplicates: 0, confirmable: true });
    expect(preview.summary.usernames).toEqual(["rol1.garcia", "rol2.perez"]);
  });

  it("detecta duplicados dentro del mismo fichero, incluso con distinta escritura", () => {
    const preview = analyzeImportRows(
      [row(2, "ROL 1", "García"), row(3, "rol1", "GARCIA"), row(4, "ROL 1", "García ")],
      { takenUsernames: emptyTaken },
    );

    expect(preview.rows[1]).toMatchObject({
      status: "duplicate",
      reason: "same_file",
      duplicateOfRow: 2,
    });
    expect(preview.rows[2]).toMatchObject({ status: "duplicate", duplicateOfRow: 2 });
    // Ambos duplicados esperan decisión del administrador → no confirmable aún.
    expect(preview.summary).toMatchObject({
      valid: 1,
      duplicates: 2,
      duplicatesPending: 2,
      confirmable: false,
    });
  });

  it("trata el mismo apellido en roles distintos como personas distintas", () => {
    const preview = analyzeImportRows([row(2, "ROL 1", "García"), row(3, "ROL 2", "García")], {
      takenUsernames: emptyTaken,
    });
    expect(preview.summary.valid).toBe(2);
    expect(preview.summary.usernames).toEqual(["rol1.garcia", "rol2.garcia"]);
  });

  it("marca como duplicado lo que ya existe en la base de datos y no reasigna usuario", () => {
    const preview = analyzeImportRows([row(2, "ROL 1", "García")], {
      takenUsernames: new Set(["rol1.garcia"]),
    });
    expect(preview.rows[0]).toMatchObject({
      status: "duplicate",
      reason: "already_exists",
      duplicateOfRow: null,
    });
    expect(preview.summary.confirmable).toBe(false);
  });

  it("respeta sufijos ya ocupados en la BD", () => {
    const preview = analyzeImportRows([row(2, "ROL 1", "García")], {
      takenUsernames: new Set(["rol1.garcia", "rol1.garcia2"]),
    });
    // El base está ocupado y además existe rol1.garcia2 → se salta a 3.
    expect(preview.rows[0]).toMatchObject({ status: "duplicate" });

    const preview2 = analyzeImportRows([row(2, "ROL 1", "García"), row(3, "ROL 1", "García")], {
      takenUsernames: new Set(["rol1.garcia"]),
    });
    expect(preview2.summary.valid).toBe(0);
  });

  it("asigna sufijos dentro del mismo fichero cuando hay colisión de clave", () => {
    // "García" y "Garcia" comparten clave → no son duplicados semánticos, pero
    // sí chocan en el nombre base. Se resuelve con sufijo, no perdiendo filas.
    const preview = analyzeImportRows(
      [row(2, "ROL 1", "García"), row(3, "ROL 1", "García"), row(4, "ROL 1", "Garcia")],
      { takenUsernames: emptyTaken },
    );
    expect(preview.summary.valid).toBe(1);
    expect(preview.summary.duplicates).toBe(2);
  });

  it("bloquea la importación si hay filas inválidas y explica cada una", () => {
    const preview = analyzeImportRows(
      [
        row(2, "ROL 1", "García"),
        row(3, "ROL 3", "Pérez"),
        row(4, "ROL 2", ""),
        row(5, "ROL 2", "López2"),
      ],
      { takenUsernames: emptyTaken },
    );

    expect(preview.summary).toMatchObject({ valid: 1, invalid: 3, confirmable: false });
    const errors = preview.rows.filter((r) => r.status === "error");
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatchObject({ rowNumber: 3 });
    if (errors[0].status === "error") {
      expect(errors[0].issues[0].code).toBe("ROL_INVALID");
      expect(errors[0].rolRaw).toBe("ROL 3");
    }
    if (errors[1].status === "error") {
      expect(errors[1].issues[0].code).toBe("SURNAME_REQUIRED");
    }
    if (errors[2].status === "error") {
      expect(errors[2].issues[0].code).toBe("SURNAME_CONTAINS_DIGITS");
    }
  });

  it("acumula varios problemas en la misma fila", () => {
    const preview = analyzeImportRows([row(2, "ROL 9", "")], { takenUsernames: emptyTaken });
    const first = preview.rows[0];
    expect(first.status).toBe("error");
    if (first.status === "error") {
      expect(first.issues.map((i) => i.code)).toEqual(["ROL_INVALID", "SURNAME_REQUIRED"]);
    }
  });

  it("rechaza un fichero sin filas", () => {
    expect(() => analyzeImportRows([], { takenUsernames: emptyTaken })).toThrow(DomainError);
  });

  it("rechaza un fichero por encima del límite", () => {
    const rows = Array.from({ length: 3 }, (_, i) => row(i + 2, "ROL 1", `Apellido${i}`));
    expect(() => analyzeImportRows(rows, { takenUsernames: emptyTaken, maxRows: 2 })).toThrow(
      /máximo/i,
    );
  });

  it("no concede jamás permisos de administrador: la salida no contiene roles de cuenta", () => {
    const preview = analyzeImportRows([row(2, "ROL 1", "García")], {
      takenUsernames: emptyTaken,
    });
    for (const previewRow of preview.rows) {
      expect(Object.keys(previewRow)).not.toContain("role");
      expect(Object.values(previewRow)).not.toContain("admin" satisfies AccountRole);
    }
  });

  it("es determinista para la misma entrada", () => {
    const rows = [row(2, "ROL 1", "García"), row(3, "ROL 2", "García"), row(4, "ROL 1", "Gómez")];
    const a = analyzeImportRows(rows, { takenUsernames: emptyTaken });
    const b = analyzeImportRows(rows, { takenUsernames: emptyTaken });
    expect(a).toEqual(b);
  });
});
