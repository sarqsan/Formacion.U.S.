import { getServerConfig } from "@/server/config";
import { budgetBytesFromMiB } from "@/domain/storage/pdf-chunks";
import { FirestoreCourseCatalogStore } from "@/server/firebase/catalog-store";
import { FirestorePdfDocumentStore } from "@/server/firebase/document-store";
import { FirestoreEnrollmentStore } from "@/server/firebase/enrollment-store";
import { FirestoreLearningStore } from "@/server/firebase/learning-store";
import { pdfLimiter } from "@/server/ratelimit/limiter";
import type { DocumentDependencies } from "@/server/documents/service";
import type { EnrollmentDependencies } from "@/server/enrollments/service";
import { ACTIVATION_TOKEN_TTL_HOURS } from "@/domain/auth/activation";
import type { ImportDependencies } from "@/server/import/service";
import type { ActivationDependencies } from "@/server/auth/activation-service";
import {
  FirebaseCredentialService,
  FirestoreAccountProvisioner,
  FirestoreActivationStore,
  FirestoreAuditLog,
  FirestorePersonDirectory,
} from "@/server/firebase/repositories";

/** Cableado real de dependencias. Se resuelve por petición (barato, memoizado). */
export function importDependencies(): ImportDependencies {
  const config = getServerConfig();
  return {
    directory: new FirestorePersonDirectory(),
    provisioner: new FirestoreAccountProvisioner(),
    audit: new FirestoreAuditLog(),
    authEmailDomain: config.AUTH_EMAIL_DOMAIN,
    activationTtlHours: ACTIVATION_TOKEN_TTL_HOURS,
  };
}

export function activationDependencies(): ActivationDependencies {
  return {
    store: new FirestoreActivationStore(),
    credentials: new FirebaseCredentialService(),
  };
}

/**
 * Documentos PDF: almacenamiento fragmentado en Firestore (sin Storage).
 * El presupuesto se acota aquí, no en el adaptador, para que un valor absurdo
 * en la configuración nunca pueda llenar la cuota gratuita.
 */
export function documentDependencies(): DocumentDependencies {
  const config = getServerConfig();
  return {
    documents: new FirestorePdfDocumentStore(),
    catalog: new FirestoreCourseCatalogStore(),
    enrollments: new FirestoreEnrollmentStore(),
    learning: new FirestoreLearningStore(),
    budgetBytes: budgetBytesFromMiB(config.PDF_STORAGE_BUDGET_MB),
    // Límite en memoria por proceso: suficiente para un servidor propio; con
    // varias instancias habría que compartir el contador.
    limiter: pdfLimiter(),
  };
}

export function enrollmentDependencies(): EnrollmentDependencies {
  return {
    enrollments: new FirestoreEnrollmentStore(),
    catalog: new FirestoreCourseCatalogStore(),
  };
}
