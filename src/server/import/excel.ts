import { readSheet } from "read-excel-file/node";
import { DomainError } from "@/domain/text";
import { parseHeaderRow, type SheetLayout } from "@/domain/people/header";
import type { RawPersonRow } from "@/domain/people/import-rows";

/**
 * LECTURA DEL EXCEL DE PERSONAS
 * =============================
 *
 * Solo se acepta `.xlsx` (Office Open XML). `.xls` (formato binario antiguo)
 * y CSV quedan fuera: el primero necesita otra librería con historial de
 * vulnerabilidades y el segundo no puede distinguir roles con seguridad.
 * El rechazo es explícito y con mensaje accionable.
 */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_DATA_ROWS = 2000;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

export interface ParsedPeopleWorkbook {
  layout: SheetLayout;
  rows: RawPersonRow[];
  /** Filas vacías encontradas y descartadas (informativo). */
  skippedEmptyRows: number;
}

export function assertXlsxBuffer(buffer: Buffer): void {
  if (buffer.length === 0) {
    throw new DomainError("UPLOAD_EMPTY", "El archivo está vacío.");
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      `El archivo supera el máximo de ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      413,
    );
  }
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new DomainError(
      "UPLOAD_NOT_XLSX",
      "El archivo no es un Excel .xlsx válido. Si es .xls antiguo o CSV, guárdalo como .xlsx.",
    );
  }
}

function isEmptyCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Convierte el libro en filas de personas.
 *
 * Solo se lee la PRIMERA hoja, y la fila 1 debe ser la cabecera. Cada fila de
 * datos conserva su número de fila de Excel (1-based) para que la vista previa
 * señale exactamente dónde está el problema.
 */
export async function parsePeopleWorkbook(buffer: Buffer): Promise<ParsedPeopleWorkbook> {
  assertXlsxBuffer(buffer);

  let sheet: unknown[][];
  try {
    sheet = (await readSheet(buffer)) as unknown as unknown[][];
  } catch (error) {
    throw new DomainError(
      "UPLOAD_UNREADABLE",
      "No se ha podido leer el Excel. Comprueba que no está dañado ni protegido con contraseña.",
      error instanceof Error && /password/i.test(error.message) ? 422 : 400,
    );
  }

  if (!Array.isArray(sheet) || sheet.length === 0) {
    throw new DomainError("UPLOAD_EMPTY_SHEET", "La primera hoja del Excel está vacía.");
  }

  const headerCells = sheet[0] ?? [];
  const layout = parseHeaderRow(headerCells);

  const rows: RawPersonRow[] = [];
  let skippedEmptyRows = 0;

  for (let index = 1; index < sheet.length; index += 1) {
    const cells = sheet[index] ?? [];
    const rol = cells[layout.rolColumn];
    const apellido = cells[layout.apellidoColumn];

    if (isEmptyCell(rol) && isEmptyCell(apellido)) {
      skippedEmptyRows += 1;
      continue;
    }

    rows.push({ rowNumber: index + 1, rol: rol ?? null, apellido: apellido ?? null });
  }

  if (rows.length > MAX_DATA_ROWS) {
    throw new DomainError(
      "IMPORT_TOO_LARGE",
      `El fichero supera el máximo de ${MAX_DATA_ROWS} filas por importación.`,
      413,
    );
  }

  return { layout, rows, skippedEmptyRows };
}
