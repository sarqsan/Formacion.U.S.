import { DomainError } from "@/domain/text";
import {
  assertAdmin,
  assertCanRemoveAdmin,
  assertCanTransitionStatus,
  type Actor,
} from "@/domain/auth/authorization";
import { buildClaims } from "@/domain/auth/activation";
import type { AccountRole, AccountStatus, PersonRol } from "@/domain/roles";
import type { CredentialService } from "@/server/auth/activation-service";
import {
  activationExpiry,
  generateActivationToken,
  hashActivationToken,
} from "@/server/auth/tokens";

/**
 * ADMINISTRACIÓN DE CUENTAS (bloque 09)
 * =====================================
 *
 * Hasta aquí una cuenta solo cambiaba de estado al activarse. Las reglas de
 * transición (`assertCanTransitionStatus`), la protección del último
 * administrador (`assertCanRemoveAdmin`) y las claims con `claimsVersion`
 * existían desde el principio, pero **ninguna operación las usaba**: no había
 * forma de deshabilitar a nadie ni de reemitir un código de activación
 * caducado. Este servicio las pone en uso.
 *
 * Reglas que se sostienen aquí, y por qué:
 *
 *   · **Solo administración.** `assertAdmin` en cada operación, antes de leer.
 *   · **Transiciones válidas.** Se reutiliza la tabla del dominio: no se puede
 *     reactivar lo que nunca se deshabilitó ni pasar de un estado a sí mismo.
 *   · **Nunca se queda el sistema sin administración**, ni por deshabilitar ni
 *     por desactivarse uno mismo siendo el último.
 *   · **Deshabilitar cierra la puerta de verdad**: se incrementa
 *     `claimsVersion` (los tokens viejos dejan de valer), se escriben las claims
 *     nuevas y se revocan los refresh tokens de Firebase Auth. La sesión abierta
 *     muere en la siguiente petición, sin esperar a que caduque la cookie.
 *   · **Reemitir un código invalida el anterior.** Un código viejo filtrado no
 *     puede seguir sirviendo después de la reemisión.
 *   · **El código se ve una sola vez.** El servicio devuelve el token en claro
 *     a quien lo pidió y guarda **solo su hash**; no se registra en auditoría ni
 *     en el estado.
 *   · **Reemitir no activa ni reactiva.** Un código nuevo solo sirve para una
 *     cuenta `pending_activation`: reactivar una cuenta deshabilitada es otra
 *     operación, explícita, y no salta la contraseña.
 */

export interface AccountSnapshot {
  uid: string;
  username: string;
  displayName: string;
  personRol: PersonRol | string;
  role: AccountRole;
  status: AccountStatus;
  claimsVersion: number;
  createdAt: string;
}

export interface ActivationRecordSummary {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export type AccountAuditEvent =
  | {
      type: "account_disabled";
      actorUid: string;
      targetUid: string;
      at: string;
      reason: string | null;
      claimsVersion: number;
    }
  | {
      type: "account_enabled";
      actorUid: string;
      targetUid: string;
      at: string;
      claimsVersion: number;
    }
  | {
      type: "activation_reissued";
      actorUid: string;
      targetUid: string;
      at: string;
      expiresAt: string;
      revokedPrevious: number;
    };

/**
 * Puerto de persistencia de la administración de cuentas.
 *
 * Deliberadamente pequeño: no expone la colección de cuentas entera ni permite
 * escribir campos arbitrarios. Cada operación del servicio se traduce en una
 * escritura concreta.
 */
export interface AccountAdminStore {
  getAccount(uid: string): Promise<AccountSnapshot | null>;
  /** Administradores **activos**: base de la protección del último admin. */
  countActiveAdmins(): Promise<number>;
  /** Cambia estado y versión de claims en una sola escritura. */
  updateStatus(input: {
    uid: string;
    status: AccountStatus;
    claimsVersion: number;
    at: string;
    /** Se rellena al deshabilitar; se limpia al reactivar. */
    disabledAt: string | null;
  }): Promise<void>;
  listActivations(uid: string): Promise<ActivationRecordSummary[]>;
  /** Revoca los códigos que aún podrían usarse. Devuelve cuántos había. */
  revokeActivations(input: { uid: string; at: string; reason: string }): Promise<number>;
  createActivation(input: {
    uid: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
  }): Promise<void>;
  recordAudit(event: AccountAuditEvent): Promise<void>;
}

export interface AccountAdminDependencies {
  store: AccountAdminStore;
  /** Revocación de sesiones y claims. En la demo no hay Firebase: es un doble. */
  credentials: CredentialService;
  /** Validez de un código de activación reemitido (por defecto, 72 h). */
  activationTtlHours: number;
  now?: () => Date;
}

export interface ReissuedActivation {
  uid: string;
  username: string;
  /** En claro, UNA sola vez. No se guarda ni se audita. */
  token: string;
  expiresAt: string;
  /** Códigos anteriores que se han invalidado con la reemisión. */
  revokedPrevious: number;
}

async function loadTarget(
  store: AccountAdminStore,
  uid: string,
): Promise<AccountSnapshot> {
  const clean = typeof uid === "string" ? uid.trim() : "";
  if (!clean) {
    throw new DomainError("ACCOUNT_NOT_FOUND", "La cuenta no existe.", 404);
  }
  const account = await store.getAccount(clean);
  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND", "La cuenta no existe.", 404);
  }
  return account;
}

