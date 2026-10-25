import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import type { ImportPreview } from "@/domain/people/import-rows";
import { listActivity } from "@/server/audit/activity";
import type { ImportDependencies } from "@/server/import/service";
import type { DraftStructure, SaveAssessmentsResult } from "@/server/courses/editor";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import type { StudyScreen } from "@/domain/courses/screens";
import type { CreateUploadInput, StorageUsage } from "@/server/documents/service";
import type { PdfDocumentMeta } from "@/server/documents/store";
import type { AttachResult } from "@/server/documents/attach";
import { submitAssessment } from "@/server/assessments/service";
import {
  readTopicScreen as readTopicScreenShared,
  screensReadingView as screensReadingViewShared,
} from "@/server/portal/learner";
import { parsePeopleWorkbook } from "@/server/import/excel";
import { buildImportPreview } from "@/server/import/service";
import { aiDependencies } from "@/server/deps";
import {
  generateFinalExam as generateFinalExamFlow,
  generateTopicQuiz as generateTopicQuizFlow,
  generateTopicScreens as generateTopicScreensFlow,
  proposeDraftTopics as proposeDraftTopicsFlow,
  startAiCourse as startAiCourseFlow,
  type ScreensGenerationResult,
  type QuizGenerationResult,
  type StartedAiCourse,
  type TopicProposalResult,
} from "@/server/courses/ai-flow";
import { geminiStatus, type GeminiStatus } from "@/server/ai/status";
import { isDemoMode } from "@/demo/session";
import * as demo from "@/demo/service";
import * as demoCertificates from "@/demo/certificates";
import { definitionOf as demoDefinitionOf, demoState } from "@/demo/store";
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

/**
 * PDF completo para el visor nativo del navegador.
 *
 * Misma función en demostración y en producción: el servicio comprueba
 * identidad, matrícula, versión publicada, referencia del documento e
 * integridad. Lo único que cambia es de dónde salen los bytes.
 */
export async function documentFile(actor: Actor, documentId: string) {
  return portalMode() === "demo"
    ? demo.documentFile(actor, documentId)
    : firebase.documentFile(actor, documentId);
}

/** ¿Se puede ofrecer el visor? (no lee los bytes) */
export async function documentFileAvailable(actor: Actor, documentId: string): Promise<boolean> {
  return portalMode() === "demo"
    ? demo.documentFileAvailable(actor, documentId)
    : firebase.documentFileAvailable(actor, documentId);
}

/** Título, páginas y tamaño si el documento es accesible; `null` si no. */
export async function documentFileSummary(actor: Actor, documentId: string) {
  return portalMode() === "demo"
    ? demo.documentFileSummary(actor, documentId)
    : firebase.documentFileSummary(actor, documentId);
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

/**
 * Pantallas de estudio de un tema (contenido estructurado, no PDF).
 *
 * La misma función sirve a la demostración y a Firestore: recibe los almacenes
 * por parámetro, así que el progreso se calcula igual en los dos modos.
 */
export async function topicScreensView(
  actor: Actor,
  input: { courseId: string; topicId: string; screen?: number },
) {
  return screensReadingViewShared(
    portalMode() === "demo" ? demo.demoDeps() : firebase.firestoreDeps(),
    actor,
    input,
  );
}

/** Registra una pantalla como estudiada. Devuelve la siguiente permitida. */
export async function readTopicScreen(
  actor: Actor,
  input: { courseId: string; topicId: string; screen: number },
) {
  return readTopicScreenShared(
    portalMode() === "demo" ? demo.demoDeps() : firebase.firestoreDeps(),
    actor,
    input,
  );
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
// Crear curso con IA (Gemini, solo servidor)
// ---------------------------------------------------------------------------

/**
 * Estado de la conexión con Gemini. Se puede consultar en los dos modos: solo
 * lee la configuración del proceso y, si hay clave, comprueba la cuenta.
 */
export async function aiConnectionStatus(options: { force?: boolean } = {}): Promise<GeminiStatus> {
  return geminiStatus({ force: options.force });
}

/**
 * La generación con IA escribe en el almacén real (documentos fragmentados,
 * borradores y claves). En la demostración no hay PDF ni credenciales, así que
 * se niega con un mensaje explícito en lugar de simular un resultado: una
 * maqueta que parece funcionar es peor que una función que dice que no está.
 */
function assertRealStore(operation: string): void {
  if (portalMode() === "demo") {
    throw new DomainError(
      "AI_UNAVAILABLE_IN_DEMO",
      `${operation} necesita el almacén real (Firestore y un PDF de verdad). En modo demostración está desactivado a propósito.`,
      409,
    );
  }
}

export async function aiStartCourse(
  actor: Actor,
  input: {
    courseId: string;
    title: string;
    description?: string;
    pageCount: number;
    pdfBytes: Uint8Array;
  },
): Promise<StartedAiCourse> {
  assertRealStore("Crear un curso con IA");
  return startAiCourseFlow({ actor, ...input }, aiDependencies());
}

export async function aiProposeTopics(
  actor: Actor,
  input: { courseId: string; version: number; expectedRevision: number },
): Promise<TopicProposalResult> {
  assertRealStore("Proponer temas con IA");
  return proposeDraftTopicsFlow({ actor, ...input }, aiDependencies());
}

export async function aiGenerateScreens(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    topicId: string;
    requestedScreens?: number;
  },
): Promise<ScreensGenerationResult> {
  assertRealStore("Generar pantallas con IA");
  return generateTopicScreensFlow({ actor, ...input }, aiDependencies());
}

export async function aiGenerateQuiz(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    topicId: string;
    questionCount: number;
    allowMultiple: boolean;
  },
): Promise<QuizGenerationResult> {
  assertRealStore("Generar un cuestionario con IA");
  return generateTopicQuizFlow({ actor, ...input }, aiDependencies());
}

