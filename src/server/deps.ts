import { getServerConfig } from "@/server/config";
import { DomainError } from "@/domain/text";
import { budgetBytesFromMiB } from "@/domain/storage/pdf-chunks";
import { FirestoreCourseCatalogStore } from "@/server/firebase/catalog-store";
import { FirestoreCourseEditorStore } from "@/server/firebase/course-editor-store";
import { FirestoreCourseDeletionStore } from "@/server/firebase/course-deletion-store";
import type { CourseEditorDependencies } from "@/server/courses/editor";
import type { CourseDeletionDependencies } from "@/server/courses/deletion";
import { FirestorePdfDocumentStore } from "@/server/firebase/document-store";
import { FirestoreAccountAdminStore } from "@/server/firebase/account-admin-store";
import type { AccountAdminDependencies } from "@/server/accounts/service";
import type { PasswordChangeDependencies } from "@/server/accounts/password-service";
import type { ActivityDependencies } from "@/server/audit/activity";
import { FirestoreAuditReader } from "@/server/firebase/audit-store";
import {
  FirestoreCertificateAudit,
  FirestoreCertificatePeople,
  FirestoreCertificateStore,
} from "@/server/firebase/certificate-store";
import type { CertificateDependencies } from "@/server/certificates/service";
import { verifyAccountPassword } from "@/server/auth/identity-toolkit";
import { FirestoreEnrollmentStore } from "@/server/firebase/enrollment-store";
import { FirestoreLearningStore } from "@/server/firebase/learning-store";
import { pdfLimiter, uploadLimiter } from "@/server/ratelimit/limiter";
import type { DocumentDependencies } from "@/server/documents/service";
import type { DocumentFileDependencies } from "@/server/documents/file";
import type { EnrollmentDependencies } from "@/server/enrollments/service";
import { ACTIVATION_TOKEN_TTL_HOURS } from "@/domain/auth/activation";
import type { ImportDependencies } from "@/server/import/service";
import type { ActivationDependencies } from "@/server/auth/activation-service";
import type { AiFlowDependencies } from "@/server/courses/ai-flow";
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
    // Límites en memoria por proceso: suficiente para un servidor propio; con
    // varias instancias habría que compartir el contador.
    //   - `limiter` cobra lecturas (por página) y partes de subida;
    //   - `uploadLimiter` cobra abrir y finalizar subidas (20/hora por admin).
    limiter: pdfLimiter(),
    uploadLimiter: uploadLimiter(),
  };
}

/**
 * Administración de cuentas (bloque 09): deshabilitar, reactivar y reemitir
 * códigos de activación. Reutiliza el servicio de credenciales de la activación
 * para revocar refresh tokens y escribir las claims nuevas.
 */
export function accountAdminDependencies(): AccountAdminDependencies {
  return {
    store: new FirestoreAccountAdminStore(),
    credentials: new FirebaseCredentialService(),
    activationTtlHours: ACTIVATION_TOKEN_TTL_HOURS,
  };
}

/**
 * Registro de actividad: solo lectura de `audits`, la misma colección en la que
 * escriben todas las operaciones sensibles.
 */
export function activityDependencies(): ActivityDependencies {
  return { audit: new FirestoreAuditReader() };
}

/**
 * Cambio de contraseña por el propio usuario.
 *
 * La comprobación de la contraseña actual se hace contra Identity Toolkit con
 * la clave web del proyecto: es pública (va en el bundle del navegador) y sirve
 * para identificar el proyecto, no para autorizar. El SDK de Admin no puede
 * verificar contraseñas, solo fijarlas.
 */
export function passwordChangeDependencies(): PasswordChangeDependencies {
  const config = getServerConfig();
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    throw new DomainError(
      "CONFIG_MISSING",
      "Falta NEXT_PUBLIC_FIREBASE_API_KEY: no se puede comprobar la contraseña actual.",
      503,
    );
  }

  return {
    store: new FirestoreAccountAdminStore(),
    credentials: new FirebaseCredentialService(),
    verifyPassword: (email, password) => verifyAccountPassword({ email, password, apiKey }),
    audit: new FirestoreAuditLog(),
    authEmailDomain: config.AUTH_EMAIL_DOMAIN,
  };
}

/**
 * Lectura del PDF completo por el alumnado (bloque 07).
 *
 * Comparte el mismo adaptador de documentos que la subida: no hay un segundo
 * almacén ni una segunda copia. Solo se cablean las dependencias que la lectura
 * necesita (documentos, catálogo, matrículas y el límite de descargas).
 */
export function documentFileDependencies(): DocumentFileDependencies {
  return {
    documents: new FirestorePdfDocumentStore(),
    catalog: new FirestoreCourseCatalogStore(),
    enrollments: new FirestoreEnrollmentStore(),
    limiter: pdfLimiter(),
  };
}

/**
 * Creación y edición de cursos. Hoy solo la creación: el editor de contenido
 * llega en los bloques siguientes y reutilizará este mismo puerto.
 */
export function courseEditorDependencies(): CourseEditorDependencies {
  return { store: new FirestoreCourseEditorStore() };
}

/**
 * Certificados: el almacén propio (`certificates/{code}`) y, prestados, el
 * catálogo y el progreso. El servicio **vuelve a comprobar** que el curso está
 * completado: no se fía de que la pantalla solo enseñe el botón cuando toca.
 */
export function certificateDependencies(): CertificateDependencies {
  return {
    certificates: new FirestoreCertificateStore(),
    catalog: new FirestoreCourseCatalogStore(),
    learning: new FirestoreLearningStore(),
    people: new FirestoreCertificatePeople(),
    audit: new FirestoreCertificateAudit(),
  };
}

/**
 * Creación de cursos con IA (Gemini).
 *
 * Comparte los almacenes reales del editor y de los documentos: el PDF que se
 * analiza es el mismo activo fragmentado que luego lee el alumnado, no una
 * segunda copia. La clave de Gemini **no** se cablea aquí: se lee del entorno
 * en el cliente (`src/server/ai/config.ts`) y nunca sale del servidor.
 */
export function aiDependencies(): AiFlowDependencies {
  const upload = documentDependencies();
  return {
    editor: courseEditorDependencies(),
    draft: { store: new FirestoreCourseCatalogStore() },
    upload,
    catalog: upload.catalog,
    documents: upload.documents,
  };
}

/**
 * Borrado de cursos. El registro de actividad es el general (`audits`), el mismo
 * que lee `/admin/actividad`: una eliminación tiene que quedar en el mismo sitio
 * que el resto de acciones sensibles.
 */
export function courseDeletionDependencies(): CourseDeletionDependencies {
  return {
    store: new FirestoreCourseDeletionStore(),
    audit: new FirestoreAuditLog(),
  };
}

export function enrollmentDependencies(): EnrollmentDependencies {
  return {
    enrollments: new FirestoreEnrollmentStore(),
    catalog: new FirestoreCourseCatalogStore(),
  };
}
