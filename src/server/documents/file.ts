import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";
import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import { isEnrollmentActive } from "@/domain/courses/enrollment";
import { assertSafeDocumentId } from "@/domain/storage/document-id";
import { hasPdfHeader } from "@/domain/storage/pdf-upload";
import { MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";
import type { CourseCatalogStore, CourseVersionDocument } from "@/server/courses/catalog";
import type { EnrollmentStore } from "@/server/enrollments/store";
import type { PdfDocumentMeta, PdfDocumentStore } from "@/server/documents/store";
import type { SlidingWindowLimiter } from "@/server/ratelimit/limiter";

/**
 * LECTURA DEL PDF COMPLETO (bloque 07)
 * ====================================
 *
 * El alumnado abre un PDF con el **visor nativo** del navegador: se descarga el
 * fichero entero en una sola respuesta y el navegador lo presenta. No hay visor
 * propio, ni `pdf.js`, ni renderizado por el servidor.
 *
 * Antes de entregar un solo byte, el servidor comprueba —en este orden y sin
 * fiarse de nada que venga del cliente—:
 *
 *   1. la cuenta es **activa** (no basta con tener una cookie);
 *   2. el identificador tiene forma válida (nada de rutas ni consultas);
 *   3. el documento existe y está **activo** (no pendiente, ni abortado, ni
 *      archivado, ni a medias);
 *   4. el curso tiene una **versión publicada**;
 *   5. el actor tiene **matrícula activa** en ese curso (también la
 *      administración: el visor es la puerta del alumnado, y lo que no está
 *      publicado no se sirve por aquí);
 *   6. el documento está **referenciado expresamente** en la definición de esa
 *      versión publicada: un documento de un borrador, o de una versión
 *      anterior que ya no está publicada, no se entrega aunque su identificador
 *      sea correcto y sus bytes sigan en el almacén;
 *   7. las partes cubren el tamaño declarado y el **SHA-256 global** coincide
 *      con el que se verificó al activar el documento.
 *
 * Lo que esto **no** es: no es un antivirus. El SHA-256 demuestra que los bytes
 * son los que se subieron, no que el PDF sea inocuo. La comprobación de
 * integridad y el análisis de contenido malicioso son cosas distintas.
 *
 * Los errores no distinguen «no existe» de «no te corresponde»: todos los casos
 * de documento no servible devuelven el mismo 404, para no revelar qué
 * documentos hay en borradores ni en versiones antiguas.
 */

export interface DocumentFileDependencies {
  documents: PdfDocumentStore;
  catalog: CourseCatalogStore;
  enrollments: EnrollmentStore;
  /** Límite de descargas (en fragmentos leídos) por usuario y global. */
  limiter?: SlidingWindowLimiter;
}

export interface DocumentFileResult {
  documentId: string;
  bytes: Uint8Array;
  /** Nombre seguro para `Content-Disposition` (ASCII, sin rutas). */
  filename: string;
  pageCount: number;
}

export interface DocumentFileSummary {
  documentId: string;
  title: string;
  pageCount: number;
  bytes: number;
}

/** Documento no servible: mismo error para inexistente, de borrador o no autorizado. */
function notFound(): DomainError {
  return new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
}

function corrupted(detail: string): DomainError {
  return new DomainError(
    "DOCUMENT_CORRUPTED",
    "El documento no supera la comprobación de integridad y no se entrega. Avisa a administración.",
    409,
    { detail },
  );
}

/**
 * Nombre de fichero para la cabecera `Content-Disposition`.
 *
 * Solo ASCII, sin comillas ni barras: un título con `"` o saltos de línea no
 * puede romper la cabecera. El navegador lo usa para el nombre de la pestaña o
 * de la descarga, nunca para localizar el fichero.
 */
function safeFilename(title: string, documentId: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ._-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || documentId}.pdf`;
}

/** ¿Este documento está referenciado en la definición de la versión? */
export function isDocumentInVersion(version: CourseVersionDocument, documentId: string): boolean {
  return version.topics.some((topic) =>
    topic.documents.some((document) => document.id === documentId),
  );
}

/**
 * Comprobaciones comunes (autorización + integridad declarada).
 *
 * No lee los fragmentos: sirve tanto para decidir si la interfaz ofrece el visor
 * como para la descarga real, que después verifica los bytes.
 */
async function loadServableDocument(
  input: { actor: Actor; documentId: string },
  deps: DocumentFileDependencies,
): Promise<{ meta: PdfDocumentMeta; version: CourseVersionDocument }> {
  const actor = assertActiveAccount(input.actor);

  // La forma del identificador se valida igual que la existencia: un valor
  // raro no puede llegar al almacén y no debe distinguirse de «no existe».
  const documentId = assertSafeDocumentId(input.documentId);

  const meta = await deps.documents.getMeta(documentId);
  if (!meta || meta.state !== "active") throw notFound();

  // Curso y versión publicada: la autorización se decide sobre lo que hay
  // publicado **ahora**, no sobre lo que diga la petición.
  const course = await deps.catalog.getCourse(meta.courseId);
  if (!course || course.publishedVersion === null) throw notFound();

  const enrollment = await deps.enrollments.get(actor.uid, meta.courseId);
  if (!isEnrollmentActive(enrollment)) {
    throw new DomainError(
      "COURSE_NOT_AUTHORIZED",
      "No tienes acceso a este curso. Si crees que es un error, avisa a administración.",
      403,
    );
  }

  const version = await deps.catalog.getVersion(meta.courseId, course.publishedVersion);
  if (!version || version.status !== "published") throw notFound();

  // Referencia expresa en la versión publicada: es lo que impide que un
  // documento de borrador o de una versión antigua se sirva por conocer su id.
  if (!isDocumentInVersion(version, meta.documentId)) throw notFound();

  // Integridad declarada (barata): sin todas las partes no hay fichero.
  const chunks = meta.chunkLengths;
  if (chunks.length === 0 || meta.partsReceived !== chunks.length) {
    throw corrupted("incomplete");
  }
  const declaredTotal = chunks.reduce((sum, length) => sum + length, 0);
  if (declaredTotal !== meta.bytes || meta.bytes <= 0 || meta.bytes > MAX_PDF_BYTES) {
    throw corrupted("size");
  }

  return { meta, version };
}

/**
 * ¿Se puede ofrecer el visor para este documento?
 *
 * Devuelve `false` en lugar de lanzar: la interfaz necesita saberlo para no
 * presentar como disponible un documento pendiente, archivado o de un borrador.
 * No lee los fragmentos.
 */
export async function isDocumentFileAvailable(
  input: { actor: Actor; documentId: string },
  deps: DocumentFileDependencies,
): Promise<boolean> {
  try {
    await loadServableDocument(input, deps);
    return true;
  } catch {
    return false;
  }
}

/** Metadatos mínimos para la interfaz (nunca rutas de almacén ni huellas). */
export async function documentFileSummary(
  input: { actor: Actor; documentId: string },
  deps: DocumentFileDependencies,
): Promise<DocumentFileSummary | null> {
  try {
    const { meta } = await loadServableDocument(input, deps);
    return {
      documentId: meta.documentId,
      title: meta.title,
      pageCount: meta.pageCount,
      bytes: meta.bytes,
    };
  } catch {
    return null;
  }
}

/**
 * Recupera el PDF completo, verificado.
 *
 * La suma de fragmentos se hace aquí, en el servidor: el cliente recibe un
 * único `application/pdf` y nunca las partes ni sus huellas.
 */
export async function readDocumentFile(
  input: { actor: Actor; documentId: string },
  deps: DocumentFileDependencies,
): Promise<DocumentFileResult> {
  const { meta } = await loadServableDocument(input, deps);
  const actor = assertActiveAccount(input.actor);

  // Coste = fragmentos leídos. Una descarga completa se cobra como lo que es:
  // varias lecturas de Firestore, no una.
  deps.limiter?.consumeOrThrow(`pdf:file:${actor.uid}`, meta.chunkLengths.length);

  const parts: Uint8Array[] = [];
  for (let index = 0; index < meta.chunkLengths.length; index += 1) {
    const chunk = await deps.documents.readChunk(meta.documentId, index);
    if (!chunk || chunk.length !== meta.chunkLengths[index]) throw corrupted("missing-part");
    parts.push(chunk);
  }

  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  if (bytes.length !== meta.bytes) throw corrupted("size");
  if (!hasPdfHeader(bytes)) throw corrupted("signature");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== meta.sha256) throw corrupted("sha256");

  return {
    documentId: meta.documentId,
    bytes,
    filename: safeFilename(meta.title, meta.documentId),
    pageCount: meta.pageCount,
  };
}