/**
 * Deshabilita una cuenta: deja de poder entrar en la siguiente petición.
 *
 * `reason` es texto libre para la auditoría (por ejemplo «baja del servicio»).
 * No se guarda nada del código de activación ni datos personales nuevos.
 */
export async function disableAccount(
  input: { actor: Actor; uid: string; reason?: string | null },
  deps: AccountAdminDependencies,
): Promise<AccountSnapshot> {
  const admin = assertAdmin(input.actor);
  const target = await loadTarget(deps.store, input.uid);

  assertCanTransitionStatus(target.status, "disabled");

  // Un administrador que se deshabilita a sí mismo siendo el último dejaría el
  // sistema sin administración: es la única operación irreversible sin consola.
  if (target.role === "admin") {
    assertCanRemoveAdmin(admin, target, await deps.store.countActiveAdmins());
  }

  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const claimsVersion = target.claimsVersion + 1;

  // 1. Estado y versión de claims, juntos: un token con la versión anterior deja
  //    de valer aunque todavía no haya caducado.
  await deps.store.updateStatus({
    uid: target.uid,
    status: "disabled",
    claimsVersion,
    at,
    disabledAt: at,
  });

  // 2. Claims nuevas y revocación de refresh tokens. Si esto fallara después de
  //    escribir el estado, la cuenta ya está cerrada por base de datos (el
  //    servidor relee la ficha en cada petición); las claims se corrigen en la
  //    siguiente operación. El orden es deliberado: primero cerrar el acceso.
  await deps.credentials.setClaims(
    target.uid,
    buildClaims({
      role: target.role,
      status: "disabled",
      // La ficha puede traer un rol de persona no reconocido (dato antiguo):
      // las claims solo llevan los valores que el dominio valida.
      personRol: target.personRol === "ROL 1" || target.personRol === "ROL 2" ? target.personRol : undefined,
      claimsVersion,
    }),
  );
  await deps.credentials.revokeRefreshTokens(target.uid);

  // 3. Un código de activación pendiente de una cuenta deshabilitada no debe
  //    poder reactivarla: deshabilitar es una decisión, no un descuido.
  await deps.store.revokeActivations({ uid: target.uid, at, reason: "account_disabled" });

  await deps.store.recordAudit({
    type: "account_disabled",
    actorUid: admin.uid,
    targetUid: target.uid,
    at,
    reason: input.reason?.trim() ? input.reason.trim().slice(0, 200) : null,
    claimsVersion,
  });

  return { ...target, status: "disabled", claimsVersion };
}

/**
 * Reactiva una cuenta deshabilitada.
 *
 * Solo vale para `disabled`: una cuenta `pending_activation` se activa con su
 * código y su contraseña, no por aquí. Así reactivar no se convierte en una vía
 * para saltarse la activación.
 */
