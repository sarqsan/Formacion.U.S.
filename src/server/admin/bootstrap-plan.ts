import { DomainError } from "@/domain/text";
import { RESERVED_USERNAMES, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@/domain/people/username";

/**
 * ADMINISTRADORES INICIALES
 * ========================
 *
 * No hay registro público y la importación de Excel NUNCA concede admin.
 * Los primeros administradores se crean con un script manual que:
 *
 *   - requiere acceso a la cuenta de servicio (nadie más puede ejecutarlo);
 *   - es idempotente (no duplica ni reescribe cuentas existentes);
 *   - crea las cuentas en estado `pending_activation` con token de un solo
 *     uso, igual que el resto: no hay contraseñas compartidas por chat;
 *   - admite VARIOS administradores a la vez, para no depender de una sola
 *     persona (punto único de fallo);
 *   - exige confirmación explícita (`BOOTSTRAP_CONFIRM=yes`) y soporta
 *     simulación (`--dry-run`).
 *
 * Este módulo es la parte pura y probada: decide qué hacer, no lo hace.
 */

export const MAX_BOOTSTRAP_ADMINS = 20;

const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function parseBootstrapAdminList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export interface BootstrapPlan {
  create: string[];
  skipExisting: string[];
  invalid: Array<{ username: string; reason: string }>;
}

export function planBootstrapAdmins(
  existingUsernames: ReadonlySet<string>,
  requested: readonly string[],
): BootstrapPlan {
  const unique = [...new Set(requested.map((item) => item.trim().toLowerCase()).filter(Boolean))];

  if (unique.length === 0) {
    throw new DomainError(
      "BOOTSTRAP_EMPTY",
      "No se ha indicado ningún administrador (BOOTSTRAP_ADMIN_USERNAMES).",
    );
  }

  if (unique.length > MAX_BOOTSTRAP_ADMINS) {
    throw new DomainError(
      "BOOTSTRAP_TOO_MANY",
      `Como máximo ${MAX_BOOTSTRAP_ADMINS} administradores iniciales por ejecución.`,
    );
  }

  const plan: BootstrapPlan = { create: [], skipExisting: [], invalid: [] };

  for (const username of unique) {
    if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
      plan.invalid.push({ username, reason: "longitud no válida" });
      continue;
    }
    if (!USERNAME_PATTERN.test(username)) {
      plan.invalid.push({ username, reason: "caracteres no válidos" });
      continue;
    }
    if (RESERVED_USERNAMES.has(username)) {
      plan.invalid.push({ username, reason: "nombre reservado" });
      continue;
    }
    if (existingUsernames.has(username)) {
      plan.skipExisting.push(username);
      continue;
    }
    plan.create.push(username);
  }

  return plan;
}

/**
 * Reglas de seguridad para el script. Se comprueban antes de tocar Firebase.
 */
export function assertBootstrapAllowed(options: {
  dryRun: boolean;
  confirmed: boolean;
  hasCredentials: boolean;
  usingEmulator: boolean;
}): void {
  if (!options.hasCredentials && !options.usingEmulator) {
    throw new DomainError(
      "BOOTSTRAP_NO_CREDENTIALS",
      "Faltan credenciales de Firebase Admin. No se puede crear ningún administrador.",
    );
  }
  if (!options.dryRun && !options.confirmed) {
    throw new DomainError(
      "BOOTSTRAP_NOT_CONFIRMED",
      "Ejecuta con --dry-run para revisar, y luego con BOOTSTRAP_CONFIRM=yes para aplicar cambios.",
    );
  }
}
