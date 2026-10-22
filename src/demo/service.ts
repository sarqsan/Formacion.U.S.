import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import { completionPercent } from "@/domain/progress/course-progress";
import {
  assertCanViewPage,
  initDocumentProgress,
  nextAllowedPage,
  recordPageViewed,
} from "@/domain/progress/reading";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import { mandatoryTopicsOf, type PublicQuestion } from "@/server/courses/catalog";
import { revokeEnrollment, enrollStudent } from "@/server/enrollments/service";
import { loadOrInitProgress } from "@/server/learning/progress-loader";
import {
  courseViewForLearner as learnerCourseView,
  coursesForLearner as learnerCourses,
  locatePublishedDocument,
  type CourseCard,
  type CourseView,
  type DocumentView,
} from "@/server/portal/learner";
import { publishCourseVersion } from "@/server/courses/catalog";
import {
  createCourse,
  draftEditorView,
  resolveEditorVersion,
  saveDraftAssessments,
  saveDraftStructure,
  startDraft,
  type CourseEditorDependencies,
  type DraftEditorView,
  type DraftStructure,
  type SaveAssessmentsResult,
} from "@/server/courses/editor";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  abortPdfUpload,
  archivePdfDocument,
  createPdfUpload,
  finalizePdfUpload,
  putPdfUploadPart,
  storageUsage,
  uploadPdfDocument,
  type StorageUsage,
  type UploadDependencies,
  type UploadDocumentResult,
} from "@/server/documents/service";
import {
  attachDocumentToDraft,
  type AttachResult,
} from "@/server/documents/attach";
import type { PdfDocumentMeta } from "@/server/documents/store";
import {
  documentFileSummary as documentFileSummaryFor,
  isDocumentFileAvailable,
  readDocumentFile,
  type DocumentFileDependencies,
} from "@/server/documents/file";
import { MemoryPdfDocumentStore } from "@/demo/pdf-store";
import { budgetBytesFromMiB } from "@/domain/storage/pdf-chunks";
import type { AttemptRecord, StoredProgress } from "@/server/learning/store";
import { screensForDocument, type DemoScreen } from "@/demo/content";
import {
  DemoCatalogStore,
  DemoCourseEditorStore,
  DemoEnrollmentStore,
  DemoLearningStore,
  definitionOf,
  demoAccountByUid,
  demoState,
  listCourseSummaries,
  listVersionsOf,
  progressKey,
} from "@/demo/store";

/**
 * SERVICIOS DE LA DEMOSTRACIÓN
 * ============================
 *
 * Todo lo que hace la interfaz en modo demostración pasa por aquí, y casi todo
 * lo que hay aquí llama a los servicios **reales** del proyecto
 * (`submitAssessment`, `assertCourseAccess`, `enrollStudent`,
 * `publishCourseVersion`…). Lo único propio de la demostración es:
 *
 *   · la lectura de «pantallas» de texto en lugar de páginas de PDF;
 *   · las consultas de resumen para las pantallas.
 */

export function demoDeps() {
  return {
    store: catalogStore(),
    catalog: catalogStore(),
    enrollments: new DemoEnrollmentStore(),
    learning: new DemoLearningStore(),
  };
}

/** Instancias sin estado: el estado vive en `demoState()`. */
function catalogStore(): DemoCatalogStore {
  return new DemoCatalogStore();
}

function demoCourseEditorDeps(): CourseEditorDependencies {
  return { store: new DemoCourseEditorStore() };
}

/**
 * Dependencias de la subida en la demostración.
 *
 * La demo no lee la configuración del servidor: no hay Firebase y no debe
 * exigir credenciales para arrancar. El presupuesto sale de la misma variable
 * (`PDF_STORAGE_BUDGET_MB`, opcional) con el mismo recorte al techo seguro; si
 * no está, se usa el valor por defecto del dominio (512 MiB).
 */
function demoUploadDeps(): UploadDependencies {
  const raw = process.env.PDF_STORAGE_BUDGET_MB;
  const mib = raw && raw.trim() !== "" ? Number(raw) : undefined;
  return {
    documents: new MemoryPdfDocumentStore(demoState().pdf),
    catalog: catalogStore(),
    budgetBytes: budgetBytesFromMiB(mib),
  };
}

