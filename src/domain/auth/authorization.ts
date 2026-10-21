import { DomainError } from "@/domain/text";
import type { AccountRole, AccountStatus } from "@/domain/roles";

/**
 * REGLAS DE AUTORIZACIÓN (puras)
 * ==============================
 *
 * Se aplican en el servidor en cada endpoint. Las reglas de Firestore y las
 * Custom Claims son la segunda barrera; nunca la única.
 */

export interface Actor {
  uid: string;
  role: AccountRole;
  status: AccountStatus;
}

export function isUsable(actor: Actor | null | undefined): boolean {
  return Boolean(actor && actor.status === "active" && actor.uid);
}

export function assertActiveAccount(actor: Actor | null | undefined): Actor {
  if (!actor || !actor.uid) {
    throw new DomainError("UNAUTHENTICATED", "Sesión no válida.", 401);
  }
  if (actor.status !== "active") {
    throw new DomainError(
      "ACCOUNT_NOT_ACTIVE",
      "La cuenta no está activa.",
      403,
    );
  }
  return actor;
}

export function assertAdmin(actor: Actor | null | undefined): Actor {
  const active = assertActiveAccount(actor);
  if (active.role !== "admin") {
    throw new DomainError("FORBIDDEN", "Se requiere rol de administrador.", 403);
  }
  return active;
}

/**
 * Un usuario solo puede ver su propio progreso; un administrador puede ver el
 * de cualquiera. Evita el acceso por cambio de identificador en la URL.
 */
export function assertCanReadProgress(
  actor: Actor | null | undefined,
  targetUid: string,
): void {
  const active = assertActiveAccount(actor);
  if (active.uid === targetUid) return;
  if (active.role === "admin") return;
  throw new DomainError("FORBIDDEN", "No puedes consultar el progreso de otro usuario.", 403);
}

/**
 * Protección del último administrador: nunca se puede dejar el sistema sin
 * ningún administrador activo (bloqueo irreversible sin acceso a consola).
 */
export function assertCanRemoveAdmin(
  actor: Actor,
  target: { uid: string; role: AccountRole },
  activeAdminCount: number,
): void {
  assertAdmin(actor);
  if (target.role === "admin" && activeAdminCount <= 1) {
    throw new DomainError(
      "LAST_ADMIN",
      "No se puede retirar el último administrador activo.",
      409,
    );
  }
}

const ALLOWED_TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  pending_activation: ["active", "disabled"],
  active: ["disabled"],
  disabled: ["active"],
};

export function assertCanTransitionStatus(
  from: AccountStatus,
  to: AccountStatus,
): void {
  if (from === to) {
    throw new DomainError("STATUS_UNCHANGED", "El estado ya es ese.", 409);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "STATUS_TRANSITION_INVALID",
      `No se puede pasar de «${from}» a «${to}».`,
      409,
    );
  }
}

/**
 * Cambio de rol permitido y comprobación de escalada:
 * un administrador no puede conceder el rol de administrador a través de la
 * importación (eso ya lo garantiza el servicio) ni quitarse el último.
 */
export function assertCanChangeRole(
  actor: Actor,
  targetUid: string,
  nextRole: AccountRole,
  activeAdminCount: number,
): void {
  assertAdmin(actor);
  if (nextRole === "admin") {
    throw new DomainError(
      "ROLE_ESCALATION_BLOCKED",
      "El rol de administrador no se concede desde esta vía.",
      403,
    );
  }
  if (nextRole === "learner" && activeAdminCount <= 1) {
    const isSelf = targetUid === actor.uid;
    if (isSelf) {
      throw new DomainError(
        "LAST_ADMIN",
        "No puedes quitarte el rol siendo el último administrador activo.",
        409,
      );
    }
  }
}
