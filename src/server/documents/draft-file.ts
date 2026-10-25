import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import type { PdfDocumentStore } from "@/server/documents/store";

/**
 * LEER EL PDF DE UN BORRADOR (solo servidor, solo administración)
 * ==============================================================
 *
 * `readDocumentFile` sirve el PDF al **alumnado matriculado** y solo si el
 * documento pertenece a la versión publicada. Eso es correcto y no se toca.
 *
 * Pero la generación con IA ocurre antes: el administrador acaba de subir el
 * temario a un borrador que nadie más puede ver. Esta función es la única vía
 * para obtener esos bytes, y es deliberadamente estrecha:
 *
 *   · solo administradores con la cuenta activa;
 *   · solo documentos `active` (subida terminada y verificada);
 *   · el documento tiene que pertenecer **a ese curso y a esa versión**;
 *   · el documento tiene que estar **referenciado** en el borrador;
 *   · se comprueba el tamaño y el SHA-256 de lo leído: si el almacén devuelve
 *     otra cosa, no se envía a ningún sitio.
 *
 * No hay caché: son unos pocos MiB y una lectura explícita del administrador.
 */

export interface DraftFileDependencies {
  documents: PdfDocumentStore;
  catalog: CourseCatalogStore;
}

export interface DraftFileResult {
  documentId: string;
  title: string;
  pageCount: number;
  bytes: Uint8Array;
  sha256: string;
}

// Los identificadores de documento son `doc_<hex>` (ver `documentIdFor`):
// minúsculas, números, guion y guion bajo.
const DOCUMENT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export async function readDraftDocumentFile(
  input: { actor: Actor; courseId: string; version: number; documentId: string },
  deps: DraftFileDependencies,
): Promise<DraftFileResult> {
  const actor = assertAdmin(input.actor);

  if (!DOCUMENT_ID.test(input.documentId)) {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }

  const meta = await deps.documents.getMeta(input.documentId);
  if (!meta || meta.state !== "active") {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe o no está listo.", 404);
  }

  if (meta.courseId !== input.courseId || meta.version !== input.version) {
    throw new DomainError(
      "DOCUMENT_NOT_IN_VERSION",
      "Ese documento no pertenece al borrador que estás editando.",
      403,
    );
  }

  const version = await deps.catalog.getVersion(input.courseId, input.version);
  if (!version) {
    throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
  }
  if (version.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Solo se analiza el PDF de un borrador: una versión publicada es inmutable.",
      409,
    );
  }

  const referenced = version.topics.some((topic) =>
    topic.documents.some((document) => document.id === meta.documentId),
  );
  if (!referenced) {
    throw new DomainError(
      "DOCUMENT_NOT_IN_VERSION",
      "El documento no está asociado a ningún tema de este borrador.",
      404,
    );
  }

  const chunks = meta.chunkLengths;
  if (chunks.length === 0 || meta.partsReceived !== chunks.length) {
    throw new DomainError(
      "PDF_INCOMPLETE",
      "La subida del PDF no está completa: vuelve a subirlo.",
      409,
    );
  }

  const parts: Uint8Array[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = await deps.documents.readChunk(meta.documentId, index);
    if (!chunk || chunk.length !== chunks[index]) {
      throw new DomainError(
        "PDF_CORRUPT",
        "Falta una parte del PDF o su tamaño no coincide. Vuelve a subirlo.",
        409,
      );
    }
    parts.push(chunk);
  }

  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  if (bytes.length !== meta.bytes) {
    throw new DomainError("PDF_CORRUPT", "El PDF leído no tiene el tamaño declarado.", 409);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== meta.sha256) {
    throw new DomainError(
      "PDF_CORRUPT",
      "El PDF no coincide con la huella guardada al subirlo. Vuelve a subirlo.",
      409,
    );
  }

  // El administrador no "lee" para el alumno: esta operación no toca progreso.
  void actor;

  return {
    documentId: meta.documentId,
    title: meta.title,
    pageCount: meta.pageCount,
    bytes,
    sha256,
  };
}