/**
 * Dependencias de lectura del PDF completo en la demostración.
 *
 * Mismo servicio que en producción (`readDocumentFile`), con los bytes en
 * memoria. Sin límite de descargas: un solo proceso y nada real que proteger.
 */
function demoFileDeps(): DocumentFileDependencies {
  return {
    documents: new MemoryPdfDocumentStore(demoState().pdf),
    catalog: catalogStore(),
    enrollments: new DemoEnrollmentStore(),
  };
}

/** ¿Puede este actor abrir el PDF de este documento? (sin leer los bytes) */
export async function documentFileAvailable(actor: Actor, documentId: string): Promise<boolean> {
  return isDocumentFileAvailable({ actor, documentId }, demoFileDeps());
}

/** Resumen para la interfaz (título, páginas y tamaño), o `null` si no es accesible. */
export async function documentFileSummary(actor: Actor, documentId: string) {
  return documentFileSummaryFor({ actor, documentId }, demoFileDeps());
}

/** PDF completo verificado, listo para entregar con `application/pdf`. */
export async function documentFile(actor: Actor, documentId: string) {
  return readDocumentFile({ actor, documentId }, demoFileDeps());
}

export function accountLabel(uid: string): string {
  const account = demoAccountByUid(uid);
  return account ? account.username : uid;
}

export function accountName(uid: string): string {
  return demoAccountByUid(uid)?.displayName ?? uid;
}

// ---------------------------------------------------------------------------
// Alumno
// ---------------------------------------------------------------------------

// Los tipos y el cálculo de progreso son **los mismos** que usa la conexión
// real: viven en `@/server/portal/learner`. Así la demostración no puede
// mostrar un porcentaje distinto del que daría Firestore con los mismos datos.
export type { CourseCard, CourseView, DocumentView, TopicView } from "@/server/portal/learner";

export async function coursesForLearner(actor: Actor): Promise<CourseCard[]> {
  return learnerCourses(demoDeps(), actor);
}

export async function courseViewForLearner(actor: Actor, courseId: string): Promise<CourseView> {
  return learnerCourseView(demoDeps(), actor, courseId);
}

export interface ScreenView {
  screens: DemoScreen[];
  page: number;
  totalPages: number;
  lastPageViewed: number;
  topicTitle: string;
  documentTitle: string;
  topicId: string;
  documentId: string;
  finished: boolean;
}

/**
 * Localiza un documento dentro de la versión publicada del curso.
 *
 * Delega en la misma comprobación que usará Firestore: matrícula, publicación
 * y pertenencia del documento a la versión.
 */
async function locateDocument(actor: Actor, courseId: string, documentId: string) {
  const deps = demoDeps();
  const active = assertActiveAccount(actor);
  const located = await locatePublishedDocument(deps, active, courseId, documentId);
  return {
    deps,
    active,
    course: located.course,
    version: located.version,
    topic: located.topic,
    document: located.document,
  };
}

export async function screenView(
  actor: Actor,
  input: { courseId: string; documentId: string; page?: number },
): Promise<ScreenView> {
  const { deps, active, course, version, topic, document } = await locateDocument(
    actor,
    input.courseId,
    input.documentId,
  );

  const at = new Date().toISOString();
  const { progress } = await loadOrInitProgress({
    learning: deps.learning,
    uid: active.uid,
    courseId: input.courseId,
    publishedVersion: course.publishedVersion as number,
    mandatoryTopicIds: mandatoryTopicsOf(version),
    at,
  });

  const current =
    progress.documents[document.id] ??
    initDocumentProgress(document.id, document.pageCount);

  // La página pedida nunca puede ir por delante de la permitida: leer en orden
  // es una regla del dominio, no un detalle de la interfaz.
  const requested = input.page ?? nextAllowedPage(current);
  const page = Math.min(Math.max(1, requested), nextAllowedPage(current));

  return {
    screens: screensForDocument(document.id, document.pageCount, document.title),
    page,
    totalPages: document.pageCount,
    lastPageViewed: current.lastPageViewed,
    topicTitle: topic.title,
    documentTitle: document.title,
    topicId: topic.id,
    documentId: document.id,
    finished: current.lastPageViewed >= document.pageCount,
  };
}

/**
 * Marca una pantalla como leída. Usa las mismas funciones de dominio que la
 * lectura de PDF (`assertCanViewPage`, `recordPageViewed`), pero no mueve bytes:
 * el contenido de la demostración es texto.
 */
