import type { Actor } from "@/domain/auth/authorization";
import {
  DemoCatalogStore,
  DemoLearningStore,
  demoAccountByUid,
  demoState,
} from "@/demo/store";
import {
  certificateForDownload,
  issueCertificate,
  verifyCertificate,
  type CertificateDependencies,
  type CertificateStore,
} from "@/server/certificates/service";

/**
 * CERTIFICADOS EN LA DEMOSTRACIÓN
 * ==============================
 *
 * El servicio es **el mismo** que en producción: lo único que cambia es el
 * almacén (una `Map` en memoria en lugar de Firestore). Así la demostración no
 * puede tener reglas más laxas que la aplicación real —el fallo clásico de un
 * modo de prueba que sí deja hacer lo que el real prohíbe—.
 */

/** `certificates/{code}` en memoria. */
class DemoCertificateStore implements CertificateStore {
  async get(code: string) {
    return demoState().certificates.get(code) ?? null;
  }

  async create(record: Parameters<CertificateStore["create"]>[0]) {
    const state = demoState();
    if (state.certificates.has(record.code)) return { created: false };
    state.certificates.set(record.code, record);
    return { created: true };
  }
}

function demoCertificateDeps(): CertificateDependencies {
  return {
    certificates: new DemoCertificateStore(),
    catalog: new DemoCatalogStore(),
    learning: new DemoLearningStore(),
    people: {
      async find(uid: string) {
        const account = demoAccountByUid(uid);
        if (!account) return null;
        return { username: account.username, displayName: account.displayName };
      },
    },
    audit: {
      async record(event) {
        demoState().audits.push({ ...event });
      },
    },
  };
}

export async function issueCertificateFor(
  actor: Actor,
  input: { uid: string; courseId: string },
) {
  return issueCertificate({ actor, uid: input.uid, courseId: input.courseId }, demoCertificateDeps());
}

export async function certificateRecordFor(actor: Actor, code: string) {
  return certificateForDownload({ actor, code }, demoCertificateDeps());
}

export async function certificateVerification(code: unknown) {
  return verifyCertificate(code, demoCertificateDeps());
}