export async function aiGenerateFinalExam(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    questionCount: number;
    allowMultiple: boolean;
  },
): Promise<QuizGenerationResult> {
  assertRealStore("Generar el examen final con IA");
  return generateFinalExamFlow({ actor, ...input }, aiDependencies());
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

/**
 * Administración de cuentas (bloque 09). El servicio es el mismo en las dos
 * persistencias; solo cambia el almacén que hay debajo.
 */
export async function adminDisableAccount(actor: Actor, uid: string, reason?: string | null) {
  return portalMode() === "demo"
    ? demo.adminDisableAccount(actor, uid, reason)
    : firebase.adminDisableAccount(actor, uid, reason);
}

export async function adminEnableAccount(actor: Actor, uid: string) {
  return portalMode() === "demo"
    ? demo.adminEnableAccount(actor, uid)
    : firebase.adminEnableAccount(actor, uid);
}

export async function adminReissueActivationCode(actor: Actor, uid: string) {
  return portalMode() === "demo"
    ? demo.adminReissueActivationCode(actor, uid)
    : firebase.adminReissueActivationCode(actor, uid);
}

export async function adminActivationSummary(actor: Actor, uid: string) {
  return portalMode() === "demo"
    ? demo.adminActivationSummary(actor, uid)
    : firebase.adminActivationSummary(actor, uid);
}

/**
 * Contraseña temporal generada por el servidor para una cuenta activa.
 *
 * Solo existe en modo real: en la demostración no hay Firebase Authentication,
 * así que no hay contraseña que cambiar. La pantalla lo dice y no ofrece el
 * botón; esto es el cinturón por si alguien llama igualmente.
 */
export async function adminResetPassword(actor: Actor, uid: string) {
  if (portalMode() === "demo") {
    throw new DomainError(
      "DEMO_UNSUPPORTED",
      "La demostración no tiene contraseñas reales: el restablecimiento necesita Firebase.",
      400,
    );
  }
  return firebase.adminResetPassword(actor, uid);
}

/**
 * Alta de una persona suelta. Mismo camino que la importación (misma
 * validación, mismo código de un solo uso) con un formulario en vez de un Excel.
 */
export async function adminCreatePerson(
  actor: Actor,
  input: { apellido: string; rol: string },
) {
  if (portalMode() === "demo") {
    throw new DomainError(
      "DEMO_UNSUPPORTED",
      "La demostración no crea cuentas reales: usa la importación de Excel o el modo real.",
      400,
    );
  }
  return firebase.adminCreatePerson(actor, input);
}

/**
 * Registro de actividad. El servicio es el mismo en las dos persistencias; solo
 * cambia de dónde lee los eventos (Firestore o memoria).
 */
export async function adminActivity(actor: Actor, limit?: number) {
  return portalMode() === "demo"
    ? listActivity(actor, { audit: demo.demoAuditReader() }, limit ? { limit } : {})
    : firebase.adminActivity(actor, limit);
}

/** Matriculación en bloque: mismo servicio en las dos persistencias. */
export async function adminEnrollMany(actor: Actor, courseId: string, uids: readonly string[]) {
  return portalMode() === "demo"
    ? demo.adminEnrollMany(actor, courseId, uids)
    : firebase.adminEnrollMany(actor, courseId, uids);
}

/**
 * Historial de formación superada (bloque 10): el archivo de versiones
 * anteriores, que hasta ahora se escribía y no se leía.
 */
export async function learnerCourseHistory(actor: Actor) {
  return portalMode() === "demo"
    ? demo.learnerCourseHistory(actor)
    : firebase.learnerCourseHistory(actor);
}

export async function accountCourseHistory(actor: Actor, uid: string) {
  return portalMode() === "demo"
    ? demo.accountCourseHistory(actor, uid)
    : firebase.accountCourseHistory(actor, uid);
}

// ---------------------------------------------------------------------------
// Certificados
// ---------------------------------------------------------------------------

/**
 * Emite (o recupera) el certificado de un curso completado.
 *
 * Mismo servicio en las dos persistencias; solo cambia el almacén. Pedirlo dos
 * veces devuelve el mismo documento porque el código se deriva de
 * persona + curso + versión.
 */
export async function issueCertificateFor(actor: Actor, input: { uid: string; courseId: string }) {
  return portalMode() === "demo"
    ? demoCertificates.issueCertificateFor(actor, input)
    : firebase.issueCertificateFor(actor, input);
}

/** Certificado para verlo o descargar: el titular o administración. */
export async function certificateRecordFor(actor: Actor, code: string) {
  return portalMode() === "demo"
    ? demoCertificates.certificateRecordFor(actor, code)
    : firebase.certificateRecordFor(actor, code);
}

/**
 * Verificación pública por código (sin sesión).
 *
 * No recibe actor a propósito: no hay nada que autorizar más allá de conocer el
 * código, y lo que devuelve (curso, versión, fecha y nombre enmascarado) no
 * identifica a nadie.
 */
export async function certificateVerification(code: unknown) {
  return portalMode() === "demo"
    ? demoCertificates.certificateVerification(code)
    : firebase.certificateVerification(code);
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

/** Abre (o reanuda) el borrador del curso. No publica nada. */
export async function adminStartDraft(actor: Actor, courseId: string) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminStartDraft(actor, courseId)
    : firebase.adminStartDraft(actor, courseId);
}

/** Guarda la estructura del borrador (título, descripción y temas). */
export async function adminSaveDraftStructure(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    structure: DraftStructure;
  },
) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminSaveDraftStructure(actor, input)
    : firebase.adminSaveDraftStructure(actor, input);
}

