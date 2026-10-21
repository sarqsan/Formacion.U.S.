import { DomainError } from "@/domain/text";
import { MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";

/**
 * Lectura del formulario de subida de PDF.
 *
 * Solo se aceptan los campos declarados aquí. Cualquier otro dato que envíe el
 * cliente (bytes ya troceados, cuota, hash, uid del autor…) se ignora: el
 * servidor calcula el troceado y la huella a partir del fichero.
 */

const MAX_FORM_BYTES = MAX_PDF_BYTES + 256 * 1024;

export interface PdfUploadForm {
  courseId: string;
  version: number;
  topicId: string;
  documentId: string;
  title: string;
  pageCount: number;
  bytes: Uint8Array;
}

function requiredText(form: FormData, name: string, message: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("FORM_FIELD_MISSING", message, 400);
  }
  return value.trim();
}

function requiredInteger(form: FormData, name: string, message: string): number {
  const raw = requiredText(form, name, message);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new DomainError("FORM_FIELD_INVALID", message, 400);
  }
  return value;
}

export async function readPdfUploadForm(request: Request): Promise<PdfUploadForm> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Se esperaba multipart/form-data.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      "El PDF supera el tamaño máximo permitido en una subida.",
      413,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new DomainError("FORM_INVALID", "No se ha podido leer el formulario.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new DomainError("FILE_MISSING", "Adjunta el PDF en el campo «file».", 400);
  }
  if (file.size === 0) {
    throw new DomainError("PDF_EMPTY", "El fichero está vacío.", 400);
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      "El PDF supera el tamaño máximo permitido en una subida.",
      413,
    );
  }

  return {
    courseId: requiredText(form, "courseId", "Falta el curso."),
    version: requiredInteger(form, "version", "Falta la versión del curso."),
    topicId: requiredText(form, "topicId", "Falta el tema."),
    documentId: requiredText(form, "documentId", "Falta el identificador del documento."),
    title: requiredText(form, "title", "Falta el título del documento."),
    pageCount: requiredInteger(form, "pageCount", "Falta el número de páginas."),
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

/**
 * Páginas pedidas en la query (`from` y `to`, inclusive).
 *
 * Aquí solo se comprueba que son enteros: el orden, el rango real y el límite
 * de páginas por petición los valida el servicio contra el documento y el
 * progreso guardados. El cliente **no** puede elegir qué es válido.
 */
export function readPagesQuery(request: Request): { from: number; to: number } {
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");

  // Un parámetro vacío no es "0": `Number("")` daría 0 y pediría la página 0
  // como si fuera válida. Se rechaza antes de llegar al servicio.
  const from = rawFrom === null || rawFrom.trim() === "" ? Number.NaN : Number(rawFrom);
  const to = rawTo === null || rawTo.trim() === "" ? Number.NaN : Number(rawTo);

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new DomainError(
      "PAGE_INVALID",
      "Indica las páginas con `from` y `to` enteros.",
      400,
    );
  }

  return { from, to };
}
