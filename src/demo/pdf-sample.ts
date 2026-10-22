import { createHash } from "node:crypto";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import type { PdfMemoryState } from "@/demo/pdf-store";

/**
 * PDF DE EJEMPLO PARA LA DEMOSTRACIÓN
 * ===================================
 *
 * La demostración necesita documentos que se puedan abrir de verdad con el
 * visor del navegador. No hay PDF reales en el repositorio (no se versionan
 * documentos), así que se **genera** uno mínimo cuando arranca el proceso:
 *
 *   - PDF 1.4 sin comprimir, una página por página declarada;
 *   - una fuente Helvetica estándar, texto en ASCII;
 *   - tabla `xref` con desplazamientos reales y `startxref` (si estuviera mal,
 *     el navegador podría negarse a abrirlo).
 *
 * Es contenido sintético de demostración, no un visor ni una librería PDF: no
 * se interpreta ni se convierte nada. Los documentos reales los sube la
 * administración por partes (bloque 06) y se sirven tal cual.
 */

export interface SamplePdf {
  bytes: Uint8Array;
  pages: number;
}

/** Texto seguro para una cadena PDF: ASCII y paréntesis/barra escapados. */
function pdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\()]/g, (character) => `\\${character}`)
    .replace(/[^\x20-\x7E]/g, " ");
}

function textLines(title: string, page: number, total: number, lines: string[]): string {
  const head = `BT /F1 20 Tf 60 780 Td (${pdfText(title)}) Tj ET`;
  const sub = `BT /F1 11 Tf 60 755 Td (${pdfText(`Pagina ${page} de ${total} - documento de demostracion`)}) Tj ET`;
  const body = lines
    .slice(0, 12)
    .map((line, index) => `BT /F1 12 Tf 60 ${720 - index * 22} Td (${pdfText(line)}) Tj ET`)
    .join("\n");
  return [head, sub, body].filter(Boolean).join("\n");
}

/**
 * Construye un PDF válido con `pages` páginas.
 *
 * Los desplazamientos de la tabla `xref` se calculan sobre los bytes ya
 * escritos, que es la única forma de que el fichero sea abrible: un `xref`
 * inventado hace que el lector no encuentre los objetos.
 */
export function buildSamplePdf(input: {
  title: string;
  pages: number;
  lines?: string[];
}): SamplePdf {
  const pages = Math.max(1, Math.min(input.pages, 50));
  const lines = input.lines ?? [
    "Este documento se ha generado para la demostracion de Formacion UG-US.",
    "Los documentos reales se suben por partes y se verifican con SHA-256.",
  ];

  // 1 catálogo, 2 páginas, 3 fuente; después, por página: objeto de página y
  // objeto de contenido.
  const pageObjectIds = Array.from({ length: pages }, (_, index) => 4 + index * 2);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pageObjectIds.forEach((pageId, index) => {
    const contentId = pageId + 1;
    const stream = textLines(input.title, index + 1, pages, lines);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  let body = header;
  const offsets = new Map<number, number>();

  for (let id = 1; id < objects.length; id += 1) {
    offsets.set(id, Buffer.byteLength(body, "latin1"));
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "latin1");
  const total = objects.length; // ids 1..total-1 usados; Size = total
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return { bytes: new Uint8Array(Buffer.from(body + xref + trailer, "latin1")), pages };
}

/**
 * Siembra un PDF de ejemplo por cada documento del contenido de demostración.
 *
 * Se hace sin pasar por la subida (no hay navegador ni partes) pero con el
 * **mismo estado final** que produce una subida verificada: documento `active`,
 * una parte, SHA-256 calculado y cuota contabilizada. Así el alumnado de la
 * demostración puede abrir el PDF con el visor del navegador desde el primer
 * arranque, sin depender de que alguien lo suba antes.
 */
export function seedDemoPdfs(state: PdfMemoryState, definitions: CourseVersionDefinition[]): void {
  const documentTitles = new Map<
    string,
    { title: string; pageCount: number; version: number; courseId: string; topicId: string }
  >();

  for (const definition of definitions) {
    for (const topic of definition.topics) {
      for (const document of topic.documents) {
        // Gana la primera aparición (las versiones publicadas van antes en el
        // contenido de la demo); el documento es el mismo activo en todas.
        if (documentTitles.has(document.id)) continue;
        documentTitles.set(document.id, {
          title: document.title,
          pageCount: document.pageCount,
          version: definition.version,
          courseId: definition.courseId,
          topicId: topic.id,
        });
      }
    }
  }

  for (const [documentId, info] of documentTitles) {
    const sample = buildSamplePdf({ title: info.title, pages: info.pageCount });
    const bytes = sample.bytes;
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    state.metas.set(documentId, {
      documentId,
      courseId: info.courseId,
      version: info.version,
      topicId: info.topicId,
      title: info.title,
      pageCount: sample.pages,
      bytes: bytes.length,
      sha256,
      chunkLengths: [bytes.length],
      uploadedBy: "demo-admin",
      uploadedAt: "2026-01-05T09:00:00.000Z",
      state: "active",
      partsReceived: 1,
      finalizedAt: "2026-01-05T09:00:00.000Z",
      abortedAt: null,
    });
    state.chunks.set(`${documentId}_0`, bytes);
    state.usedBytes += bytes.length;
  }
}