/** Guarda cuestionarios y examen final del borrador (versión + claves juntas). */
export async function adminSaveDraftAssessments(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    topicQuizzes?: Record<string, QuizQuestionDefinition[]>;
    finalExam?: QuizQuestionDefinition[];
  },
): Promise<SaveAssessmentsResult> {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminSaveDraftAssessments(actor, input)
    : firebase.adminSaveDraftAssessments(actor, input);
}

/** Guarda las pantallas de estudio de los temas indicados del borrador. */
export async function adminSaveDraftScreens(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    expectedRevision: number;
    topicScreens: Record<string, StudyScreen[]>;
    pageCount?: number | null;
  },
) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminSaveDraftScreens(actor, input)
    : firebase.adminSaveDraftScreens(actor, input);
}

// ---------------------------------------------------------------------------
// Documentos PDF (bloque 06)
// ---------------------------------------------------------------------------

/**
 * Subida por partes y asociación al borrador.
 *
 * Estas operaciones son de administración y escriben: siempre exigen sesión de
 * administrador **aquí** (además de en el servicio) y se enrutan al almacén de
 * la demostración o a Firestore según el modo. El identificador del documento
 * lo calcula el servidor.
 */
export async function adminCreatePdfUpload(actor: Actor, input: Omit<CreateUploadInput, "actor">) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminCreatePdfUpload(actor, input)
    : firebase.adminCreatePdfUpload(actor, input);
}

export async function adminUploadPdfDocument(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    topicId: string;
    title: string;
    pageCount: number;
    bytes: Uint8Array;
  },
) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminUploadPdfDocument(actor, input)
    : firebase.adminUploadPdfDocument(actor, input);
}

export async function adminPutPdfPart(
  actor: Actor,
  input: { documentId: string; index: number; bytes: Uint8Array },
) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminPutPdfPart(actor, input)
    : firebase.adminPutPdfPart(actor, input);
}

export async function adminFinalizePdfUpload(actor: Actor, documentId: string) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminFinalizePdfUpload(actor, documentId)
    : firebase.adminFinalizePdfUpload(actor, documentId);
}

export async function adminAbortPdfUpload(actor: Actor, documentId: string) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminAbortPdfUpload(actor, documentId)
    : firebase.adminAbortPdfUpload(actor, documentId);
}

export async function adminArchivePdfDocument(actor: Actor, documentId: string) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminArchivePdfDocument(actor, documentId)
    : firebase.adminArchivePdfDocument(actor, documentId);
}

export async function adminPdfStorage(actor: Actor): Promise<StorageUsage> {
  assertAdmin(actor);
  return portalMode() === "demo" ? demo.adminPdfStorage() : firebase.adminPdfStorage(actor);
}

export async function adminPendingPdfUploads(
  actor: Actor,
  courseId: string,
  version: number,
): Promise<PdfDocumentMeta[]> {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminPendingPdfUploads(courseId, version)
    : firebase.adminPendingPdfUploads(actor, courseId, version);
}

export async function adminAttachDocument(
  actor: Actor,
  input: { documentId: string; expectedRevision: number },
): Promise<AttachResult> {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminAttachDocument(actor, input)
    : firebase.adminAttachDocument(actor, input);
}

/** Datos del editor de estructura. Solo lectura; nunca publica. */
export async function adminDraftEditor(actor: Actor, courseId: string, version?: number) {
  assertAdmin(actor);
  return portalMode() === "demo"
    ? demo.adminDraftEditor(courseId, version)
    : firebase.adminDraftEditor(actor, courseId, version);
}

export async function adminPublish(actor: Actor, courseId: string, version: number) {
  return portalMode() === "demo"
    ? demo.adminPublish(actor, courseId, version)
    : firebase.adminPublish(actor, courseId, version);
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