export async function readScreen(
  actor: Actor,
  input: { courseId: string; documentId: string; page: number },
): Promise<{ nextPage: number; finished: boolean }> {
  const { deps, active, course, version, document } = await locateDocument(
    actor,
    input.courseId,
    input.documentId,
  );

  const at = new Date().toISOString();
  const { progress, archive } = await loadOrInitProgress({
    learning: deps.learning,
    uid: active.uid,
    courseId: input.courseId,
    publishedVersion: course.publishedVersion as number,
    mandatoryTopicIds: mandatoryTopicsOf(version),
    at,
  });

  const current =
    progress.documents[document.id] ??
    initDocumentProgress(document.id, document.pageCount);

  assertCanViewPage(current, input.page);
  const updated = recordPageViewed(current, input.page, at);

  await deps.learning.saveProgress(
    {
      ...progress,
      documents: { ...progress.documents, [document.id]: updated },
      updatedAt: at,
    },
    archive,
  );

  return {
    nextPage: nextAllowedPage(updated),
    finished: updated.lastPageViewed >= document.pageCount,
  };
}

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------

export interface AdminOverview {
  accounts: number;
  activeAccounts: number;
  pendingAccounts: number;
  courses: number;
  publishedCourses: number;
  draftVersions: number;
  enrollments: number;
  activeEnrollments: number;
  attempts: number;
  completions: number;
}

export function adminOverview(): AdminOverview {
  const state = demoState();
  const versions = [...state.courses.values()].flatMap((record) => [...record.versions.values()]);
  const enrollments = [...state.enrollments.values()];

  return {
    accounts: state.accounts.length,
    activeAccounts: state.accounts.filter((account) => account.status === "active").length,
    pendingAccounts: state.accounts.filter((account) => account.status === "pending_activation").length,
    courses: state.courses.size,
    publishedCourses: [...state.courses.values()].filter(
      (record) => record.summary.publishedVersion !== null,
    ).length,
    draftVersions: versions.filter((stored) => stored.version.status === "draft").length,
    enrollments: enrollments.length,
    activeEnrollments: enrollments.filter((item) => item.status === "active").length,
    attempts: state.attempts.length,
    completions: [...state.progress.values()].filter((item) => item.completedAt !== null).length,
  };
}

export interface AdminCourseRow {
  courseId: string;
  title: string;
  publishedVersion: number | null;
  /** Última versión guardada como borrador; null si el curso no tiene ninguna. */
  lastDraftVersion: number | null;
  versions: Array<{ version: number; status: string; title: string }>;
  drafts: number;
}

export function adminCourses(): AdminCourseRow[] {
  return listCourseSummaries().map((summary) => {
    const versions = listVersionsOf(summary.courseId);
    return {
      courseId: summary.courseId,
      title: summary.title,
      publishedVersion: summary.publishedVersion,
      lastDraftVersion: summary.lastDraftVersion,
      versions,
      drafts: versions.filter((version) => version.status === "draft").length,
    };
  });
}

export interface AdminCourseDetail extends AdminCourseRow {
  versions: Array<{ version: number; status: string; title: string }>;
  selected: {
    version: number;
    status: string;
    definition: CourseVersionDefinition | null;
    topics: Array<{
      id: string;
      title: string;
      order: number;
      mandatory: boolean;
      documents: Array<{ id: string; title: string; pageCount: number }>;
      questions: number;
    }>;
    finalExamQuestions: number;
    publishedAt: string | null;
    publishedBy: string | null;
  } | null;
}

export async function adminCourseDetail(
  courseId: string,
  version?: number,
): Promise<AdminCourseDetail | null> {
  const rows = adminCourses();
  const row = rows.find((item) => item.courseId === courseId);
  if (!row) return null;

  const deps = demoDeps();
  const target =
    version ?? row.publishedVersion ?? row.versions[0]?.version ?? null;
  const selectedVersion = target ? await deps.catalog.getVersion(courseId, target) : null;
  const definition = target ? definitionOf(courseId, target) : null;

  return {
    ...row,
    selected: selectedVersion
      ? {
          version: selectedVersion.version,
          status: selectedVersion.status,
          definition,
          topics: selectedVersion.topics.map((topic) => ({
            id: topic.id,
            title: topic.title,
            order: topic.order,
            mandatory: topic.mandatory,
            documents: topic.documents.map((document) => ({ ...document })),
            questions: topic.quiz.length,
          })),
          finalExamQuestions: selectedVersion.finalExam.length,
          publishedAt: selectedVersion.publishedAt,
          publishedBy: selectedVersion.publishedBy,
        }
      : null,
  };
}

