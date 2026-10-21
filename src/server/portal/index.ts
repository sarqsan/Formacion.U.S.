import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import type { ImportPreview } from "@/domain/people/import-rows";
import type { ImportDependencies } from "@/server/import/service";
import { submitAssessment } from "@/server/assessments/service";
import { parsePeopleWorkbook } from "@/server/import/excel";
import { buildImportPreview } from "@/server/import/service";
import { isDemoMode } from "@/demo/session";
import * as demo from "@/demo/service";
import { definitionOf as demoDefinitionOf, demoState, listVersionsOf } from "@/demo/store";
import * as firebase from "@/server/portal/firebase";

/**
 * PORTAL ACTIVO
 * =============
 *
 * Un único punto de entrada para las pantallas. Decide, según la configuración
 * del proceso, si se habla con Firestore o con el almacén en memoria de la
 * demostración:
 *
 *   DEMO_MODE=1  → datos sintéticos en memoria (se pierden al reiniciar)
 *   resto        → Firestore + Firebase Authentication del proyecto real
 *
 * Lo importante: **no hay conmutación silenciosa**. Si la aplicación está en
 * modo real y Firestore falla, las funciones de abajo lanzan un error de
 * servicio (`FIREBASE_UNAVAILABLE`, 503) que la interfaz muestra tal cual. No
 * se cae al almacén en memoria: eso convertiría un fallo de datos en una
 * pérdida invisible de matrículas y progreso.
 */

export type PortalMode = "demo" | "firebase";

export function portalMode(): PortalMode {
  return isDemoMode() ? "demo" : "firebase";
}

export function isFirebaseMode(): boolean {
  return portalMode() === "firebase";
}

// ---------------------------------------------------------------------------
// Alumno
// ---------------------------------------------------------------------------

export async function coursesForLearner(actor: Actor) {
  return portalMode() === "demo"
    ? demo.coursesForLearner(actor)
    : firebase.learnerCourses(actor);
}

export async function courseViewForLearner(actor: Actor, courseId: string) {
  return portalMode() === "demo"
    ? demo.courseViewForLearner(actor, courseId)
    : firebase.learnerCourseView(actor, courseId);
}

/**
 * Vista de lectura.
 *
 * En demostración devuelve pantallas de texto (`kind: "screens"`); con
 * Firestore devuelve los metadatos del PDF (`kind: "pdf"`) y son los bytes los
 * que se piden al endpoint autorizado.
 */
export async function readingView(
  actor: Actor,
  input: { courseId: string; documentId: string; page?: number },
) {
  if (portalMode() === "demo") {
    const view = await demo.screenView(actor, input);
    return { kind: "screens" as const, ...view };
  }
  return firebase.learnerReadingView(actor, input);
}

/** Marca una página como leída. Devuelve la siguiente permitida. */
export async function readPage(
  actor: Actor,
  input: { courseId: string; documentId: string; page: number },
): Promise<{ nextPage: number; finished: boolean; topicId: string; note?: string }> {
  if (portalMode() === "demo") {
    const result = await demo.readScreen(actor, input);
    const view = await demo.screenView(actor, {
      courseId: input.courseId,
      documentId: input.documentId,
    });
    return { ...result, topicId: view.topicId };
  }
  return firebase.learnerReadPage(actor, input);
}

export async function submitQuiz(input: {
  actor: Actor;
  courseId: string;
  assessmentType: "topic" | "final";
  topicId?: string;
  answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
}) {
  if (portalMode() === "demo") {
    return submitAssessment(input, demo.demoDeps());
  }
  return firebase.learnerSubmit(input);
}

// ---------------------------------------------------------------------------
// Ficha de la cuenta
// ---------------------------------------------------------------------------

export interface AccountProfile {
  uid: string;
  username: string;
  displayName: string;
  personRol: string;
}

export async function accountProfile(actor: Actor): Promise<AccountProfile | null> {
  if (portalMode() === "demo") {
    const account = demoState().accounts.find((item) => item.uid === actor.uid);
    if (!account) return null;
    return {
      uid: account.uid,
      username: account.username,
      displayName: account.displayName,
      personRol: account.personRol,
    };
  }

  const row = await firebase.profile(actor);
  if (!row) return null;
  return {
    uid: row.uid,
    username: row.username,
    displayName: row.displayName,
    personRol: String(row.personRol),
  };
}

// ---------------------------------------------------------------------------
// Administración (lectura)
// ---------------------------------------------------------------------------

export async function accounts(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demoAccounts() : firebase.accounts(actor);
}

export async function learners(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demoLearners() : firebase.learners(actor);
}

function demoAccounts() {
  return demoState().accounts.map((account) => ({
    uid: account.uid,
    username: account.username,
    displayName: account.displayName,
    personRol: account.personRol,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
  }));
}

function demoLearners() {
  return demoAccounts().filter((account) => account.role === "learner");
}

export async function adminOverview(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demo.adminOverview() : firebase.adminOverview(actor);
}

