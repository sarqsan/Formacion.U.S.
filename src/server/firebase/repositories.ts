import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import type { AccountProvisionInput, AccountProvisioner, AuditLog, PersonDirectory } from "@/server/import/service";
import type {
  ActivationAccountSnapshot,
  ActivationStore,
  CredentialService,
} from "@/server/auth/activation-service";
import type { ActivationRecord } from "@/domain/auth/activation";
import { isAccountRole, isAccountStatus, type PersonRol } from "@/domain/roles";
import { getAdminAuth, getAdminDb } from "@/server/firebase/admin";

/**
 * ADAPTADORES REALES (Firestore + Firebase Auth)
 * =============================================
 *
 * Colecciones:
 *   accounts/{uid}            datos de cuenta (fuente de verdad del estado)
 *   usernames/{username}      reserva de unicidad del nombre de usuario
 *   activationTokens/{hash}   hash SHA-256 del token, caducidad, uso
 *   audits/{autoId}           registro de acciones administrativas
 *   progress/{uid}_{course}   progreso de curso (versionado)
 *   attempts/{autoId}         intentos de evaluación (auditoría de corrección)
 *   courses/{courseId}/versions/{n}   contenido inmutable por versión
 *
 * Este fichero NO se ha ejecutado en esta fase: no hay proyecto Firebase
 * conectado. Está verificado por tipos, no por integración (ver docs/PRUEBAS.md).
 */


/**
 * Traduce fallos de infraestructura a 503. Nunca se propaga un mensaje de
 * gRPC/Firebase al cliente ni se filtra detalle interno.
 */
export async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "FIREBASE_UNAVAILABLE",
      "El servicio de datos no está disponible en este momento. Inténtalo más tarde.",
      503,
    );
  }
}

function notConfigured(error: unknown): never {
  if (error instanceof DomainError) throw error;
  throw new DomainError(
    "FIREBASE_UNAVAILABLE",
    "El servicio de identidad no está disponible. Avisa a administración.",
    503,
  );
}

export class FirestorePersonDirectory implements PersonDirectory {
  async listTakenUsernames(): Promise<ReadonlySet<string>> {
    return guard(async () => {
      const snapshot = await getAdminDb().collection("usernames").select().get();
      return new Set(snapshot.docs.map((doc) => doc.id));
    });
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    return guard(async () => {
      const doc = await getAdminDb().collection("usernames").doc(username).get();
      return doc.exists;
    });
  }
}

export class FirestoreAccountProvisioner implements AccountProvisioner {
  async createAccount(input: AccountProvisionInput): Promise<{ uid: string }> {
    const db = getAdminDb();
    const auth = getAdminAuth();
    const reservationRef = db.collection("usernames").doc(input.username);

    // 1. Reserva atómica de unicidad (evita dos importaciones simultáneas).
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reservationRef);
        if (snapshot.exists) {
          throw new DomainError(
            "USERNAME_CONFLICT",
            `El usuario «${input.username}» ya existe.`,
            409,
          );
        }
        transaction.create(reservationRef, {
          uid: null,
          reservedAt: input.createdAt,
          reservedBy: input.createdBy,
        });
      });
    } catch (error) {
      notConfigured(error);
    }

    let uid: string | null = null;

    try {
      // 2. Cuenta de Authentication con contraseña aleatoria no distribuida.
      const userRecord = await auth.createUser({
        email: input.authEmail,
        password: input.randomPassword,
        displayName: `${input.apellido} (${input.username})`,
        disabled: false,
        emailVerified: false,
      });
      uid = userRecord.uid;

      // 3. Claims iniciales (siempre learner + pending_activation).
      await auth.setCustomUserClaims(uid, input.claims);

      // 4. Documento de cuenta + token de activación (solo hash).
      const batch = db.batch();
      batch.create(db.collection("accounts").doc(uid), {
        uid,
        username: input.username,
        authEmail: input.authEmail,
        apellido: input.apellido,
        personRol: input.personRol,
        role: "learner",
        status: "pending_activation",
        claimsVersion: 1,
        createdAt: input.createdAt,
        createdBy: input.createdBy,
        activatedAt: null,
        disabledAt: null,
      });
      batch.create(db.collection("activationTokens").doc(input.activationTokenHash), {
        uid,
        createdAt: input.createdAt,
        expiresAt: input.activationExpiresAt,
        usedAt: null,
        revokedAt: null,
      });
      batch.update(reservationRef, { uid });
      await batch.commit();

      return { uid };
    } catch (error) {
      if (uid) {
        await this.rollbackAccount(uid, "provision_failed");
      } else {
        await reservationRef.delete().catch(() => undefined);
      }
      notConfigured(error);
    }
  }

  async rollbackAccount(uid: string, reason: string): Promise<void> {
    const db = getAdminDb();
    const auth = getAdminAuth();

    try {
      const accountRef = db.collection("accounts").doc(uid);
      const accountDoc = await accountRef.get();
      const username = accountDoc.exists
        ? (accountDoc.data() as { username?: string }).username
        : undefined;

      const batch = db.batch();
      if (accountDoc.exists) batch.delete(accountRef);
      if (username) batch.delete(db.collection("usernames").doc(username));
      await batch.commit();

      await db.collection("audits").add({
        type: "account_rollback",
        uid,
        reason,
        at: new Date().toISOString(),
        severity: "warning",
      });

      await auth.deleteUser(uid);
    } catch {
      // Si no se puede borrar, al menos se deja inutilizable.
      await auth.updateUser(uid, { disabled: true }).catch(() => undefined);
    }
  }
}

