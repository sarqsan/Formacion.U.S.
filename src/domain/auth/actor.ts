import { DomainError } from "@/domain/text";
import type { AccountRole, AccountStatus, PersonRol } from "@/domain/roles";
import { isAccountRole, isAccountStatus } from "@/domain/roles";
import type { Actor } from "@/domain/auth/authorization";

/**
 * RESOLUCIÓN DEL ACTOR (lógica pura, verificable sin Firebase)
 * ===========================================================
 *
 * Decide si una petición autenticada vale como sesión utilizable. Es la pieza
 * que responde a "¿puede una cuenta deshabilitada seguir usando una sesión
 * válida?". Se extrae de `server/auth/session.ts` precisamente para poder
 * probarla sin emulador: aquí no hay criptografía, solo la política.
 *
 * Entradas:
 * - `claims`: lo que dice el token de Firebase (puede estar OBSOLETO: un
 *   token emitido hace una hora sigue diciendo `status: 'active'` aunque la
 *   cuenta se haya deshabilitado después).
 * - `account`: lo que dice la base de datos AHORA (fuente de verdad).
 *
 * Regla: la base de datos manda. Si token y base de datos discrepan, no hay
 * sesión. Es más estricto que confiar en el token, y es la única forma de que
 * deshabilitar una cuenta surta efecto de inmediato.
 *
 * La verificación de firma/emisor/caducidad del token NO la hace esta función:
 * la hace `verifySessionCookie` del Admin SDK antes de llamarla.
 */

export interface SessionClaims {
  role?: unknown;
  status?: unknown;
  claimsVersion?: unknown;
  personRol?: unknown;
}

export interface AccountSnapshot {
  uid: string;
  role: unknown;
  status: unknown;
  claimsVersion: unknown;
  personRol?: unknown;
}

export interface ResolvedAccount extends Actor {
  personRol: PersonRol | null;
}

export type SessionRejectionReason =
  | "no_account"
  | "uid_mismatch"
  | "invalid_stored_role"
  | "invalid_stored_status"
  | "account_not_active"
  | "stale_claims_version"
  | "role_mismatch"
  | "status_mismatch";

export type SessionResolution =
  | { ok: true; actor: ResolvedAccount }
  | { ok: false; reason: SessionRejectionReason };

export function resolveSession(
  claims: SessionClaims | null | undefined,
  account: AccountSnapshot | null | undefined,
): SessionResolution {
  if (!account || !account.uid) {
    return { ok: false, reason: "no_account" };
  }

  if (!isAccountRole(account.role) || !isAccountStatus(account.status)) {
    return {
      ok: false,
      reason: isAccountRole(account.role) ? "invalid_stored_status" : "invalid_stored_role",
    };
  }

  // La cuenta debe estar activa según la base de datos, no según el token.
  if (account.status !== "active") {
    return { ok: false, reason: "account_not_active" };
  }

  if (!claims) {
    return { ok: false, reason: "stale_claims_version" };
  }

  // Se exige número entero almacenado: un valor en texto indica datos
  // corruptos y se trata como sesión inválida (fallar cerrado).
  const storedVersion = account.claimsVersion;
  if (typeof storedVersion !== "number" || !Number.isInteger(storedVersion)) {
    return { ok: false, reason: "stale_claims_version" };
  }
  if (claims.claimsVersion !== storedVersion) {
    return { ok: false, reason: "stale_claims_version" };
  }

  // El rol del token debe coincidir con el almacenado: si un administrador ha
  // sido degradado, su token antiguo no sirve.
  if (claims.role !== account.role) {
    return { ok: false, reason: "role_mismatch" };
  }

  if (claims.status !== account.status) {
    return { ok: false, reason: "status_mismatch" };
  }

  return {
    ok: true,
    actor: {
      uid: account.uid,
      role: account.role as AccountRole,
      status: account.status as AccountStatus,
      personRol: (account.personRol as PersonRol | undefined) ?? null,
    },
  };
}

/**
 * Comprobación de coherencia entre el uid de la cookie y la ficha leída.
 * Se usa para no mezclar por error dos documentos distintos.
 */
export function assertSameAccount(uidFromToken: string, accountUid: string): boolean {
  return Boolean(uidFromToken) && uidFromToken === accountUid;
}

/**
 * ¿Se puede emitir una cookie de sesión para este token?
 *
 * Se aplica en el momento del canje (`POST /api/auth/session`), no solo al
 * leer la sesión. Sin esta comprobación, una cuenta pendiente de activación o
 * deshabilitada recibiría una cookie que después sería rechazada en cada
 * petición: funciona, pero deja al usuario con una sesión «a medias» y da una
 * cookie válida a alguien que no debería tenerla.
 *
 * La política es exactamente la misma que al leer (`resolveSession`), para que
 * no existan dos criterios distintos.
 */
export function assertSessionIssuable(
  claims: SessionClaims | null | undefined,
  account: AccountSnapshot | null | undefined,
): ResolvedAccount {
  const resolution = resolveSession(claims, account);

  if (resolution.ok) return resolution.actor;

  switch (resolution.reason) {
    case "no_account":
      throw new DomainError(
        "SESSION_NOT_ISSUABLE",
        "Esta cuenta no está dada de alta en Formación. Avisa a administración.",
        403,
      );
    case "account_not_active":
    case "invalid_stored_status":
      throw new DomainError(
        "ACCOUNT_NOT_ACTIVE",
        "La cuenta no está activa. Si tienes un código de activación, úsalo antes de entrar.",
        403,
      );
    case "invalid_stored_role":
      throw new DomainError(
        "SESSION_NOT_ISSUABLE",
        "La cuenta tiene un rol no reconocido. Avisa a administración.",
        403,
      );
    default:
      // Claims obsoletas o incoherentes con la ficha: se pide volver a entrar.
      throw new DomainError(
        "SESSION_NOT_ISSUABLE",
        "La sesión ha cambiado. Vuelve a iniciar sesión.",
        401,
      );
  }
}
