import { COLLECTIONS } from "@/server/db/schema.constants";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";
import type { CertificateRecord } from "@/domain/certificates/certificate";
import type {
  CertificateAudit,
  CertificateStore,
} from "@/server/certificates/service";

/**
 * CERTIFICADOS EN FIRESTORE
 * =========================
 *
 * `certificates/{code}`, con el código determinista como id del documento. Eso
 * permite una emisión idempotente **sin transacción y sin consulta previa**:
 *
 *   · `create()` escribe solo si el documento no existe y falla con
 *     `ALREADY_EXISTS` si ya está. Esa carrera (dos pestañas pidiendo el mismo
 *     certificado) la resuelve Firestore, no una comprobación previa que podría
 *     perder.
 *   · Un `set()` normal **sobrescribiría** el documento y podría cambiar la
 *     fecha de emisión de un certificado ya entregado. No se usa.
 *
 * La colección está cerrada al cliente en `firestore.rules`: el nombre completo
 * de la persona no se sirve desde el navegador.
 */
export class FirestoreCertificateStore implements CertificateStore {
  async get(code: string): Promise<CertificateRecord | null> {
    return guard(async () => {
      const doc = await getAdminDb().collection(COLLECTIONS.certificates).doc(code).get();
      if (!doc.exists) return null;
      return toRecord(doc.data() as Record<string, unknown>);
    });
  }

  async create(record: CertificateRecord): Promise<{ created: boolean }> {
    return guard(async () => {
      try {
        await getAdminDb()
          .collection(COLLECTIONS.certificates)
          .doc(record.code)
          .create({
            ...record,
            // Marca de servidor, separada de `issuedAt` (que decide el
            // servicio y es la que se muestra): sirve para ordenar por cuándo
            // llegó la escritura sin depender del reloj del proceso.
            recordedAt: new Date().toISOString(),
          });
        return { created: true };
      } catch (error) {
        if (isAlreadyExists(error)) return { created: false };
        throw error;
      }
    });
  }
}

/**
 * Código gRPC 6 = `ALREADY_EXISTS`.
 *
 * Se comprueba el código y no el texto del mensaje: el texto cambia entre
 * versiones del SDK y en la traducción.
 */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 6
  );
}

/** Solo los campos conocidos: un documento manipulado no se publica tal cual. */
function toRecord(data: Record<string, unknown>): CertificateRecord | null {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const code = text(data.code);
  const uid = text(data.uid);
  const courseId = text(data.courseId);
  const courseTitle = text(data.courseTitle);
  const displayName = text(data.displayName);
  const username = text(data.username);
  const completedAt = text(data.completedAt);
  const issuedAt = text(data.issuedAt);
  const version = typeof data.version === "number" ? data.version : null;

  if (
    !code ||
    !uid ||
    !courseId ||
    !courseTitle ||
    !displayName ||
    !username ||
    !completedAt ||
    !issuedAt ||
    version === null
  ) {
    return null;
  }

  return {
    code,
    uid,
    username,
    displayName,
    courseId,
    courseTitle,
    version,
    completedAt,
    issuedAt,
    issuedBy: text(data.issuedBy) ?? "system",
  };
}

/**
 * Nombre y usuario de la persona certificada.
 *
 * Se leen de la ficha (`accounts/{uid}`) al emitir y se copian al certificado:
 * si la persona cambia de nombre después, el documento emitido conserva el que
 * tenía. Es lo mismo que se hace con el título del curso.
 */
export class FirestoreCertificatePeople {
  async find(uid: string): Promise<{ username: string; displayName: string } | null> {
    return guard(async () => {
      const doc = await getAdminDb().collection(COLLECTIONS.accounts).doc(uid).get();
      if (!doc.exists) return null;
      const data = doc.data() as { username?: unknown; displayName?: unknown };
      const username = typeof data.username === "string" ? data.username : null;
      const displayName = typeof data.displayName === "string" ? data.displayName : null;
      if (!username || !displayName) return null;
      return { username, displayName };
    });
  }
}

/** Un evento por emisión real; pedir dos veces el mismo certificado no audita. */
export class FirestoreCertificateAudit implements CertificateAudit {
  async record(event: Parameters<CertificateAudit["record"]>[0]): Promise<void> {
    await guard(() =>
      getAdminDb()
        .collection(COLLECTIONS.audits)
        .add({ ...event, severity: "info" }),
    );
  }
}
