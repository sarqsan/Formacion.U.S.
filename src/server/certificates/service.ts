import { DomainError } from "@/domain/text";
import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import {
  assertCertificateComplete,
  certificateCode,
  isCertificateCode,
  maskName,
  type CertificateRecord,
} from "@/domain/certificates/certificate";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import type { LearningStore } from "@/server/learning/store";

/**
 * CERTIFICADOS (servicio)
 * =======================
 *
 * Un certificado se emite **una sola vez por persona, curso y versión**, y se
 * emite cuando el curso está completado. No hay botón de «crear certificado»:
 * pedirlo es suficiente, y pedirlo dos veces devuelve el mismo documento.
 *
 * Reglas que se sostienen aquí:
 *
 *   · **Nadie certifica lo que no ha hecho.** El servicio no se fía de la
 *     pantalla: vuelve a leer el progreso y exige `completedAt`.
 *   · **Se certifica la versión cursada**, no la publicada ahora: el título y la
 *     versión se copian al documento al emitirlo. Republicar el curso no cambia
 *     un certificado ya emitido (ni deja de valer).
 *   · **Cada cual ve lo suyo.** Un alumno solo puede obtener su certificado;
 *     administración puede obtener el de cualquiera.
 *   · **La verificación es pública pero no identifica.** Un código devuelve
 *     curso, versión, fecha y nombre enmascarado. El nombre completo y el PDF
 *     exigen sesión.
 */

export interface CertificateStore {
  /** `null` si el código no corresponde a ningún certificado. */
  get(code: string): Promise<CertificateRecord | null>;
  /** Crea el documento si no existe. Devolver `false` = ya estaba. */
  create(record: CertificateRecord): Promise<{ created: boolean }>;
}

export interface CertificateAudit {
  record(event: {
    type: "certificate_issued";
    actorUid: string;
    targetUid: string;
    at: string;
    code: string;
    courseId: string;
    courseTitle: string;
    version: number;
  }): Promise<void>;
}

export interface CertificateDependencies {
  certificates: CertificateStore;
  /** Catálogo y progreso: la prueba de que el curso está completado. */
  catalog: CourseCatalogStore;
  learning: LearningStore;
  /** Nombre completo y usuario de la persona. */
  people: {
    find(uid: string): Promise<{ username: string; displayName: string } | null>;
  };
  audit: CertificateAudit;
  now?: () => Date;
}

export interface CertificateIssued {
  record: CertificateRecord;
  /** `true` si se ha creado ahora; `false` si ya existía. */
  created: boolean;
}

/**
 * Devuelve (emitiéndolo si hace falta) el certificado de una persona en un curso.
 *
 * `actor` es quien lo pide: la propia persona o administración. No se acepta un
 * actor de demostración con uid ajeno.
 */
