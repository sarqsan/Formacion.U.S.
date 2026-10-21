import type { PersonRol } from "@/domain/roles";
import { personRolSlug } from "@/domain/roles";
import { DomainError } from "@/domain/text";

/**
 * GENERACIÓN DE NOMBRES DE USUARIO
 * ================================
 *
 * ⚠️ DECISIÓN PENDIENTE (ver docs/DECISIONS.md, ADR-004).
 *
 * El enunciado pide "el criterio de rol y apellido utilizado en la aplicación
 * actual". Esta fase NO tiene acceso a esa aplicación (el aislamiento lo
 * prohíbe), así que el criterio exacto todavía no se conoce. Lo que hay aquí
 * es una estrategia **provisional y aislada**, pensada para poder sustituirse
 * sin tocar el resto del sistema:
 *
 *     rol1.garcia
 *
 * Lo que SÍ está garantizado (y probado) independientemente del criterio final:
 *   - determinismo: mismas entradas ⇒ mismo resultado;
 *   - unicidad: el solucionador de colisiones nunca devuelve un usuario ocupado;
 *   - juego de caracteres seguro: [a-z0-9.-], empieza y acaba en alfanumérico;
 *   - longitud acotada;
 *   - estabilidad: publicar una versión de curso o reimportar NO cambia usuarios.
 *
 * Cuando se confirme el criterio real, solo hay que cambiar `buildBaseUsername`
 * y actualizar sus pruebas. Nada más del sistema depende del formato.
 */

export const USERNAME_MAX_LENGTH = 60;
export const USERNAME_MIN_LENGTH = 4;

/** Nombres que nunca deben asignarse automáticamente. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "root",
  "sistema",
  "system",
  "soporte",
  "seguridad",
]);

/**
 * Construye el usuario base (sin resolver colisiones) a partir de rol + apellido.
 * Esta es la única función que habría que cambiar si el criterio real difiere.
 */
export function buildBaseUsername(rol: PersonRol, key: string): string {
  return `${personRolSlug(rol)}.${key}`;
}

const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function assertValidUsername(username: string): void {
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    throw new DomainError(
      "USERNAME_INVALID_LENGTH",
      `El nombre de usuario debe medir entre ${USERNAME_MIN_LENGTH} y ${USERNAME_MAX_LENGTH} caracteres.`,
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new DomainError(
      "USERNAME_INVALID_CHARS",
      "El nombre de usuario contiene caracteres no permitidos.",
    );
  }
}

/**
 * Resuelve colisiones añadiendo un sufijo numérico: `rol1.garcia`,
 * `rol1.garcia2`, `rol1.garcia3`…
 *
 * @param base        usuario base ya normalizado
 * @param isTaken     predicado de ocupación (BD + lote en curso)
 * @param maxAttempts límite de seguridad para no generar bucles infinitos
 */
export function allocateUsername(
  base: string,
  isTaken: (candidate: string) => boolean,
  maxAttempts = 500,
): string {
  assertValidUsername(base);

  const baseIsReserved = RESERVED_USERNAMES.has(base);

  for (let suffix = 1; suffix <= maxAttempts; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}${suffix}`;
    if (candidate.length > USERNAME_MAX_LENGTH) {
      throw new DomainError(
        "USERNAME_TOO_LONG",
        "El nombre de usuario generado es demasiado largo.",
      );
    }
    const reserved = RESERVED_USERNAMES.has(candidate);
    if (reserved) continue;
    if (suffix === 1 && baseIsReserved) continue;
    if (!isTaken(candidate)) return candidate;
  }

  throw new DomainError(
    "USERNAME_EXHAUSTED",
    "No se ha podido generar un nombre de usuario libre para este apellido.",
    409,
  );
}

/**
 * Construye el correo sintético que Firebase Authentication exige.
 *
 * El Excel solo tiene dos columnas (Rol y Apellido), así que no existe correo
 * real. Se usa el TLD reservado `.invalid` (RFC 2606): por definición no es
 * enrutable ni entregable, de modo que ningún dato personal sale del sistema
 * y no se puede confundir con una dirección real.
 */
export function usernameToAuthEmail(username: string, domain: string): string {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedDomain) || !normalizedDomain.includes(".")) {
    throw new DomainError(
      "AUTH_EMAIL_DOMAIN_INVALID",
      "El dominio de correo interno no es válido.",
      500,
    );
  }
  return `${username}@${normalizedDomain}`;
}
