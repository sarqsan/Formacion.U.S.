import { DomainError } from "@/domain/text";

/**
 * IDENTIFICADORES DE DOCUMENTO EN LAS RUTAS PÚBLICAS
 * =================================================
 *
 * Los documentos que crea el servidor usan `doc_` + 32 hex (ver
 * `pdf-upload.ts`), pero el contenido ya existente —y los datos de la
 * demostración— usan identificadores cortos (`doc-riesgos`). La ruta de lectura
 * acepta ambos, y por eso necesita su propia validación: el identificador llega
 * de la URL y no puede acabar construyendo una ruta de almacén ni una consulta.
 *
 * Regla: un segmento de documento es alfanumérico al principio y después solo
 * letras, dígitos, punto, guion y guion bajo. Sin `/`, sin `..`, sin espacios y
 * con un máximo razonable. No se recorta ni se normaliza: si no cumple, se
 * rechaza.
 */

const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeDocumentId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_ID.test(value) && !value.includes("..");
}

/**
 * Valida el identificador de documento de una petición.
 *
 * El error es el mismo que el de «documento inexistente»: un identificador con
 * forma inválida no debe distinguirse de uno que no existe, para no dar pistas
 * sobre qué hay almacenado.
 */
export function assertSafeDocumentId(value: unknown): string {
  if (!isSafeDocumentId(value)) {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }
  return value;
}