export interface EnrollmentRow {
  uid: string;
  username: string;
  personRol: string;
  courseId: string;
  courseTitle: string;
  status: string;
  enrolledAt: string;
  percent: number;
  topicsPassed: number;
  topicsTotal: number;
  finalExamPassed: boolean;
  completed: boolean;
}

export async function adminEnrollments(): Promise<EnrollmentRow[]> {
  const deps = demoDeps();
  const rows: EnrollmentRow[] = [];

  for (const enrollment of demoState().enrollments.values()) {
    const account = demoAccountByUid(enrollment.uid);
    const course = await deps.catalog.getCourse(enrollment.courseId);
    const published = course?.publishedVersion ?? null;
    const version =
      published !== null ? await deps.catalog.getVersion(enrollment.courseId, published) : null;
    const stored = version
      ? await deps.learning.getProgress(enrollment.uid, enrollment.courseId)
      : null;

    rows.push({
      uid: enrollment.uid,
      username: account?.username ?? enrollment.uid,
      personRol: account?.personRol ?? "—",
      courseId: enrollment.courseId,
      courseTitle: version?.title ?? enrollment.courseId,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt,
      percent: stored ? completionPercent(stored) : 0,
      topicsPassed: stored
        ? stored.mandatoryTopicIds.filter((topicId) => stored.topics[topicId]?.passed).length
        : 0,
      topicsTotal: version ? mandatoryTopicsOf(version).length : 0,
      finalExamPassed: stored?.finalExam.passed ?? false,
      completed: stored?.completedAt != null,
    });
  }

  return rows.sort((a, b) => a.username.localeCompare(b.username, "es"));
}

export interface ProgressRow extends EnrollmentRow {
  attempts: AttemptRecord[];
  pending: string[];
}

export async function adminProgress(): Promise<ProgressRow[]> {
  const rows = await adminEnrollments();
  const deps = demoDeps();
  const attempts = demoState().attempts;

  return Promise.all(
    rows.map(async (row) => {
      const course = await deps.catalog.getCourse(row.courseId);
      const version =
        course?.publishedVersion != null
          ? await deps.catalog.getVersion(row.courseId, course.publishedVersion)
          : null;
      const stored = await deps.learning.getProgress(row.uid, row.courseId);

      const pending: string[] = [];
      if (version && stored) {
        for (const topic of version.topics) {
          if (topic.mandatory && !stored.topics[topic.id]?.passed) pending.push(topic.title);
        }
        if (!stored.finalExam.passed) pending.push("Examen final");
      } else if (version) {
        pending.push(...version.topics.filter((topic) => topic.mandatory).map((topic) => topic.title));
        pending.push("Examen final");
      }

      return {
        ...row,
        attempts: attempts
          .filter((attempt) => attempt.uid === row.uid && attempt.courseId === row.courseId)
          .sort((a, b) => b.at.localeCompare(a.at)),
        pending,
      };
    }),
  );
}

export function existingProgressFor(uid: string, courseId: string): StoredProgress | null {
  return demoState().progress.get(progressKey(uid, courseId)) ?? null;
}

export { progressKey };

export function demoLearners() {
  return demoState().accounts.filter((account) => account.role === "learner");
}

// ---------------------------------------------------------------------------
// Acciones de administración (servicios reales sobre el almacén en memoria)
// ---------------------------------------------------------------------------

export async function adminEnroll(actor: Actor, uid: string, courseId: string) {
  return enrollStudent({ actor, uid, courseId }, demoDeps());
}

export async function adminRevokeEnrollment(actor: Actor, uid: string, courseId: string) {
  return revokeEnrollment({ actor, uid, courseId }, demoDeps());
}

/** Crea un curso vacío (sin versiones) a partir de la plantilla vacía. */
export async function adminCreateCourse(
  actor: Actor,
  input: { courseId: string; title: string; description?: string },
) {
  return createCourse({ ...input, actor }, demoCourseEditorDeps());
}

