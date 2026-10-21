import { DomainError } from "@/domain/text";
import { MAX_UPLOAD_BYTES, parsePeopleWorkbook } from "@/server/import/excel";
import type { RawPersonRow } from "@/domain/people/import-rows";

const MAX_FORM_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const MAX_RESOLUTIONS_JSON = 32 * 1024;

/**
 * Extrae las filas del formulario de importación.
 *
 * Solo se aceptan dos campos: `file` (xlsx) y `resolutions` (JSON, opcional).
 * Cualquier otro dato del cliente (usuarios propuestos, roles, uids…) se
 * ignora deliberadamente.
 */
export async function readImportForm(
  request: Request,
): Promise<{ rows: RawPersonRow[]; resolutions: unknown }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new DomainError("UNSUPPORTED_MEDIA_TYPE", "Se esperaba multipart/form-data.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
    throw new DomainError("UPLOAD_TOO_LARGE", "El archivo es demasiado grande.", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new DomainError("FORM_INVALID", "No se ha podido leer el formulario.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new DomainError("FILE_MISSING", "Adjunta el Excel de personas.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new DomainError("UPLOAD_TOO_LARGE", "El archivo supera el tamaño máximo.", 413);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parsePeopleWorkbook(buffer);

  let resolutions: unknown;
  const rawResolutions = form.get("resolutions");
  if (typeof rawResolutions === "string" && rawResolutions.trim() !== "") {
    if (rawResolutions.length > MAX_RESOLUTIONS_JSON) {
      throw new DomainError("RESOLUTIONS_INVALID", "Las decisiones de duplicados son demasiado grandes.");
    }
    try {
      resolutions = JSON.parse(rawResolutions);
    } catch {
      throw new DomainError("RESOLUTIONS_INVALID", "Las decisiones de duplicados no son JSON válido.");
    }
  }

  return { rows: parsed.rows, resolutions };
}
