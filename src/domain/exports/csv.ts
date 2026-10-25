/**
 * EXPORTACIÓN A CSV (para abrir en Excel)
 * =======================================
 *
 * Lo que se descarga desde el panel se abre en el Excel de una oficina
 * cualquiera, y eso impone tres detalles que no son cosméticos:
 *
 *   · **Punto y coma como separador.** El Excel en español espera `;`, no `,`;
 *     con coma, cada fila entera acaba en una sola celda.
 *   · **BOM UTF-8 al principio.** Sin él, Excel lee los acentos como `Ã¡` y
 *     «García» se convierte en basura. El BOM es lo que hace que abra bien sin
 *     pedirle nada al usuario.
 *   · **Fin de línea CRLF**, que es lo que espera Excel; con `\n` hay versiones
 *     que pegan las filas.
 *
 * Y una cuarta que es de seguridad, no de formato: **inyección de fórmulas**.
 * Excel interpreta como fórmula cualquier celda que empiece por `=`, `+`, `-` o
 * `@`. Un apellido o un motivo escrito así (`=HYPERLINK(...)`, `=cmd|...`) se
 * ejecutaría al abrir el fichero. Por eso esos valores se neutralizan con una
 * comilla delante, que Excel muestra como texto y no evalúa.
 */

/** Separador de columnas. Ver arriba: el Excel en español usa `;`. */
export const CSV_DELIMITER = ";";

/** Excel necesita CRLF para separar filas en todas las versiones. */
export const CSV_NEWLINE = "\r\n";

/** Marca de orden de bytes: sin ella, Excel rompe los acentos. */
export const CSV_BOM = "\uFEFF";

export interface CsvColumn<T> {
  /** Cabecera tal cual se ve en Excel. */
  header: string;
  /** Cómo se obtiene el valor de cada fila. */
  value: (row: T) => string | number | boolean | null | undefined;
}

/** Caracteres con los que Excel empieza a interpretar una fórmula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutraliza una celda peligrosa para Excel.
 *
 * Solo se aplica a texto: un número negativo exportado como número no debe
 * llevar comilla (y aquí no exportamos negativos).
 */
export function neutralizeFormula(value: string): string {
  if (value === "") return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** ¿Hay que entrecomillar? Sí si el valor contiene separador, comilla o salto. */
function needsQuotes(value: string): boolean {
  return (
    value.includes(CSV_DELIMITER) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  );
}

/** Comillas dobles dentro de un campo entrecomillado se duplican (RFC 4180). */
function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Convierte un valor en celda segura. */
export function toCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "Sí" : "No";

  let text = value;
  // Un texto que empieza por espacios también se interpreta como fórmula en
  // algunas versiones de Excel: se mira el valor ya recortado.
  if (text.trimStart() !== text) text = text.trim();
  text = neutralizeFormula(text);

  return needsQuotes(text) ? quote(text) : text;
}

/**
 * Construye el CSV completo, con BOM, cabecera y una fila por elemento.
 *
 * Es una función pura: no toca red, ni disco, ni reloj. Así se puede probar el
 * fichero exacto que se descarga, byte a byte.
 */
export function buildCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [
    columns.map((column) => toCsvCell(column.header)).join(CSV_DELIMITER),
  ];

  for (const row of rows) {
    lines.push(
      columns.map((column) => toCsvCell(column.value(row))).join(CSV_DELIMITER),
    );
  }

  return CSV_BOM + lines.join(CSV_NEWLINE) + CSV_NEWLINE;
}

/**
 * Nombre de fichero seguro y con fecha.
 *
 * Sin tildes, sin espacios y sin barras: un `Content-Disposition` con caracteres
 * raros se rompe en algunos navegadores. La fecha va en ISO para que los
 * ficheros de semanas distintas no se pisen.
 */
export function csvFilename(base: string, now: Date): string {
  const clean = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const stamp = now.toISOString().slice(0, 10);
  return `${clean || "exportacion"}-${stamp}.csv`;
}