export async function enableAccount(
  input: { actor: Actor; uid: string },
  deps: AccountAdminDependencies,
): Promise<AccountSnapshot> {
  const admin = assertAdmin(input.actor);
  const target = await loadTarget(deps.store, input.uid);

  if (target.status === "pending_activation") {
    throw new DomainError(
      "ACCOUNT_PENDING_ACTIVATION",
      "La cuenta todavía no se ha activado. Reemite su código de activación en lugar de reactivarla.",
      409,
    );
  }

  assertCanTransitionStatus(target.status, "active");

  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const claimsVersion = target.claimsVersion + 1;

  await deps.store.updateStatus({
    uid: target.uid,
    status: "active",
    claimsVersion,
    at,
    disabledAt: null,
  });
  await deps.credentials.setClaims(
    target.uid,
    buildClaims({
      role: target.role,
      status: "active",
      personRol: target.personRol === "ROL 1" || target.personRol === "ROL 2" ? target.personRol : undefined,
      claimsVersion,
    }),
  );
  // Nadie hereda una sesión anterior: al reactivar se entra de nuevo.
  await deps.credentials.revokeRefreshTokens(target.uid);

  await deps.store.recordAudit({
    type: "account_enabled",
    actorUid: admin.uid,
    targetUid: target.uid,
    at,
    claimsVersion,
  });

  return { ...target, status: "active", claimsVersion };
}

/**
 * Resumen de los códigos de activación de una cuenta, para la ficha de
 * administración.
 *
 * No devuelve los hashes: la pantalla solo necesita saber si hay un código
 * utilizable y hasta cuándo. Los hashes no son secretos, pero tampoco hacen
 * falta fuera del almacén.
 */
export async function activationSummary(
  input: { actor: Actor; uid: string },
  deps: AccountAdminDependencies,
): Promise<{ pending: number; used: number; revoked: number; expiresAt: string | null }> {
  assertAdmin(input.actor);
  const target = await loadTarget(deps.store, input.uid);
  const activations = await deps.store.listActivations(target.uid);

  const pending = activations.filter((token) => !token.usedAt && !token.revokedAt);
  return {
    pending: pending.length,
    used: activations.filter((token) => token.usedAt).length,
    revoked: activations.filter((token) => token.revokedAt).length,
    expiresAt: pending.length > 0 ? pending[pending.length - 1].expiresAt : null,
  };
}

/**
 * Emite un código de activación nuevo y anula los anteriores.
 *
 * Devuelve el token en claro **una sola vez**: es la única forma de entregarlo
 * sin correo. En la base queda solo el hash, igual que en la importación.
 */
export async function reissueActivationCode(
  input: { actor: Actor; uid: string },
  deps: AccountAdminDependencies,
): Promise<ReissuedActivation> {
  const admin = assertAdmin(input.actor);
  const target = await loadTarget(deps.store, input.uid);

  if (target.status === "active") {
    throw new DomainError(
      "ACTIVATION_NOT_APPLICABLE",
      "La cuenta ya está activa: no necesita código de activación.",
      409,
    );
  }
  if (target.status === "disabled") {
    throw new DomainError(
      "ACTIVATION_NOT_APPLICABLE",
      "La cuenta está deshabilitada. Reactívala antes de emitir un código.",
      409,
    );
  }

  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();

  // 1. Los códigos anteriores dejan de valer ANTES de emitir el nuevo: si algo
  //    falla en medio, la cuenta se queda sin código utilizable (se puede pedir
  //    otro), nunca con dos válidos a la vez.
  const revokedPrevious = await deps.store.revokeActivations({
    uid: target.uid,
    at,
    reason: "reissued",
  });

  // 2. Token nuevo: 32 bytes aleatorios, en la base solo el hash.
  const token = generateActivationToken();
  const expiresAt = activationExpiry(now, deps.activationTtlHours).toISOString();

  await deps.store.createActivation({
    uid: target.uid,
    tokenHash: hashActivationToken(token),
    createdAt: at,
    expiresAt,
    createdBy: admin.uid,
  });

  // 3. Auditoría sin el token: se registra que se emitió, no el secreto.
  await deps.store.recordAudit({
    type: "activation_reissued",
    actorUid: admin.uid,
    targetUid: target.uid,
    at,
    expiresAt,
    revokedPrevious,
  });

  return {
    uid: target.uid,
    username: target.username,
    token,
    expiresAt,
    revokedPrevious,
  };
}
