import { DomainError, collapseWhitespace, surnameKey } from "@/domain/text";

export const SURNAME_MIN_LENGTH = 2;
export const SURNAME_MAX_LENGTH = 60;

/**
 * Caracteres admitidos en un apellido: letras Unicode (incluye ñ, á, ü…),
 * espacios interiores, guion, apóstrofo (recto y tipográfico) y punto.
 * Se rechazan dígitos y cualquier otro símbolo.
 */
const SURNAME_PATTERN = /^\p{L}[\p{L} .'’-]*\p{L}$/u;

export interface NormalizedSurname {
  /** Texto limpio para mostrar (espacios colapsados). */
  display: string;
  /** Clave de comparación, p. ej. "sanchezdelafuente". */
  key: string;
}

/**
 * Valida y normaliza un apellido procedente del Excel.
 * Lanza `DomainError` con un mensaje apto para mostrar al administrador.
 */
export function normalizeSurname(raw: unknown): NormalizedSurname {
  if (raw === null || raw === undefined) {
    throw new DomainError("SURNAME_REQUIRED", "El apellido está vacío.");
  }

  if (typeof raw === "number") {
    throw new DomainError(
      "SURNAME_INVALID_TYPE",
      "El apellido no puede ser un número.",
    );
  }

  if (typeof raw !== "string") {
    throw new DomainError("SURNAME_INVALID_TYPE", "El apellido no es texto.");
  }

  const display = collapseWhitespace(raw.normalize("NFC"));

  if (display.length === 0) {
    throw new DomainError("SURNAME_REQUIRED", "El apellido está vacío.");
  }

  if (display.length < SURNAME_MIN_LENGTH) {
    throw new DomainError(
      "SURNAME_TOO_SHORT",
      `El apellido debe tener al menos ${SURNAME_MIN_LENGTH} caracteres.`,
    );
  }

  if (display.length > SURNAME_MAX_LENGTH) {
    throw new DomainError(
      "SURNAME_TOO_LONG",
      `El apellido no puede superar ${SURNAME_MAX_LENGTH} caracteres.`,
    );
  }

  if (/\d/.test(display)) {
    throw new DomainError(
      "SURNAME_CONTAINS_DIGITS",
      "El apellido no puede contener números.",
    );
  }

  if (!SURNAME_PATTERN.test(display)) {
    throw new DomainError(
      "SURNAME_INVALID_CHARS",
      "El apellido contiene caracteres no admitidos (solo letras, espacios, guion, apóstrofo y punto).",
    );
  }

  const key = surnameKey(display);

  if (key.length < SURNAME_MIN_LENGTH) {
    throw new DomainError(
      "SURNAME_TOO_SHORT",
      `El apellido debe tener al menos ${SURNAME_MIN_LENGTH} letras.`,
    );
  }

  return { display, key };
}
