import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  assertXlsxBuffer,
  parsePeopleWorkbook,
} from "@/server/import/excel";
import { DomainError } from "@/domain/text";
import { buildXlsx } from "../helpers/xlsx-fixture";

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`debería haber lanzado ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("parsePeopleWorkbook", () => {
  it("lee un Excel real de dos columnas y conserva el número de fila", async () => {
    const buffer = buildXlsx([
      ["Rol", "Apellido"],
      ["ROL 1", "García"],
      ["ROL 2", "Pérez"],
    ]);

    const parsed = await parsePeopleWorkbook(buffer);
    expect(parsed.layout).toEqual({ rolColumn: 0, apellidoColumn: 1 });
    expect(parsed.rows).toEqual([
      { rowNumber: 2, rol: "ROL 1", apellido: "García" },
      { rowNumber: 3, rol: "ROL 2", apellido: "Pérez" },
    ]);
    expect(parsed.skippedEmptyRows).toBe(0);
  });

  it("detecta las columnas aunque estén en otro orden", async () => {
    const buffer = buildXlsx([
      ["Apellido", "Rol"],
      ["García", "ROL 1"],
    ]);

    const parsed = await parsePeopleWorkbook(buffer);
    expect(parsed.layout).toEqual({ rolColumn: 1, apellidoColumn: 0 });
    expect(parsed.rows[0]).toEqual({ rowNumber: 2, rol: "ROL 1", apellido: "García" });
  });

  it("descarta filas completamente vacías sin perder la numeración real", async () => {
    const buffer = buildXlsx([
      ["Rol", "Apellido"],
      ["ROL 1", "García"],
      [null, null],
      ["ROL 2", "Pérez"],
    ]);

    const parsed = await parsePeopleWorkbook(buffer);
    expect(parsed.skippedEmptyRows).toBe(1);
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
  });

  it("convierte celdas numéricas en valores que la validación rechaza con mensaje", async () => {
    const buffer = buildXlsx([
      ["Rol", "Apellido"],
      ["ROL 1", 2024],
    ]);

    const parsed = await parsePeopleWorkbook(buffer);
    expect(parsed.rows[0].apellido).toBe(2024);
  });

  it("rechaza cabeceras incorrectas", async () => {
    await expectCode(
      parsePeopleWorkbook(buildXlsx([["Rol", "Nombre"], ["ROL 1", "García"]])),
      "HEADER_INVALID",
    );
  });

  it("rechaza ficheros con más de dos columnas", async () => {
    await expectCode(
      parsePeopleWorkbook(
        buildXlsx([["Rol", "Apellido", "Email"], ["ROL 1", "García", "x@y.com"]]),
      ),
      "HEADER_COLUMN_COUNT",
    );
  });

  it("rechaza un fichero que no es xlsx", async () => {
    await expectCode(parsePeopleWorkbook(Buffer.from("Rol,Apellido\nROL 1,García")), "UPLOAD_NOT_XLSX");
  });

  it("rechaza un archivo vacío", async () => {
    await expectCode(parsePeopleWorkbook(Buffer.alloc(0)), "UPLOAD_EMPTY");
  });

  it("rechaza ficheros demasiado grandes antes de descomprimir", () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    big[0] = 0x50;
    big[1] = 0x4b;
    big[2] = 0x03;
    big[3] = 0x04;
    try {
      assertXlsxBuffer(big);
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect((error as DomainError).code).toBe("UPLOAD_TOO_LARGE");
    }
  });

  it("rechaza un zip que no es un libro de Excel", async () => {
    const fakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
    await expect(parsePeopleWorkbook(fakeZip)).rejects.toBeInstanceOf(DomainError);
  });
});
