import { DomainError, stripDiacritics } from "@/domain/text";

export const HEADER_ROL = "Rol";
export const HEADER_APELLIDO = "Apellido";

export interface SheetLayout {
  rolColumn: number;
  apellidoColumn: number;
}

function normalizeHeaderCell(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripDiacritics(value).toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Comprueba la fila de cabecera del Excel.
 *
 * Regla de negocio: el fichero tiene **exactamente dos columnas**, `Rol` y
 * `Apellido`, en cualquier orden. Cualquier otra cosa (columnas de más,
 * cabeceras distintas, cabecera ausente) se rechaza con un mensaje explícito
 * en lugar de intentar adivinar: importar personas a medias es peor que
 * rechazar el fichero.
 */
export function parseHeaderRow(cells: readonly unknown[]): SheetLayout {
  const trimmed = [...cells];
  // Excel añade celdas vacías al final con frecuencia: se descartan.
  while (trimmed.length > 0 && normalizeHeaderCell(trimmed[trimmed.length - 1]) === "") {
    trimmed.pop();
  }

  const headers = trimmed.map(normalizeHeaderCell);

  if (headers.length === 0) {
    throw new DomainError(
      "HEADER_MISSING",
      "La primera fila debe contener las cabeceras «Rol» y «Apellido».",
    );
  }

  if (headers.length !== 2) {
    throw new DomainError(
      "HEADER_COLUMN_COUNT",
      `El fichero debe tener exactamente dos columnas («Rol» y «Apellido») y tiene ${headers.length}.`,
    );
  }

  const rolIndex = headers.indexOf(normalizeHeaderCell(HEADER_ROL));
  const apellidoIndex = headers.indexOf(normalizeHeaderCell(HEADER_APELLIDO));

  if (rolIndex === -1 || apellidoIndex === -1 || rolIndex === apellidoIndex) {
    throw new DomainError(
      "HEADER_INVALID",
      "Las cabeceras deben ser exactamente «Rol» y «Apellido» (en cualquier orden). Revisa que la primera fila no contenga datos.",
    );
  }

  return { rolColumn: rolIndex, apellidoColumn: apellidoIndex };
}
