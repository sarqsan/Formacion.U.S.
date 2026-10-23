import { DomainError } from "@/domain/text";

/**
 * ESQUEMA DE LA BASE DE DATOS (fuente de verdad única)
 * ===================================================
 *
 * Los nombres de colección, la forma de los identificadores y la versión del
 * esquema viven AQUÍ. Los repositorios, los scripts de inicialización y las
 * comprobaciones importan este módulo en lugar de repetir cadenas sueltas.
 *
 * Hay una prueba de "deriva" que comprueba que este fichero, `firestore.rules`,
 * `firestore.indexes.json` y `docs/MODELO-DATOS.md` hablan de las mismas
 * colecciones: si alguien añade una colección y olvida las reglas, la batería
 * de pruebas falla.
 *
 * Firestore no tiene esquema impuesto: la coherencia se garantiza en el
 * servidor (validación al escribir) y se audita con `npm run db:check`.
 */

export {
  SCHEMA_VERSION,
  COLLECTIONS,
  META_DOC,
  CLIENT_READABLE_COLLECTIONS,
  SERVER_ONLY_COLLECTIONS,
  ROOT_COLLECTIONS,
} from "@/server/db/schema.constants";

import { COLLECTIONS } from "@/server/db/schema.constants";

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UID_SEGMENT = /^[A-Za-z0-9]{6,128}$/;

export function assertIdSegment(value: string, field: string): void {
  if (typeof value !== "string" || !ID_SEGMENT.test(value)) {
    throw new DomainError(
      "SCHEMA_ID_INVALID",
      `Identificador no válido para ${field}: «${String(value)}».`,
      500,
    );
  }
}

export function assertUid(value: string, field = "uid"): void {
  if (typeof value !== "string" || !UID_SEGMENT.test(value)) {
    throw new DomainError("SCHEMA_UID_INVALID", `UID no válido para ${field}.`, 500);
  }
}

/**
 * Progreso: `progress/{uid}_{courseId}`.
 *
 * El id compuesto evita consultas por dos campos y garantiza que un usuario
 * solo puede tener un documento de progreso por curso y versión publicada.
 */
export function progressDocId(uid: string, courseId: string): string {
  assertUid(uid);
  assertIdSegment(courseId, "courseId");
  return `${uid}_${courseId}`;
}

/** Histórico: `progressHistory/{uid}_{courseId}_v{n}`. */
export function progressHistoryDocId(uid: string, courseId: string, version: number): string {
  assertUid(uid);
  assertIdSegment(courseId, "courseId");
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError("SCHEMA_VERSION_INVALID", "Versión no válida.", 500);
  }
  return `${uid}_${courseId}_v${version}`;
}

/**
 * Claves de corrección: `answerKeys/{courseId}_v{n}_{assessmentId}`, donde
 * `assessmentId` es `final` o el id del tema.
 */
export function answerKeysDocId(courseId: string, version: number, assessmentId: string): string {
  assertIdSegment(courseId, "courseId");
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError("SCHEMA_VERSION_INVALID", "Versión no válida.", 500);
  }
  assertIdSegment(assessmentId, "assessmentId");
  return `${courseId}_v${version}_${assessmentId}`;
}

/** Ruta de la subcolección de versiones. */
export function versionPath(courseId: string, version: number): string {
  assertIdSegment(courseId, "courseId");
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError("SCHEMA_VERSION_INVALID", "Versión no válida.", 500);
  }
  return `${COLLECTIONS.courses}/${courseId}/${COLLECTIONS.versions}/${version}`;
}

// ---------------------------------------------------------------------------
// Validación de documentos escritos por el servidor
// ---------------------------------------------------------------------------
//
// Se valida al escribir para que un error de programación no deje datos
// incoherentes que luego las reglas interpretarían mal (por ejemplo, una
// cuenta sin rol válido o un progreso sin uid).

export interface AccountDocumentShape {
  uid: string;
  username: string;
  authEmail: string;
  apellido: string | null;
  personRol: string | null;
  role: string;
  status: string;
  claimsVersion: number;
  createdAt: string;
  createdBy: string;
}

export function validateAccountDocument(doc: Record<string, unknown>): void {
  const required = [
    "uid",
    "username",
    "role",
    "status",
    "claimsVersion",
    "createdAt",
    "createdBy",
  ];
  for (const field of required) {
    if (doc[field] === undefined || doc[field] === null || doc[field] === "") {
      throw new DomainError(
        "SCHEMA_ACCOUNT_INVALID",
        `La cuenta no tiene el campo obligatorio «${field}».`,
        500,
      );
    }
  }

  if (doc.role !== "admin" && doc.role !== "learner") {
    throw new DomainError(
      "SCHEMA_ACCOUNT_INVALID",
      "El rol de la cuenta debe ser «admin» o «learner».",
      500,
    );
  }

  if (!["pending_activation", "active", "disabled"].includes(String(doc.status))) {
    throw new DomainError("SCHEMA_ACCOUNT_INVALID", "Estado de cuenta no válido.", 500);
  }

  if (typeof doc.claimsVersion !== "number" || !Number.isInteger(doc.claimsVersion)) {
    throw new DomainError(
      "SCHEMA_ACCOUNT_INVALID",
      "claimsVersion debe ser un entero (las reglas comparan por igualdad estricta).",
      500,
    );
  }
}

