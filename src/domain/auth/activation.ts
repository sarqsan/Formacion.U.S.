import { DomainError } from "@/domain/text";
import type { AccountRole, AccountStatus, PersonRol } from "@/domain/roles";

/**
 * ACTIVACIÓN DE CUENTA EN EL PRIMER ACCESO
 * ========================================
 *
 * Flujo (sin contraseñas en Excel y sin contraseña inicial conocida):
 *
 * 1. La importación crea la cuenta con un **token de activación** aleatorio
 *    (32 bytes), caducidad de 7 días, un solo uso y ligado a un `uid`.
 *    En la base de datos se guarda SOLO su hash SHA-256.
 * 2. El administrador entrega el token por un canal distinto de este sistema
 *    (en mano o por canal interno). No hay envío de correo en esta fase.
 * 3. En `/activar`, el usuario introduce usuario + token + contraseña nueva.
 *    El servidor: verifica token (hash, caducidad, uso), valida la política de
 *    contraseña, fija la contraseña con Admin SDK, marca la cuenta `active`,
 *    actualiza las Custom Claims y consume el token.
 * 4. La contraseña se envía una vez por HTTPS al servidor y NO se registra en
 *    ningún log, ni se guarda en claro (Firebase guarda su hash con scrypt).
 *
 * Alternativa descartada por ahora: custom token + `updatePassword` en cliente
 * (la contraseña no pasa por nuestro servidor) — requiere una llamada extra
 * de finalización y no permite demostrar en servidor que se cambió. Ver
 * docs/DECISIONS.md (ADR-006).
 */

export const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
  requireLowercase: true,
  requireUppercase: true,
  requireDigit: true,
  requireSymbol: false,
} as const;

export const ACTIVATION_TOKEN_TTL_HOURS = 72;

export interface PasswordIssue {
  code: string;
  message: string;
}

export function passwordRequirements(): string[] {
  return [
    `Al menos ${PASSWORD_POLICY.minLength} caracteres (máximo ${PASSWORD_POLICY.maxLength}).`,
    "Al menos una letra minúscula.",
    "Al menos una letra mayúscula.",
    "Al menos un número.",
    "No puede ser igual al nombre de usuario ni contenerlo.",
  ];
}

/** Lista de incumplimientos (vacía = contraseña aceptable). */
export function validatePassword(
  password: unknown,
  context: { username?: string; previousPasswords?: readonly string[] } = {},
): PasswordIssue[] {
  const issues: PasswordIssue[] = [];

  if (typeof password !== "string") {
    return [{ code: "PASSWORD_TYPE", message: "La contraseña no es válida." }];
  }

  // Se cuentan puntos de código, no unidades UTF-16, para emojis/acentos.
  const length = [...password].length;

  if (length < PASSWORD_POLICY.minLength) {
    issues.push({
      code: "PASSWORD_TOO_SHORT",
      message: `La contraseña debe tener al menos ${PASSWORD_POLICY.minLength} caracteres.`,
    });
  }

  if (length > PASSWORD_POLICY.maxLength) {
    issues.push({
      code: "PASSWORD_TOO_LONG",
      message: `La contraseña no puede superar ${PASSWORD_POLICY.maxLength} caracteres.`,
    });
  }

  if (PASSWORD_POLICY.requireLowercase && !/\p{Ll}/u.test(password)) {
    issues.push({ code: "PASSWORD_NO_LOWERCASE", message: "Falta una letra minúscula." });
  }

  if (PASSWORD_POLICY.requireUppercase && !/\p{Lu}/u.test(password)) {
    issues.push({ code: "PASSWORD_NO_UPPERCASE", message: "Falta una letra mayúscula." });
  }

  if (PASSWORD_POLICY.requireDigit && !/\d/.test(password)) {
    issues.push({ code: "PASSWORD_NO_DIGIT", message: "Falta un número." });
  }

  if (/^\s|\s$/.test(password)) {
    issues.push({
      code: "PASSWORD_WHITESPACE",
      message: "La contraseña no puede empezar ni terminar con espacios.",
    });
  }

  const username = context.username?.trim().toLowerCase();
  if (username && username.length >= 4 && password.toLowerCase().includes(username)) {
    issues.push({
      code: "PASSWORD_CONTAINS_USERNAME",
      message: "La contraseña no puede contener el nombre de usuario.",
    });
  }

  for (const previous of context.previousPasswords ?? []) {
    if (previous === password) {
      issues.push({
        code: "PASSWORD_REUSED",
        message: "La contraseña ya se ha utilizado. Elige otra.",
      });
      break;
    }
  }

  return issues;
}

export function assertPasswordAcceptable(
  password: unknown,
  context: { username?: string; previousPasswords?: readonly string[] } = {},
): void {
  const issues = validatePassword(password, context);
  if (issues.length > 0) {
    throw new DomainError("PASSWORD_WEAK", issues[0].message, 400, {
      issues: issues.map((issue) => issue.code),
    });
  }
}

export interface ActivationRecord {
  uid: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export function assertActivationUsable(record: ActivationRecord | null, nowIso: string): ActivationRecord {
  if (!record) {
    throw new DomainError(
      "ACTIVATION_INVALID",
      "El código de activación no es válido. Solicita uno nuevo a administración.",
      400,
    );
  }
  if (record.usedAt) {
    throw new DomainError(
      "ACTIVATION_ALREADY_USED",
      "Ese código de activación ya se ha utilizado.",
      409,
    );
  }
  if (record.revokedAt) {
    throw new DomainError(
      "ACTIVATION_REVOKED",
      "Ese código de activación ha sido anulado. Solicita uno nuevo.",
      403,
    );
  }
  if (Number.isNaN(Date.parse(nowIso)) || Number.isNaN(Date.parse(record.expiresAt))) {
    throw new DomainError("TIMESTAMP_INVALID", "Marca de tiempo no válida.", 500);
  }
  if (Date.parse(nowIso) >= Date.parse(record.expiresAt)) {
    throw new DomainError(
      "ACTIVATION_EXPIRED",
      "Ese código de activación ha caducado. Solicita uno nuevo a administración.",
      410,
    );
  }
  return record;
}

/**
 * Custom Claims.
 *
 * Se mantienen pequeñas (Firebase limita el tamaño del token) y solo con datos
 * no sensibles. `claimsVersion` permite invalidar sesiones antiguas si un rol
 * o estado cambia: el servidor compara la versión del token con la de la BD.
 */
export interface AccountClaims {
  role: AccountRole;
  status: AccountStatus;
  /** `null` cuando la cuenta no tiene rol de persona (administración). */
  personRol?: PersonRol | null;
  claimsVersion: number;
}

export function buildClaims(input: AccountClaims): Record<string, unknown> {
  return {
    role: input.role,
    status: input.status,
    ...(input.personRol ? { personRol: input.personRol } : {}),
    claimsVersion: input.claimsVersion,
  };
}

export function assertClaimsFresh(
  tokenClaims: { claimsVersion?: unknown } | undefined,
  currentClaimsVersion: number,
): void {
  const tokenVersion = tokenClaims?.claimsVersion;
  if (typeof tokenVersion !== "number" || tokenVersion !== currentClaimsVersion) {
    throw new DomainError(
      "TOKEN_STALE",
      "Tus permisos han cambiado. Vuelve a iniciar sesión.",
      401,
    );
  }
}