/** Abre (o reanuda) el borrador del curso: no publica nada. */
export async function adminStartDraft(actor: Actor, courseId: string) {
  return startDraft({ actor, courseId }, demoDeps());
}

/** Guarda la estructura del borrador (título, descripción y temas). */
export async function adminSaveDraftStructure(
  actor: Actor,
  input: { courseId: string; version: number; expectedRevision: number; structure: DraftStructure },
) {
  return saveDraftStructure({ actor, ...input }, demoDeps());
}

/** Guarda cuestionarios y examen final del borrador, con sus claves aparte. */
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
  return saveDraftAssessments({ actor, ...input }, demoDeps());
}

/** Vista del editor de estructura, o `null` si el curso o la versión no existen. */
export async function adminDraftEditor(
  courseId: string,
  version?: number,
): Promise<DraftEditorView | null> {
  const deps = demoDeps();
  const course = await deps.catalog.getCourse(courseId);
  if (!course) return null;

  const versions = (await deps.catalog.listVersions(courseId)).map((item) => item.version);
  const target = resolveEditorVersion(course, versions, version);
  if (target === null) return null;

  const document = await deps.catalog.getVersion(courseId, target);
  if (!document) return null;

  const keys = await deps.catalog.getAnswerKeys(courseId, target);
  return draftEditorView({
    course,
    version: document,
    definition: definitionFromDocuments(document, keys),
  });
}

// ---------------------------------------------------------------------------
// Documentos PDF (subida por partes)
// ---------------------------------------------------------------------------

export async function adminCreatePdfUpload(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    topicId: string;
    title: string;
    pageCount: number;
    bytes: number;
    sha256: string;
  },
) {
  return createPdfUpload({ actor, ...input }, demoUploadDeps());
}

/** Subida de una sola petición (ficheros pequeños), mismo ciclo y misma reserva. */
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
): Promise<UploadDocumentResult> {
  return uploadPdfDocument({ actor, ...input }, demoUploadDeps());
}

export async function adminPutPdfPart(
  actor: Actor,
  input: { documentId: string; index: number; bytes: Uint8Array },
) {
  return putPdfUploadPart({ actor, ...input }, demoUploadDeps());
}

export async function adminFinalizePdfUpload(actor: Actor, documentId: string) {
  return finalizePdfUpload({ actor, documentId }, demoUploadDeps());
}

export async function adminAbortPdfUpload(actor: Actor, documentId: string) {
  return abortPdfUpload({ actor, documentId }, demoUploadDeps());
}

export async function adminArchivePdfDocument(actor: Actor, documentId: string) {
  return archivePdfDocument({ actor, documentId }, demoUploadDeps());
}

export async function adminPdfStorage(): Promise<StorageUsage> {
  return storageUsage(demoUploadDeps());
}

/** Subidas pendientes de una versión, para reanudarlas o cancelarlas. */
export async function adminPendingPdfUploads(
  courseId: string,
  version: number,
): Promise<PdfDocumentMeta[]> {
  return demoUploadDeps().documents.listPending({ courseId, version });
}

export async function adminAttachDocument(
  actor: Actor,
  input: { documentId: string; expectedRevision: number },
): Promise<AttachResult> {
  return attachDocumentToDraft(
    { actor, ...input },
    { documents: demoUploadDeps().documents, catalog: catalogStore() },
  );
}

// Los servicios de escritura anteriores (`saveDraftVersion`, `updateDraftVersion`)
// siguen existiendo para pruebas de contrato, pero la administración usa el
// editor de estructura: una sola puerta, con revisión y puntero de borrador.

export async function adminPublish(actor: Actor, courseId: string, version: number) {
  // Publicar exige comprobar que los documentos de la versión existen y están
  // activos: se pasa la misma consulta de metadatos que usa la subida.
  return publishCourseVersion(
    { actor, courseId, version },
    { store: catalogStore(), documents: new MemoryPdfDocumentStore(demoState().pdf) },
  );
}

// ---------------------------------------------------------------------------
// Utilidades de presentación
// ---------------------------------------------------------------------------

export function questionLabel(question: PublicQuestion, optionId: string): string {
  return question.optionLabels?.[optionId] ?? optionId;
}

export function readPercent(document: DocumentView): number {
  return Math.round((document.lastPageViewed / document.totalPages) * 100);
}