export async function issueCertificate(
  input: { actor: Actor; uid: string; courseId: string },
  deps: CertificateDependencies,
): Promise<CertificateIssued> {
  const actor = assertActiveAccount(input.actor);

  if (actor.role !== "admin" && actor.uid !== input.uid) {
    throw new DomainError(
      "CERTIFICATE_FORBIDDEN",
      "No puedes obtener el certificado de otra persona.",
      403,
    );
  }

  const course = await deps.catalog.getCourse(input.courseId);
  if (!course) {
    throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
  }

  /*
    La versión que se certifica es **la que se completó**, no la publicada hoy.

    Se miran las dos: el progreso vivo (versión en curso) y el histórico. El
    histórico no es un adorno: si alguien terminó la versión 1 y después se
    publicó la 2, su progreso vivo vuelve a estar a medias y el completado quedó
    archivado. Sin leer el archivo, esa persona perdería un certificado que ya
    había ganado.
  */
  const [current, archived] = await Promise.all([
    deps.learning.getProgress(input.uid, input.courseId),
    deps.learning.listArchivedProgress(input.uid),
  ]);

  const completed = [
    ...(current && current.completedAt ? [current] : []),
    ...archived.filter((item) => item.courseId === input.courseId && item.completedAt),
  ].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return String(b.completedAt).localeCompare(String(a.completedAt));
  });

  const definitive = completed[0] ?? null;
  if (!definitive || !definitive.completedAt) {
    throw new DomainError(
      "CERTIFICATE_NOT_COMPLETED",
      "Todavía no se ha completado el curso: no hay nada que certificar.",
      409,
    );
  }

  const version = definitive.version;
  const completedAt = definitive.completedAt;
  const code = certificateCode({ uid: input.uid, courseId: input.courseId, version });

  const existing = await deps.certificates.get(code);
  if (existing) return { record: existing, created: false };

  const person = await deps.people.find(input.uid);
  if (!person) {
    throw new DomainError("ACCOUNT_NOT_FOUND", "No se ha encontrado la cuenta.", 404);
  }

  const definition = await deps.catalog.getVersion(input.courseId, version);
  const courseTitle = definition?.title ?? course.title;
  const now = deps.now?.() ?? new Date();

  const record: CertificateRecord = {
    code,
    uid: input.uid,
    username: person.username,
    displayName: person.displayName,
    courseId: input.courseId,
    courseTitle,
    version,
    completedAt,
    issuedAt: now.toISOString(),
    issuedBy: actor.uid,
  };

  assertCertificateComplete(record);

  const { created } = await deps.certificates.create(record);
  if (created) {
    // Solo se audita la emisión real: pedir dos veces el mismo certificado no
    // debe llenar el registro de eventos repetidos.
    await deps.audit.record({
      type: "certificate_issued",
      actorUid: actor.uid,
      targetUid: input.uid,
      at: now.toISOString(),
      code,
      courseId: input.courseId,
      courseTitle,
      version,
    });
  }

  return { record, created };
}

/** Lo que la página pública puede enseñar. Nada más. */
export interface PublicCertificate {
  valid: true;
  code: string;
  courseTitle: string;
  version: number;
  /** Nombre enmascarado: sirve para reconocerlo, no para identificarlo. */
  holderMasked: string;
  completedAt: string;
  issuedAt: string;
}

export type VerificationResult =
  | PublicCertificate
  | { valid: false; code: string | null };

/**
 * Verificación por código, sin sesión.
 *
 * Un código con mala forma **no llega a la base de datos**: no tiene sentido
 * gastar una lectura en algo que no puede existir.
 */
export async function verifyCertificate(
  code: unknown,
  deps: Pick<CertificateDependencies, "certificates">,
): Promise<VerificationResult> {
  if (!isCertificateCode(code)) {
    return { valid: false, code: null };
  }

  const record = await deps.certificates.get(code);
  if (!record) return { valid: false, code };

  return {
    valid: true,
    code: record.code,
    courseTitle: record.courseTitle,
    version: record.version,
    holderMasked: maskName(record.displayName),
    completedAt: record.completedAt,
    issuedAt: record.issuedAt,
  };
}

/**
 * Certificado por código para descargar el PDF.
 *
 * Exige sesión y que sea el titular o administración: el PDF lleva el nombre
 * completo, así que no puede estar detrás de un código que se puede reenviar.
 */
export async function certificateForDownload(
  input: { actor: Actor; code: string },
  deps: Pick<CertificateDependencies, "certificates">,
): Promise<CertificateRecord> {
  const actor = assertActiveAccount(input.actor);
  if (!isCertificateCode(input.code)) {
    throw new DomainError("CERTIFICATE_NOT_FOUND", "Ese certificado no existe.", 404);
  }

  const record = await deps.certificates.get(input.code);
  if (!record) {
    throw new DomainError("CERTIFICATE_NOT_FOUND", "Ese certificado no existe.", 404);
  }
  if (actor.role !== "admin" && actor.uid !== record.uid) {
    throw new DomainError(
      "CERTIFICATE_FORBIDDEN",
      "Este certificado no es tuyo. Si crees que es un error, avisa a administración.",
      403,
    );
  }

  return record;
}