export class FirestoreAuditLog implements AuditLog {
  async record(event: Parameters<AuditLog["record"]>[0]): Promise<void> {
    await guard(() => getAdminDb().collection("audits").add({ ...event, severity: "info" }));
  }
}

export class FirestoreActivationStore implements ActivationStore {
  async findActivationByHash(hash: string): Promise<ActivationRecord | null> {
    return guard(async () => {
      const doc = await getAdminDb().collection("activationTokens").doc(hash).get();
      if (!doc.exists) return null;
      const data = doc.data() as Omit<ActivationRecord, "tokenHash">;
      return { ...data, tokenHash: hash };
    });
  }

  async getAccount(uid: string): Promise<ActivationAccountSnapshot | null> {
    return guard(async () => {
    const doc = await getAdminDb().collection("accounts").doc(uid).get();
    if (!doc.exists) return null;
    const data = doc.data() as {
      username: string;
      status: string;
      claimsVersion: number;
      personRol: string;
      role: string;
    };

    if (!isAccountStatus(data.status) || !isAccountRole(data.role)) return null;
    const personRol = data.personRol as PersonRol;

    return {
      uid,
      username: data.username,
      status: data.status,
      claimsVersion: Number(data.claimsVersion ?? 0),
      personRol,
    };
    });
  }

  async consumeActivation(input: {
    tokenHash: string;
    uid: string;
    usedAt: string;
  }): Promise<void> {
    const db = getAdminDb();
    const ref = db.collection("activationTokens").doc(input.tokenHash);

    await guard(() => db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        throw new DomainError("ACTIVATION_INVALID", "Código de activación no válido.", 400);
      }
      const data = snapshot.data() as { uid: string; usedAt: string | null };
      if (data.usedAt) {
        throw new DomainError(
          "ACTIVATION_ALREADY_USED",
          "Ese código de activación ya se ha utilizado.",
          409,
        );
      }
      if (data.uid !== input.uid) {
        throw new DomainError("ACTIVATION_INVALID", "Código de activación no válido.", 400);
      }
      transaction.update(ref, { usedAt: input.usedAt });
    }));
  }

  async markAccountActive(input: {
    uid: string;
    activatedAt: string;
    claimsVersion: number;
  }): Promise<void> {
    await guard(() =>
      getAdminDb().collection("accounts").doc(input.uid).update({
        status: "active",
        activatedAt: input.activatedAt,
        claimsVersion: input.claimsVersion,
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );
  }
}

export class FirebaseCredentialService implements CredentialService {
  async setPassword(uid: string, newPassword: string): Promise<void> {
    // Firebase guarda el hash con scrypt; nunca la contraseña en claro.
    await guard(() => getAdminAuth().updateUser(uid, { password: newPassword }));
  }

  async setClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
    await guard(() => getAdminAuth().setCustomUserClaims(uid, claims));
  }

  async revokeRefreshTokens(uid: string): Promise<void> {
    await guard(() => getAdminAuth().revokeRefreshTokens(uid));
  }
}
