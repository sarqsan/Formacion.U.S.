/**
 * PDF MINÚSCULO PARA PRUEBAS
 * =========================
 *
 * Construye un PDF válido en memoria, con una página por cada lista de líneas.
 * Sirve para probar la extracción de texto sin arrastrar un binario al
 * repositorio y sin escribir en disco.
 *
 * No es un generador de PDF: solo lo justo —catálogo, páginas, una fuente
 * Helvetica y un flujo de texto por página— con la tabla `xref` calculada a
 * mano, que es lo que hace que el lector lo acepte como documento real.
 */
export function buildPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  const pageNumbers = pages.map((_, index) => 3 + index * 2);
  const fontNumber = 3 + pages.length * 2;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageNumbers
    .map((number) => `${number} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;

  pages.forEach((lines, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Contents ${contentNumber} 0 R /Resources << /Font << /F1 ${fontNumber} 0 R >> >> >>`;

    const stream = `BT /F1 12 Tf 40 800 Td ${lines
      .map((line, lineIndex) => `${lineIndex ? "0 -16 Td " : ""}(${escapeText(line)}) Tj`)
      .join(" ")} ET`;
    objects[contentNumber] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontNumber] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index] === undefined) continue;
    offsets[index] = out.length;
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefStart = out.length;
  const size = objects.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let index = 1; index < size; index += 1) {
    out += `${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // `latin1`: cada carácter ocupa un byte, así los desplazamientos del `xref`
  // coinciden con los del fichero.
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** Un PDF con páginas y sin ninguna letra: el caso del escaneo. */
export function buildBlankPdf(pageCount: number): Uint8Array {
  return buildPdf(Array.from({ length: pageCount }, () => [" "]));
}

function escapeText(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
