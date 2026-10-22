import { z } from "zod";
import { DomainError } from "@/domain/text";
import { MAX_PAGES, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";
import { SHA256_HEX, UPLOAD_PART_BYTES } from "@/domain/storage/pdf-upload";
import { readJsonBody } from "@/server/http";

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
    // El identificador del documento NO se lee del formulario: lo calcula el
    // servidor a partir del contenido. Si el cliente manda uno, se ignora.
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


// ---------------------------------------------------------------------------
// Subida por partes (bloque 06)
// ---------------------------------------------------------------------------

/**
 * Cuerpo de `POST /api/admin/documents/uploads`.
 *
 * `strictObject`: cualquier campo que no esté aquí (por ejemplo un
 * `documentId` elegido por el cliente, un `state`, una cuota o un `uploadedBy`)
 * hace fallar la petición en lugar de ignorarse en silencio. Los identificadores
 * y el autor los pone el servidor.
 */
const createUploadSchema = z.strictObject({
  courseId: z.string().trim().min(1).max(64),
  version: z.coerce.number().int().min(1),
  topicId: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  pageCount: z.coerce.number().int().min(1).max(MAX_PAGES),
  bytes: z.coerce.number().int().min(1).max(MAX_PDF_BYTES),
  sha256: z.string().regex(SHA256_HEX),
});

export interface CreateUploadBody {
  courseId: string;
  version: number;
  topicId: string;
  title: string;
  pageCount: number;
  bytes: number;
  sha256: string;
}

export async function readCreateUploadBody(request: Request): Promise<CreateUploadBody> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("BODY_INVALID", "El cuerpo de la petición no es JSON válido.");
  }

  const parsed = createUploadSchema.safeParse(body);
  if (!parsed.success) {
    throw new DomainError(
      "UPLOAD_BODY_INVALID",
      "Faltan datos de la subida o sobran campos que no se aceptan (el identificador y el autor los pone el servidor).",
      400,
      { issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(raíz)") },
    );
  }

  return parsed.data;
}

/**
 * Bytes de una parte: `application/octet-stream` sin envoltorio.
 *
 * Se comprueban dos tamaños: el declarado en `Content-Length` (para rechazar
 * pronto un cuerpo enorme, antes de leerlo) y el real, que además tiene que ser
 * exactamente el de esa parte (lo valida el servicio con el tamaño declarado
 * del documento).
 */
export async function readPartBytes(request: Request): Promise<Uint8Array> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/octet-stream")) {
    throw new DomainError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Cada parte se envía como application/octet-stream.",
      415,
    );
  }

  // Si llega `Content-Length`, se comprueba antes de leer nada: así un cuerpo
  // enorme se rechaza sin cargarlo en memoria. Si no llega (cuerpo troceado), la
  // comprobación real es la longitud de lo leído, más abajo.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_PART_BYTES) {
    throw new DomainError(
      "PDF_CHUNK_SIZE_INVALID",
      "La parte supera el tamaño máximo permitido (768 KiB). Divide el fichero en partes.",
      413,
    );
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) {
    throw new DomainError("PDF_EMPTY", "La parte está vacía.", 400);
  }
  if (bytes.length > UPLOAD_PART_BYTES) {
    throw new DomainError(
      "PDF_CHUNK_SIZE_INVALID",
      "La parte supera el tamaño máximo permitido (768 KiB).",
      413,
    );
  }

  return bytes;
}

/**
 * Cuerpo de la asociación al borrador: revisión esperada y nada más.
 *
 * El documento viene en la ruta y el tema lo aporta el propio documento (se
 * fijó al subirlo): el cliente no puede mover un PDF a otro curso ni a otro
 * tema cambiando el cuerpo.
 */
const attachSchema = z.strictObject({
  expectedRevision: z.coerce.number().int().min(0),
});

export async function readAttachBody(request: Request): Promise<{ expectedRevision: number }> {
  const body = await readJsonBody(request);
  const parsed = attachSchema.safeParse(body);
  if (!parsed.success) {
    throw new DomainError(
      "ATTACH_BODY_INVALID",
      "Falta la revisión del borrador (o el cuerpo trae campos que no se aceptan).",
      400,
    );
  }
  return parsed.data;
}
