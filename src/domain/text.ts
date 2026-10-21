/**
 * Utilidades de normalización de texto y errores de dominio.
 * Código puro: sin Firebase, sin red, sin relojes ni aleatoriedad implícita.
 */

/** Marca de error de negocio (esperado, con mensaje para el usuario). */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Clave de comparación de un apellido:
 * - sin acentos ni diacríticos (NFD + eliminación de marcas)
 * - minúsculas
 * - sin espacios, guiones, apóstrofos ni puntos
 * - solo [a-z0-9]
 *
 * Se usa para detectar duplicados y para construir el nombre de usuario.
 * "Sánchez de la Fuente" → "sanchezdelafuente"
 */
export function surnameKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Colapsa espacios y recorta extremos (incluidos NBSP y tabulaciones). */
export function collapseWhitespace(value: string): string {
  return value.replace(/[\s\u00a0\u2007\u202f]+/g, " ").trim();
}

/** Quita acentos conservando el resto del texto. */
export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
