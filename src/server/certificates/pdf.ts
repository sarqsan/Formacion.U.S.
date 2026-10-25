import type { CertificateText } from "@/domain/certificates/certificate";

/**
 * GENERADOR DE PDF (sin dependencias)
 * ===================================
 *
 * El proyecto no tiene ninguna biblioteca de PDF y añadir una para una sola
 * página sería desproporcionado (y otra dependencia que auditar). Un PDF de una
 * página con texto es un formato muy pequeño y perfectamente escribible a mano:
 * unos objetos, un flujo de contenido y una tabla de referencias cruzadas.
 *
 * Lo que hay que hacer bien, y donde se rompen las implementaciones caseras:
 *
 *   · **Los desplazamientos de la tabla `xref` son en bytes, no en caracteres.**
 *     Se calculan mientras se construye el fichero, en `Buffer`, no con
 *     longitudes de cadena (una «á» ocupa dos bytes en UTF-8 y uno en WinAnsi).
 *   · **La codificación es WinAnsi**, que es la que entienden las fuentes
 *     estándar (Helvetica). El texto se convierte a latin1 y se sustituyen las
 *     comillas tipográficas y las rayas, que no existen en esa tabla.
 *   · **Los paréntesis y la barra invertida se escapan** dentro de las cadenas:
 *     sin eso, un título con «(» rompe el documento.
 *
 * Lo que **no** hace: firmar digitalmente, incrustar fuentes ni comprimir. No es
 * un documento con validez criptográfica; la verificación es el código.
 */

/** A4 en puntos PostScript (1 pt = 1/72 pulgada). */
export const PAGE_WIDTH = 595;
export const PAGE_HEIGHT = 842;
const MARGIN = 64;

/**
 * Anchuras de Helvetica (unidades de 1/1000 em) para los caracteres imprimibles.
 * Se usan para centrar y para partir líneas; sin tabla, cualquier texto largo
 * se sale del marco.
 */
const HELVETICA_WIDTHS: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778,
  R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  "[": 278, "\\": 278, "]": 278, "^": 469, _: 556, "`": 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222,
  j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "{": 334, "|": 260, "}": 334, "~": 584,
};

/** Las mayúsculas acentuadas y las minúsculas comparten anchura con su base. */
const ACCENT_BASE: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", é: "e", è: "e", ë: "e", ê: "e",
  í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o",
  ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c",
  Á: "A", À: "A", Ä: "A", Â: "A", É: "E", È: "E", Ë: "E", Ê: "E",
  Í: "I", Ì: "I", Ï: "I", Î: "I", Ó: "O", Ò: "O", Ö: "O", Ô: "O",
  Ú: "U", Ù: "U", Ü: "U", Û: "U", Ñ: "N", Ç: "C",
  "«": '"', "»": '"', "·": ".", "–": "-", "—": "-", "’": "'", "‘": "'",
  "“": '"', "”": '"', "…": ".",
};

/** Ancho aproximado de un texto con Helvetica (o negrita, ~6 % más ancha). */
export function measureText(text: string, size: number, bold = false): number {
  let units = 0;
  for (const character of text) {
    const base = ACCENT_BASE[character] ?? character;
    units += HELVETICA_WIDTHS[base] ?? 556;
  }
  const factor = bold ? 1.06 : 1;
  return (units / 1000) * size * factor;
}

/**
 * Texto a latin1 (lo que entiende WinAnsi).
 *
 * Los caracteres que no existen en esa tabla se sustituyen por un espacio en
 * lugar de romper el fichero: un certificado con un nombre exótico debe salir
 * legible, no corrupto.
 */
export function toWinAnsi(text: string): string {
  return [...text]
    .map((character) => {
      // Todo lo que cabe en un byte (incluidas «», ·, ¿ y ¡) se queda tal cual:
      // WinAnsi y latin1 coinciden en ese rango y así no se pierde la
      // tipografía castellana.
      const code = character.codePointAt(0) ?? 32;
      if (code <= 255) return character;
      // Fuera de ese rango solo hay equivalentes razonables (rayas, comillas
      // tipográficas, puntos suspensivos); lo demás no se puede representar.
      return ACCENT_BASE[character] ?? "?";
    })
    .join("");
}