export async function adminCourses(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demo.adminCourses() : firebase.adminCourses(actor);
}

export async function adminCourseDetail(actor: Actor, courseId: string, version?: number) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminCourseDetail(courseId, version)
    : firebase.adminCourseDetail(actor, courseId, version);
}

export async function adminEnrollments(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demo.adminEnrollments() : firebase.adminEnrollments(actor);
}

export async function adminProgress(actor: Actor) {
  assertAdmin(actor);
  return portalMode() === "demo" ? demo.adminProgress() : firebase.adminProgress(actor);
}

/** Definición editable (contenido + claves) de una versión. Solo administración. */
export async function definitionOf(
  actor: Actor,
  courseId: string,
  version: number,
): Promise<CourseVersionDefinition | null> {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demoDefinitionOf(courseId, version)
    : firebase.definitionOf(actor, courseId, version);
}

// ---------------------------------------------------------------------------
// Administración (escritura)
// ---------------------------------------------------------------------------

/**
 * Crea un curso vacío a partir de la plantilla vacía.
 *
 * Es la primera pieza del ciclo de vida: nace sin versiones
 * (`publishedVersion` y `lastDraftVersion` a null). No hay conmutación
 * silenciosa: en modo real escribe en Firestore, en demostración en memoria, y
 * un fallo de Firestore se muestra como error (503), nunca se sustituye por el
 * almacén de la demostración.
 */
export async function adminCreateCourse(
  actor: Actor,
  input: { courseId: string; title: string; description?: string },
) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminCreateCourse(actor, input)
    : firebase.adminCreateCourse(actor, input);
}

export async function adminEnroll(actor: Actor, uid: string, courseId: string) {
  return portalMode() === "demo"
    ? demo.adminEnroll(actor, uid, courseId)
    : firebase.adminEnroll(actor, uid, courseId);
}

export async function adminRevokeEnrollment(actor: Actor, uid: string, courseId: string) {
  return portalMode() === "demo"
    ? demo.adminRevokeEnrollment(actor, uid, courseId)
    : firebase.adminRevokeEnrollment(actor, uid, courseId);
}

export async function adminSaveDraft(actor: Actor, definition: CourseVersionDefinition) {
  return portalMode() === "demo"
    ? demo.adminSaveDraft(actor, definition)
    : firebase.adminSaveDraft(actor, definition);
}

export async function adminUpdateDraft(actor: Actor, definition: CourseVersionDefinition) {
  return portalMode() === "demo"
    ? demo.adminUpdateDraft(actor, definition)
    : firebase.adminUpdateDraft(actor, definition);
}

export async function adminPublish(actor: Actor, courseId: string, version: number) {
  return portalMode() === "demo"
    ? demo.adminPublish(actor, courseId, version)
    : firebase.adminPublish(actor, courseId, version);
}

/** Crea el borrador siguiente a partir de una versión existente. */
export async function adminNewDraft(actor: Actor, courseId: string, fromVersion: number) {
  assertAdmin(actor);

  if (portalMode() === "firebase") {
    return firebase.adminNewDraft(actor, courseId, fromVersion);
  }

  const base = demoDefinitionOf(courseId, fromVersion);
  if (!base) {
    throw new DomainError("VERSION_NOT_FOUND", "No se encontró la versión base.", 404);
  }
  const nextVersion = Math.max(...listVersionsOf(courseId).map((item) => item.version), 0) + 1;
  return demo.adminSaveDraft(actor, { ...base, version: nextVersion });
}

// ---------------------------------------------------------------------------
// Importación
// ---------------------------------------------------------------------------

export async function previewImport(
  actor: Actor,
  buffer: Buffer,
): Promise<{ preview: ImportPreview; skippedEmptyRows: number }> {
  assertAdmin(actor);

  if (portalMode() === "firebase") {
    return firebase.previewImport(actor, buffer);
  }

  // Demostración: se analiza el Excel de verdad contra las cuentas ficticias.
  // La creación de cuentas no se simula: falla con DEMO_NOT_CONNECTED.
  const parsed = await parsePeopleWorkbook(buffer);
  const { preview } = await buildImportPreview(
    { rows: parsed.rows, actor },
    demoImportDependencies(),
  );
  return { preview, skippedEmptyRows: parsed.skippedEmptyRows };
}

/** Dependencias de importación de la demostración (no crean cuentas reales). */
function demoImportDependencies(): ImportDependencies {
  const usernames = () => new Set(demoState().accounts.map((account) => account.username));

  return {
    directory: {
      listTakenUsernames: async () => usernames(),
      isUsernameTaken: async (username: string) => usernames().has(username),
    },
    provisioner: {
      createAccount: async () => {
        throw new DomainError(
          "DEMO_NOT_CONNECTED",
          "La creación de cuentas requiere Firebase Authentication: no está conectado en la demostración.",
        );
      },
      rollbackAccount: async () => undefined,
    },
    audit: { record: async () => undefined },
    authEmailDomain: "formacion.invalid",
    activationTtlHours: 24,
  };
}

export { demoImportDependencies };
