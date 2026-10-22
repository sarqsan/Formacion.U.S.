import type { AccountStatus } from "@/domain/roles";
import type { CredentialService } from "@/server/auth/activation-service";
import type {
  AccountAdminDependencies,
  AccountAdminStore,
  AccountAuditEvent,
  AccountSnapshot,
  ActivationRecordSummary,
} from "@/server/accounts/service";
import { ACTIVATION_TOKEN_TTL_HOURS } from "@/domain/auth/activation";
import { demoState } from "@/demo/store";

/**
 * ADMINISTRACIÓN DE CUENTAS EN LA DEMOSTRACIÓN
 * ===========================================
 *
 * Mismo servicio (`src/server/accounts/service.ts`) que en producción, con el
 * estado en memoria. Lo que se guarda y lo que se comprueba es lo mismo:
 * transiciones, versión de claims, códigos de activación por hash y auditoría.
 *
 * Lo que **no** demuestra: que Firebase Auth revoque de verdad los refresh
 * tokens ni que las claims se propaguen. Aquí el «cierre de sesión» es real
 * dentro del proceso porque cada petición relee la ficha de la cuenta
 * (`getDemoActor`), que es justo la propiedad que interesa fijar.
 */

export class DemoAccountAdminStore implements AccountAdminStore {
  async getAccount(uid: string): Promise<AccountSnapshot | null> {
    const account = demoState().accounts.find((item) => item.uid === uid);
    if (!account) return null;
    return {
      uid: account.uid,
      username: account.username,
      displayName: account.displayName,
      personRol: account.personRol,
      role: account.role,
      status: account.status,
      claimsVersion: account.claimsVersion,
      createdAt: account.createdAt,
    };
  }

  async countActiveAdmins(): Promise<number> {
    return demoState().accounts.filter(
      (account) => account.role === "admin" && account.status === "active",
    ).length;
  }

  async updateStatus(input: {
    uid: string;
    status: AccountStatus;
    claimsVersion: number;
    at: string;
    disabledAt: string | null;
  }): Promise<void> {
    const account = demoState().accounts.find((item) => item.uid === input.uid);
    if (!account) return;
    account.status = input.status;
    account.claimsVersion = input.claimsVersion;
    account.disabledAt = input.disabledAt;
  }

  async listActivations(uid: string): Promise<ActivationRecordSummary[]> {
    return [...demoState().activationTokens.entries()]
      .filter(([, token]) => token.uid === uid)
      .map(([tokenHash, token]) => ({
        tokenHash,
        createdAt: token.createdAt,
        expiresAt: token.expiresAt,
        usedAt: token.usedAt,
        revokedAt: token.revokedAt,
      }));
  }

  async revokeActivations(input: { uid: string; at: string; reason: string }): Promise<number> {
    let revoked = 0;
    for (const token of demoState().activationTokens.values()) {
      if (token.uid !== input.uid) continue;
      if (token.usedAt || token.revokedAt) continue;
      token.revokedAt = input.at;
      revoked += 1;
    }
    return revoked;
  }

  async createActivation(input: {
    uid: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
  }): Promise<void> {
    demoState().activationTokens.set(input.tokenHash, {
      uid: input.uid,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    });
  }

  async recordAudit(event: AccountAuditEvent): Promise<void> {
    demoState().audits.push({ ...event });
  }
}

/**
 * Doble de credenciales: no hay Firebase Authentication.
 *
 * Guarda lo que se le pide (claims y revocaciones) para que las pruebas puedan
 * comprobar que deshabilitar **también** cierra la puerta por ese lado, sin
 * fingir que se ha hablado con Firebase.
 */
export class DemoCredentials implements CredentialService {
  claims = new Map<string, Record<string, unknown>>();
  revoked: string[] = [];

  async setPassword(): Promise<void> {
    throw new Error("La demostración no cambia contraseñas: no hay Firebase Authentication.");
  }

  async setClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
    this.claims.set(uid, claims);
  }

  async revokeRefreshTokens(uid: string): Promise<void> {
    this.revoked.push(uid);
  }
}

/** Doble de credenciales compartido por el proceso de la demostración. */
const demoCredentials = new DemoCredentials();

/** Dependencias para las operaciones de administración de cuentas. */
export function demoAccountAdminDeps(): AccountAdminDependencies {
  return {
    store: new DemoAccountAdminStore(),
    credentials: demoCredentials,
    activationTtlHours: ACTIVATION_TOKEN_TTL_HOURS,
  };
}

/** Solo para pruebas: acceso al doble de credenciales del proceso. */
export function demoCredentialsForTests(): DemoCredentials {
  return demoCredentials;
}
