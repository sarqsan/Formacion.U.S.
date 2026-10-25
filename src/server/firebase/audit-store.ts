import { COLLECTIONS } from "@/server/db/schema.constants";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";
import type { AuditReader } from "@/server/audit/activity";

/**
 * LECTURA DEL REGISTRO DE ACTIVIDAD (Firestore)
 * ============================================
 *
 * Ordena por `at` (la fecha del evento, escrita por el servicio) y no por
 * `recordedAt` (la marca del servidor), porque la primera está en todos los
 * eventos desde el principio y la segunda solo en los que pasan por
 * `recordAudit`.
 *
 * Sin índices nuevos: es una consulta de una sola colección ordenada por un
 * campo, que Firestore resuelve con su índice automático.
 */
export class FirestoreAuditReader implements AuditReader {
  async listRecent(limit: number): Promise<Array<Record<string, unknown>>> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.audits)
        .orderBy("at", "desc")
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Record<string, unknown>) }));
    });
  }
}