/**
 * Ficha del curso (`courses/{courseId}`).
 *
 * `publishedVersion` y `lastDraftVersion` son punteros: el primero dice qué ve
 * el alumnado, el segundo cuál fue el último borrador guardado. Un curso recién
 * creado tiene **los dos a null**: no hay versión publicada ni borrador.
 */
export interface CourseDocumentShape {
  courseId: string;
  title: string;
  publishedVersion: number | null;
  lastDraftVersion: number | null;
  createdAt: string;
  createdBy: string;
}

function isVersionPointer(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1);
}

export function validateCourseDocument(doc: Record<string, unknown>): void {
  if (typeof doc.courseId !== "string" || !ID_SEGMENT.test(doc.courseId)) {
    throw new DomainError(
      "SCHEMA_COURSE_INVALID",
      "La ficha del curso no tiene un identificador válido.",
      500,
    );
  }
  if (typeof doc.title !== "string" || !doc.title.trim()) {
    throw new DomainError("SCHEMA_COURSE_INVALID", "La ficha del curso no tiene título.", 500);
  }
  for (const field of ["publishedVersion", "lastDraftVersion"]) {
    if (!isVersionPointer(doc[field])) {
      throw new DomainError(
        "SCHEMA_COURSE_INVALID",
        `«${field}» debe ser null o un entero mayor o igual que 1.`,
        500,
      );
    }
  }
  for (const field of ["createdAt", "createdBy"]) {
    if (typeof doc[field] !== "string" || !doc[field]) {
      throw new DomainError(
        "SCHEMA_COURSE_INVALID",
        `La ficha del curso no tiene el campo obligatorio «${field}».`,
        500,
      );
    }
  }
}

export interface ProgressDocumentShape {
  uid: string;
  courseId: string;
  version: number;
  mandatoryTopicIds: string[];
  completedAt: string | null;
}

export function validateProgressDocument(doc: Record<string, unknown>): void {
  for (const field of ["uid", "courseId", "version", "mandatoryTopicIds"]) {
    if (doc[field] === undefined || doc[field] === null) {
      throw new DomainError(
        "SCHEMA_PROGRESS_INVALID",
        `El progreso no tiene el campo obligatorio «${field}».`,
        500,
      );
    }
  }

  if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 1) {
    throw new DomainError("SCHEMA_PROGRESS_INVALID", "Versión de progreso no válida.", 500);
  }

  if (!Array.isArray(doc.mandatoryTopicIds)) {
    throw new DomainError(
      "SCHEMA_PROGRESS_INVALID",
      "mandatoryTopicIds debe ser una lista.",
      500,
    );
  }

  if (doc.completedAt !== null && typeof doc.completedAt !== "string") {
    throw new DomainError(
      "SCHEMA_PROGRESS_INVALID",
      "completedAt debe ser una fecha ISO o null.",
      500,
    );
  }
}

export interface ProgressHistoryDocumentShape extends ProgressDocumentShape {
  archivedAt: string;
}

/**
 * Documento de `progressHistory`: el progreso archivado **más** la fecha en que
 * se archivó.
 *
 * `archivedAt` se valida como cadena ISO, igual que el resto de fechas del
 * esquema (`completedAt`, `updatedAt`, `at`). Antes había dos caminos que
 * escribían tipos distintos —`commitAttempt` una cadena y `saveProgress` un
 * `serverTimestamp()`—, de modo que la misma colección mezclaba `string` y
 * `Timestamp`. La lectura tolera lo antiguo (`toIsoString`), pero la escritura
 * no vuelve a producir la mezcla.
 */
export function validateProgressHistoryDocument(doc: Record<string, unknown>): void {
  validateProgressDocument(doc);

  const archivedAt = doc.archivedAt;
  if (typeof archivedAt !== "string" || !Number.isFinite(Date.parse(archivedAt))) {
    throw new DomainError(
      "SCHEMA_PROGRESS_HISTORY_INVALID",
      "El histórico debe guardar archivedAt como fecha ISO.",
      500,
    );
  }
}

export interface AttemptDocumentShape {
  uid: string;
  courseId: string;
  version: number;
  assessmentType: "topic" | "final";
  passed: boolean;
  correctCount: number;
  totalQuestions: number;
  at: string;
}

export function validateAttemptDocument(doc: Record<string, unknown>): void {
  for (const field of ["uid", "courseId", "version", "assessmentType", "at"]) {
    if (doc[field] === undefined || doc[field] === null) {
      throw new DomainError(
        "SCHEMA_ATTEMPT_INVALID",
        `El intento no tiene el campo obligatorio «${field}».`,
        500,
      );
    }
  }

  if (doc.assessmentType !== "topic" && doc.assessmentType !== "final") {
    throw new DomainError("SCHEMA_ATTEMPT_INVALID", "Tipo de evaluación no válido.", 500);
  }

  if (doc.assessmentType === "topic" && !doc.topicId) {
    throw new DomainError(
      "SCHEMA_ATTEMPT_INVALID",
      "Un intento de tema debe indicar el tema.",
      500,
    );
  }

  if (typeof doc.passed !== "boolean") {
    throw new DomainError("SCHEMA_ATTEMPT_INVALID", "passed debe ser booleano.", 500);
  }

  if (
    typeof doc.totalQuestions !== "number" ||
    doc.totalQuestions < 1 ||
    typeof doc.correctCount !== "number" ||
    doc.correctCount < 0 ||
    doc.correctCount > doc.totalQuestions
  ) {
    throw new DomainError("SCHEMA_ATTEMPT_INVALID", "Recuento de respuestas incoherente.", 500);
  }
}
