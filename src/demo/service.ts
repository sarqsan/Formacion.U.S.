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
import { publishCourseVersion, updateDraftVersion, saveDraftVersion } from "@/server/courses/catalog";
import { createCourse, type CourseEditorDependencies } from "@/server/courses/editor";
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

export async function adminSaveDraft(actor: Actor, definition: CourseVersionDefinition) {
  return saveDraftVersion({ actor, definition }, demoDeps());
}

export async function adminUpdateDraft(actor: Actor, definition: CourseVersionDefinition) {
  return updateDraftVersion({ actor, definition }, demoDeps());
}

export async function adminPublish(actor: Actor, courseId: string, version: number) {
  return publishCourseVersion({ actor, courseId, version }, demoDeps());
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
