import type { AccountStatus } from "@/domain/roles";
import type { CredentialService } from "@/server/auth/activation-service";
import type {
  AccountAdminStore,
  AccountAuditEvent,
  AccountSnapshot,
  ActivationRecordSummary,
} from "@/server/accounts/service";

/**
 * DOBLE DE ADMINISTRACIÓN DE CUENTAS
 * ==================================
 *
 * Almacén en memoria con el mismo contrato que `FirestoreAccountAdminStore`,
 * más un registro de lo que se le pide al servicio de credenciales. Sirve para
 * comprobar dos cosas que en Firestore no se pueden ver sin emulador:
 *
 *   - que deshabilitar **también** escribe claims nuevas y revoca refresh
 *     tokens (no solo cambia el campo `status`);
 *   - que no se escribe nada cuando la operación se rechaza.
 *
 * **No demuestra** que Firebase Auth revoque de verdad ni que las claims se
 * propaguen: eso exige el proyecto real.
 */

export class InMemoryAccountAdminStore implements AccountAdminStore {
  accounts = new Map<string, AccountSnapshot>();
  activations: Array<ActivationRecordSummary & { uid: string; revokedReason?: string }> = [];
  audits: AccountAuditEvent[] = [];
  /** Escrituras de estado, para comprobar que un rechazo no escribe. */
  statusWrites = 0;

  seed(account: Partial<AccountSnapshot> & { uid: string }): this {
    this.accounts.set(account.uid, {
      uid: account.uid,
      username: account.username ?? account.uid,
      displayName: account.displayName ?? account.username ?? account.uid,
      personRol: account.personRol ?? "ROL 1",
      role: account.role ?? "learner",
      status: account.status ?? "active",
      claimsVersion: account.claimsVersion ?? 1,
      createdAt: account.createdAt ?? "2026-01-01T09:00:00.000Z",
    });
    return this;
  }

  seedActivation(input: {
    uid: string;
    tokenHash: string;
    usedAt?: string | null;
    revokedAt?: string | null;
  }): this {
    this.activations.push({
      uid: input.uid,
      tokenHash: input.tokenHash,
      createdAt: "2026-01-01T09:00:00.000Z",
      expiresAt: "2026-01-04T09:00:00.000Z",
      usedAt: input.usedAt ?? null,
      revokedAt: input.revokedAt ?? null,
    });
    return this;
  }

  async getAccount(uid: string): Promise<AccountSnapshot | null> {
    const account = this.accounts.get(uid);
    return account ? { ...account } : null;
  }

  async countActiveAdmins(): Promise<number> {
    return [...this.accounts.values()].filter(
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
    const account = this.accounts.get(input.uid);
    if (!account) return;
    this.statusWrites += 1;
    this.accounts.set(input.uid, {
      ...account,
      status: input.status,
      claimsVersion: input.claimsVersion,
    });
  }

  async listActivations(uid: string): Promise<ActivationRecordSummary[]> {
    return this.activations.filter((token) => token.uid === uid);
  }

  async revokeActivations(input: { uid: string; at: string; reason: string }): Promise<number> {
    let revoked = 0;
    for (const token of this.activations) {
      if (token.uid !== input.uid || token.usedAt || token.revokedAt) continue;
      token.revokedAt = input.at;
      token.revokedReason = input.reason;
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
    this.activations.push({
      uid: input.uid,
      tokenHash: input.tokenHash,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    });
  }

  async recordAudit(event: AccountAuditEvent): Promise<void> {
    this.audits.push(event);
  }
}

/** Graba claims y revocaciones: lo que el servicio pide a Firebase Auth. */
export class RecordingCredentials implements CredentialService {
  claims = new Map<string, Record<string, unknown>>();
  revoked: string[] = [];
  passwordChanges = 0;

  async setPassword(): Promise<void> {
    this.passwordChanges += 1;
  }

  async setClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
    this.claims.set(uid, claims);
  }

  async revokeRefreshTokens(uid: string): Promise<void> {
    this.revoked.push(uid);
  }
}
