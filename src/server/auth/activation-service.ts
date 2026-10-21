import { DomainError } from "@/domain/text";
import {
  assertActivationUsable,
  assertPasswordAcceptable,
  buildClaims,
  type ActivationRecord,
} from "@/domain/auth/activation";
import type { AccountStatus, PersonRol } from "@/domain/roles";
import {
  activationTokenMatches,
  hashActivationToken,
  isValidActivationTokenFormat,
} from "@/server/auth/tokens";

/**
 * ACTIVACIÓN DE CUENTA (servidor)
 * ===============================
 *
 * No hay registro público: una cuenta solo existe si un administrador la
 * importó. La activación exige el token de un solo uso que se entrega fuera
 * del sistema.
 *
 * Propiedades buscadas:
 * - El token no se puede adivinar (256 bits) y solo se guarda su hash.
 * - Un token es de una cuenta concreta: no sirve para otra.
 * - Un token usado, caducado o revocado no sirve.
 * - La contraseña la elige el usuario y cumple política; se fija vía Admin SDK.
 * - Al activar desaparece `pending_activation` y se refrescan las claims con
 *   `claimsVersion` incrementada, invalidando sesiones previas.
 * - Los mensajes de error no permiten distinguir "token inexistente" de
 *   "token de otra cuenta" (evita enumeración).
 */

export interface ActivationAccountSnapshot {
  uid: string;
  username: string;
  status: AccountStatus;
  claimsVersion: number;
  personRol: PersonRol;
}

export interface ActivationStore {
  findActivationByHash(hash: string): Promise<ActivationRecord | null>;
  getAccount(uid: string): Promise<ActivationAccountSnapshot | null>;
  /** Marca el token como usado de forma atómica (transacción). */
  consumeActivation(input: { tokenHash: string; uid: string; usedAt: string }): Promise<void>;
  markAccountActive(input: {
    uid: string;
    activatedAt: string;
    claimsVersion: number;
  }): Promise<void>;
}

export interface CredentialService {
  setPassword(uid: string, newPassword: string): Promise<void>;
  setClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface ActivationDependencies {
  store: ActivationStore;
  credentials: CredentialService;
  now?: () => Date;
}

export interface ActivationInput {
  username: string;
  token: string;
  newPassword: string;
}

const GENERIC_INVALID =
  "El código de activación no es válido o ha caducado. Solicita uno nuevo a administración.";

function invalid(): DomainError {
  return new DomainError("ACTIVATION_INVALID", GENERIC_INVALID, 400);
}

export async function activateAccount(
  input: ActivationInput,
  deps: ActivationDependencies,
): Promise<{ uid: string; username: string }> {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();

  if (!isValidActivationTokenFormat(input.token)) {
    // Formato incorrecto: mismo mensaje que token inexistente.
    throw invalid();
  }

  const username = input.username?.trim().toLowerCase();
  if (!username) {
    throw new DomainError("USERNAME_REQUIRED", "Indica tu nombre de usuario.", 400);
  }

  const tokenHash = hashActivationToken(input.token);
  const record = await deps.store.findActivationByHash(tokenHash);

  // Comparación en tiempo constante y misma respuesta si no existe.
  if (!record || !activationTokenMatches(input.token, record.tokenHash)) {
    throw invalid();
  }

  try {
    assertActivationUsable(record, nowIso);
  } catch (error) {
    if (error instanceof DomainError && error.code === "ACTIVATION_EXPIRED") {
      throw new DomainError(
        "ACTIVATION_EXPIRED",
        "El código de activación ha caducado. Solicita uno nuevo a administración.",
        410,
      );
    }
    throw error;
  }

  const account = await deps.store.getAccount(record.uid);
  if (!account || account.username.toLowerCase() !== username) {
    // No se revela si el token existe para otra cuenta.
    throw invalid();
  }

  if (account.status !== "pending_activation") {
    throw new DomainError(
      "ACTIVATION_NOT_PENDING",
      "Esta cuenta ya está activada. Inicia sesión con tu contraseña.",
      409,
    );
  }

  // Política de contraseña ANTES de tocar nada.
  assertPasswordAcceptable(input.newPassword, { username: account.username });

  const nextClaimsVersion = account.claimsVersion + 1;

  // 1. Contraseña personal (nunca se registra ni se devuelve).
  await deps.credentials.setPassword(account.uid, input.newPassword);

  // 2. Claims: activo, rol de cuenta intacto (siempre learner en este flujo).
  await deps.credentials.setClaims(
    account.uid,
    buildClaims({
      role: "learner",
      status: "active",
      personRol: account.personRol,
      claimsVersion: nextClaimsVersion,
    }),
  );

  // 3. Consumir el token (atómico) y activar la cuenta.
  await deps.store.consumeActivation({ tokenHash, uid: account.uid, usedAt: nowIso });
  await deps.store.markAccountActive({
    uid: account.uid,
    activatedAt: nowIso,
    claimsVersion: nextClaimsVersion,
  });

  // 4. Invalidar cualquier sesión previa de esa cuenta.
  await deps.credentials.revokeRefreshTokens(account.uid);

  return { uid: account.uid, username: account.username };
}
