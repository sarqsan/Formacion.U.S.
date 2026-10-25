import { extractText, getDocumentProxy } from "unpdf";
import { DomainError } from "@/domain/text";

/**
 * TEXTO DEL PDF, PÁGINA A PÁGINA (solo servidor)
 * ==============================================
 *
 * Gemini sabe leer un PDF porque lo «ve». Los demás proveedores —Groq, y
 * cualquier API compatible con OpenAI— **solo entienden texto**: si se les manda
 * un PDF, lo rechazan. Este módulo hace ese trabajo antes de llamar al modelo:
 * abre el documento y devuelve las letras de cada página, numeradas.
 *
 * Tres reglas que se sostienen aquí:
 *
 *   · **la numeración es la del PDF**, no la de la lista: la página 7 sigue
 *     llamándose 7 aunque el trozo empiece en ella, para que las citas de la
 *     pantalla sigan apuntando al documento real;
 *   · **nunca se inventa texto**: si el PDF es un escaneo, no hay letras y se
 *     dice con un error claro en vez de mandar una página vacía al modelo;
 *   · **el tamaño se mide en caracteres**, no en tokens: es una estimación
 *     (≈4 caracteres por token) suficiente para trocear con margen.
 */

export interface PdfTextPage {
  /** Número de página tal y como aparece en el documento (desde 1). */
  page: number;
  text: string;
}

export interface PdfText {
  pages: PdfTextPage[];
  totalPages: number;
  /** Caracteres con texto (sin contar los espacios normalizados). */
  chars: number;
  /** Páginas de las que no se pudo sacar ni una letra. */
  emptyPages: number[];
}

/** Tokens aproximados de un texto: ~4 caracteres por token en español. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Abre el PDF y devuelve el texto de cada página.
 *
 * Lanza `PDF_WITHOUT_TEXT` (422) cuando **ninguna** página tiene letras: es el
 * caso del escaneo sin reconocimiento, y el mensaje tiene que explicarlo, porque
 * el administrador no puede adivinarlo.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  if (bytes.length === 0) {
    throw new DomainError("AI_INPUT_EMPTY", "El PDF está vacío: no hay nada que analizar.", 400);
  }

  let totalPages = 0;
  let raw: string[] = [];
  try {
    const document = await getDocumentProxy(bytes);
    const result = await extractText(document, { mergePages: false });
    totalPages = result.totalPages;
    raw = result.text;
  } catch (error) {
    throw new DomainError(
      "AI_PDF_UNREADABLE",
      `No se pudo leer el PDF para extraer su texto (${(error as Error)?.message ?? "documento dañado"}). Comprueba que el fichero se abre bien y vuelve a intentarlo.`,
      422,
    );
  }

  const pages: PdfTextPage[] = raw.map((text, index) => ({
    page: index + 1,
    text: normalize(text ?? ""),
  }));

  const emptyPages = pages.filter((page) => page.text === "").map((page) => page.page);
  const chars = pages.reduce((total, page) => total + page.text.length, 0);

  if (chars === 0) {
    throw new DomainError(
      "PDF_WITHOUT_TEXT",
      "El PDF no tiene texto: parece un escaneo o una foto. La IA que está configurada solo puede leer texto, no imágenes. Sube un PDF con texto seleccionable (por ejemplo, exportado desde el programa con el que se escribió el temario).",
      422,
    );
  }

  return { pages, totalPages: totalPages || pages.length, chars, emptyPages };
}

/** Texto con la página delante: la única forma de que el modelo pueda citarla. */
export function renderPages(pages: readonly PdfTextPage[]): string {
  return pages
    .filter((page) => page.text !== "")
    .map((page) => `[Página ${page.page}]\n${page.text}`)
    .join("\n\n");
}

/** Páginas concretas, en el orden del documento. */
export function selectPages(
  pages: readonly PdfTextPage[],
  wanted: readonly number[],
): PdfTextPage[] {
  if (wanted.length === 0) return [...pages];
  const set = new Set(wanted);
  return pages.filter((page) => set.has(page.page));
}

/**
 * Reparte las páginas en tandas que no pasen de `maxChars`.
 *
 * Se corta **por páginas enteras**, nunca a mitad de una: una frase partida es
 * una cita que el modelo no puede localizar. Si una sola página supera el
 * máximo, va sola en su tanda (y el llamante decide si eso es aceptable).
 */
export function chunkPages(
  pages: readonly PdfTextPage[],
  maxChars: number,
): PdfTextPage[][] {
  const limit = Math.max(1, Math.floor(maxChars));
  const chunks: PdfTextPage[][] = [];
  let current: PdfTextPage[] = [];
  let size = 0;

  for (const page of pages) {
    const length = page.text.length + 16; // margen por la etiqueta «[Página N]».
    if (current.length > 0 && size + length > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