/** Escapa una cadena para el operador `(...)` de PDF. */
export function escapePdfString(text: string): string {
  return toWinAnsi(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Parte un texto en líneas que caben en `maxWidth`. */
export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // Una palabra sola más ancha que la caja se parte por caracteres.
    if (measureText(word, size, bold) > maxWidth) {
      let piece = "";
      for (const character of word) {
        if (measureText(piece + character, size, bold) > maxWidth && piece) {
          lines.push(piece);
          piece = character;
        } else {
          piece += character;
        }
      }
      current = piece;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface Draw {
  x: number;
  y: number;
  size: number;
  text: string;
  bold?: boolean;
  center?: boolean;
  gray?: number;
}

function textOperation(draw: Draw): string {
  const font = draw.bold ? "/F2" : "/F1";
  const x = draw.center
    ? (PAGE_WIDTH - measureText(draw.text, draw.size, draw.bold)) / 2
    : draw.x;
  const color = draw.gray === undefined ? "0 g" : `${draw.gray} g`;
  return `BT ${color} ${font} ${draw.size} Tf 1 0 0 1 ${x.toFixed(2)} ${draw.y.toFixed(2)} Tm (${escapePdfString(
    draw.text,
  )}) Tj ET`;
}

/**
 * Compone la página del certificado.
 *
 * La maquetación es deliberadamente sobria: marco, cabecera, título, nombre,
 * texto del curso, una línea y el pie con el código. Nada que no esté en los
 * datos.
 */
export function certificatePdf(text: CertificateText): Uint8Array {
  const content: string[] = [];
  const innerWidth = PAGE_WIDTH - MARGIN * 2;

  // Marco doble: uno fino exterior y otro interior algo más separado.
  content.push(`0.20 0.30 0.25 RG 2 w ${MARGIN / 2} ${MARGIN / 2} ${PAGE_WIDTH - MARGIN} ${PAGE_HEIGHT - MARGIN} re S`);
  content.push(`0.60 0.66 0.62 RG 0.6 w ${MARGIN / 2 + 8} ${MARGIN / 2 + 8} ${PAGE_WIDTH - MARGIN - 16} ${PAGE_HEIGHT - MARGIN - 16} re S`);

  let y = PAGE_HEIGHT - 150;

  for (const line of wrapText(text.heading.toUpperCase(), 11, innerWidth, true)) {
    content.push(textOperation({ x: 0, y, size: 11, text: line, bold: true, center: true, gray: 0.35 }));
    y -= 16;
  }

  y -= 30;
  for (const line of wrapText(text.title, 26, innerWidth, true)) {
    content.push(textOperation({ x: 0, y, size: 26, text: line, bold: true, center: true }));
    y -= 32;
  }

  y -= 22;
  content.push(textOperation({ x: 0, y, size: 12, text: "Se certifica que", center: true, gray: 0.35 }));
  y -= 34;

  for (const line of wrapText(text.holder, 22, innerWidth, true)) {
    content.push(textOperation({ x: 0, y, size: 22, text: line, bold: true, center: true }));
    y -= 28;
  }

  y -= 18;
  for (const line of wrapText(text.body, 12, innerWidth)) {
    content.push(textOperation({ x: 0, y, size: 12, text: line, center: true }));
    y -= 18;
  }

  // Línea de separación y pie.
  const ruleY = MARGIN + 128;
  content.push(`0.60 0.66 0.62 RG 0.6 w ${MARGIN + 40} ${ruleY} m ${PAGE_WIDTH - MARGIN - 40} ${ruleY} l S`);

  let footerY = ruleY - 22;
  for (const line of wrapText(text.footer, 9, innerWidth)) {
    content.push(textOperation({ x: 0, y: footerY, size: 9, text: line, center: true, gray: 0.4 }));
    footerY -= 12;
  }

  footerY -= 8;
  for (const line of wrapText(text.verification, 9, innerWidth, true)) {
    content.push(textOperation({ x: 0, y: footerY, size: 9, text: line, bold: true, center: true }));
    footerY -= 12;
  }

  return assemble(content.join("\n"));
}

/** Monta los objetos, calcula la tabla `xref` en bytes y cierra el fichero. */
function assemble(stream: string): Uint8Array {
  const streamBytes = Buffer.from(stream, "latin1");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    null, // el flujo se escribe aparte, con su longitud real
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];

  const header = Buffer.from("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n", "latin1");
  const chunks: Buffer[] = [header];
  let offset = header.length;

  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const number = index + 1;
    offsets.push(offset);

    const chunk =
      body === null
        ? Buffer.concat([
            Buffer.from(`${number} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n`, "latin1"),
            streamBytes,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ])
        : Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, "latin1");

    chunks.push(chunk);
    offset += chunk.length;
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const position of offsets) {
    xref += `${String(position).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
