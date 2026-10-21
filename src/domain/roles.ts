/**
 * Roles del sistema.
 *
 * Hay dos conceptos distintos y NO deben confundirse:
 *
 * 1. `PersonRol`  → categoría de la persona según el Excel (ROL 1 / ROL 2).
 *                   Es un dato descriptivo que forma parte del identificador
 *                   de usuario. NO concede permisos.
 * 2. `AccountRole` → nivel de permiso dentro de la aplicación (admin / learner).
 *                   Solo lo asigna un administrador o el script de arranque.
 *
 * La importación de Excel NUNCA puede producir un `AccountRole` distinto de
 * "learner": esa garantía se aplica aquí y se vuelve a comprobar en el
 * servicio de importación del servidor.
 */

export const PERSON_ROLES = ["ROL 1", "ROL 2"] as const;
export type PersonRol = (typeof PERSON_ROLES)[number];

export const ACCOUNT_ROLES = ["admin", "learner"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Estados del ciclo de vida de una cuenta. */
export const ACCOUNT_STATUSES = [
  "pending_activation",
  "active",
  "disabled",
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Normaliza el valor de la columna `Rol` de un Excel.
 *
 * Tolera variantes de espaciado, mayúsculas y separadores
 * ("Rol 1", "ROL1", "rol-1", " ROL  1 ") pero es estricta con el número:
 * cualquier valor que no sea inequívocamente ROL 1 o ROL 2 devuelve `null`.
 * En particular "ROL 3" o "ROL 12" NO se aceptan.
 */
export function normalizePersonRol(value: unknown): PersonRol | null {
  if (typeof value !== "string") return null;

  const compact = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  switch (compact) {
    case "ROL1":
      return "ROL 1";
    case "ROL2":
      return "ROL 2";
    default:
      return null;
  }
}

/** Fragmento de rol usado en la generación del nombre de usuario. */
export function personRolSlug(rol: PersonRol): "rol1" | "rol2" {
  return rol === "ROL 1" ? "rol1" : "rol2";
}

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && ACCOUNT_ROLES.includes(value as AccountRole);
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return (
    typeof value === "string" &&
    ACCOUNT_STATUSES.includes(value as AccountStatus)
  );
}
