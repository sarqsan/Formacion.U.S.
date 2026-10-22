import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import type { AccountRole, AccountStatus } from "@/domain/roles";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { getAdminDb } from "@/server/firebase/admin";
import type {
  AccountAdminStore,
  AccountAuditEvent,
  AccountSnapshot,
  ActivationRecordSummary,
} from "@/server/accounts/service";

/**
 * IMPLEMENTACIÓN FIRESTORE DE LA ADMINISTRACIÓN DE CUENTAS (bloque 09)
 * ==================================================================
 *
 * Colecciones que toca, y solo esas:
 *
 *   accounts/{uid}             lectura de la ficha y cambio de estado + claims
 *   activationTokens/{hash}    códigos: se crean por hash y se revocan
 *   audits/{autoId}            una entrada por acción, sin secretos
 *
 * Lo que **no** hace: no borra cuentas, no cambia roles, no toca contraseñas y
 * no escribe nunca el token en claro (solo su hash, como la importación).
 *
 * `countActiveAdmins` usa la consulta `role == admin && status == active`, que
 * es exactamente el índice compuesto ya declarado en `firestore.indexes.json`
 * (el mismo que usa `db:check`). No se añade ningún índice nuevo.
 */

async function guard<T>(operation: () => Promise<T>): Promise<T> {
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

interface AccountDocumentLike {
  uid?: string;
  username?: string;
  apellido?: string;
  personRol?: string;
  role?: string;
  status?: string;
  claimsVersion?: number;
  createdAt?: string;
}

function toSnapshot(uid: string, data: AccountDocumentLike): AccountSnapshot {
  const username = String(data.username ?? "");
  return {
    uid,
    username,
    displayName: data.apellido ? `${data.apellido} (${username})` : username || uid,
    personRol: data.personRol ?? "—",
    role: (data.role === "admin" ? "admin" : "learner") as AccountRole,
    status: (data.status ?? "pending_activation") as AccountStatus,
    claimsVersion:
      typeof data.claimsVersion === "number" && Number.isFinite(data.claimsVersion)
        ? data.claimsVersion
        : 1,
    createdAt: data.createdAt ?? "",
  };
}

export class FirestoreAccountAdminStore implements AccountAdminStore {
  async getAccount(uid: string): Promise<AccountSnapshot | null> {
    return guard(async () => {
      const doc = await getAdminDb().collection(COLLECTIONS.accounts).doc(uid).get();
      if (!doc.exists) return null;
      return toSnapshot(doc.id, doc.data() as AccountDocumentLike);
    });
  }

  async countActiveAdmins(): Promise<number> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.accounts)
        .where("role", "==", "admin")
        .where("status", "==", "active")
        .count()
        .get();
      return snapshot.data().count;
    });
  }

  /**
   * Estado y versión de claims en una sola escritura: si se separaran, una
   * petición podría leer el estado nuevo con la versión vieja y aceptar un
   * token que debería estar muerto.
   */
  async updateStatus(input: {
    uid: string;
    status: AccountStatus;
    claimsVersion: number;
    at: string;
    disabledAt: string | null;
  }): Promise<void> {
    return guard(async () => {
      await getAdminDb()
        .collection(COLLECTIONS.accounts)
        .doc(input.uid)
        .update({
          status: input.status,
          claimsVersion: input.claimsVersion,
          disabledAt: input.disabledAt,
          updatedAt: FieldValue.serverTimestamp(),
          ...(input.status === "disabled" ? { disabledByAt: input.at } : {}),
        });
    });
  }

  async listActivations(uid: string): Promise<ActivationRecordSummary[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.activationTokens)
        .where("uid", "==", uid)
        .limit(50)
        .get();
      return snapshot.docs.map((doc) => {
        const data = doc.data() as {
          createdAt?: string;
          expiresAt?: string;
          usedAt?: string | null;
          revokedAt?: string | null;
        };
        return {
          tokenHash: doc.id,
          createdAt: data.createdAt ?? "",
          expiresAt: data.expiresAt ?? "",
          usedAt: data.usedAt ?? null,
          revokedAt: data.revokedAt ?? null,
        };
      });
    });
  }

  /**
   * Revoca los códigos que aún podrían usarse (ni consumidos ni revocados).
   * Los usados se dejan como están: son historia, no permisos.
   */
  async revokeActivations(input: { uid: string; at: string; reason: string }): Promise<number> {
    return guard(async () => {
      const db = getAdminDb();
      const snapshot = await db
        .collection(COLLECTIONS.activationTokens)
        .where("uid", "==", input.uid)
        .limit(50)
        .get();

      const pending = snapshot.docs.filter((doc) => {
        const data = doc.data() as { usedAt?: string | null; revokedAt?: string | null };
        return !data.usedAt && !data.revokedAt;
      });
      if (pending.length === 0) return 0;

      const batch = db.batch();
      for (const doc of pending) {
        batch.update(doc.ref, {
          revokedAt: input.at,
          revokedReason: input.reason,
        });
      }
      await batch.commit();
      return pending.length;
    });
  }

  async createActivation(input: {
    uid: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
    createdBy: string;
  }): Promise<void> {
    return guard(async () => {
      // `create()` y no `set()`: si el hash ya existiera sería un fallo de
      // entropía y no debe sobrescribirse un código vivo.
      await getAdminDb()
        .collection(COLLECTIONS.activationTokens)
        .doc(input.tokenHash)
        .create({
          uid: input.uid,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          usedAt: null,
          revokedAt: null,
          createdBy: input.createdBy,
          createdFrom: "admin_reissue",
        });
    });
  }

  async recordAudit(event: AccountAuditEvent): Promise<void> {
    return guard(async () => {
      // Sin token, sin contraseña y sin datos personales nuevos.
      await getAdminDb()
        .collection(COLLECTIONS.audits)
        .add({ ...event, recordedAt: FieldValue.serverTimestamp() });
    });
  }
}
