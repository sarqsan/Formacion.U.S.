import { DomainError } from "@/domain/text";
import { assertActiveAccount, assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import { completionPercent } from "@/domain/progress/course-progress";
import { nextAllowedPage } from "@/domain/progress/reading";
import type { ImportPreview } from "@/domain/people/import-rows";
import type { AccountRole, AccountStatus, PersonRol } from "@/domain/roles";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { mandatoryTopicsOf } from "@/server/courses/catalog";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  publishCourseVersion,
  saveDraftVersion,
  updateDraftVersion,
} from "@/server/courses/catalog";
import { enrollStudent, revokeEnrollment } from "@/server/enrollments/service";
import { submitAssessment } from "@/server/assessments/service";
import { parsePeopleWorkbook } from "@/server/import/excel";
import { buildImportPreview } from "@/server/import/service";
import { importDependencies } from "@/server/deps";
import { documentDependencies } from "@/server/deps";
import { readDocumentPages, uploadPdfDocument } from "@/server/documents/service";
import { getAdminDb } from "@/server/firebase/admin";
import { FirestoreCourseCatalogStore } from "@/server/firebase/catalog-store";
import { FirestoreEnrollmentStore } from "@/server/firebase/enrollment-store";
import { FirestoreLearningStore } from "@/server/firebase/learning-store";
import { guard } from "@/server/firebase/repositories";
import type { AttemptRecord, StoredProgress } from "@/server/learning/store";
import {
  courseViewForLearner,
  coursesForLearner,
  locatePublishedDocument,
  type CourseCard,
  type CourseView,
} from "@/server/portal/learner";

/**
 * PORTAL DE FIREBASE (persistencia real)
 * ======================================
 *
 * Implementa las mismas operaciones que el portal de la demostración, pero
 * contra Firestore + Firebase Authentication. La interfaz no cambia una línea:
 * recibe las mismas estructuras.
 *
 * Regla que se repite en cada función: **autorizar antes de leer**. El Admin
 * SDK elude las reglas de Firestore, así que cada operación comprueba aquí la
 * sesión y el rol. Si no se hace, cualquier llamada del servidor sería un
 * acceso total.
 *
 * Nada de esto se ha ejecutado contra el proyecto real: las credenciales no
 * están en este entorno (ver docs/INFORME-FASE-8.md).
 */

export function firestoreDeps() {
  return {
    catalog: new FirestoreCourseCatalogStore(),
    enrollments: new FirestoreEnrollmentStore(),
    learning: new FirestoreLearningStore(),
  };
}

export const MODE = "firebase" as const;

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

export interface AccountRow {
  uid: string;
  username: string;
  displayName: string;
  personRol: PersonRol | string;
  role: AccountRole | string;
  status: AccountStatus | string;
  createdAt: string;
}

interface AccountDocument {
  uid: string;
  username?: string;
  apellido?: string;
  personRol?: string;
  role?: string;
  status?: string;
  createdAt?: string;
  authEmail?: string;
}

function toAccountRow(data: AccountDocument): AccountRow {
  const username = String(data.username ?? "");
  return {
    uid: String(data.uid),
    username,
    displayName: data.apellido ? `${data.apellido} (${username})` : username || data.uid,
    personRol: data.personRol ?? "—",
    role: data.role ?? "learner",
    status: data.status ?? "pending_activation",
    createdAt: data.createdAt ?? "",
  };
}

/** Lee todas las cuentas. Solo administración: se comprueba antes de tocar la base. */
export async function accounts(actor: Actor): Promise<AccountRow[]> {
  assertAdmin(actor);
  return guard(async () => {
    const snapshot = await getAdminDb().collection("accounts").limit(1000).get();
    return snapshot.docs
      .map((doc) => toAccountRow({ ...(doc.data() as AccountDocument), uid: doc.id }))
      .sort((a, b) => a.username.localeCompare(b.username, "es"));
  });
}

export async function learners(actor: Actor): Promise<AccountRow[]> {
  const rows = await accounts(actor);
  return rows.filter((row) => row.role === "learner");
}

/** Ficha del usuario que ha iniciado sesión (para el saludo del panel). */
export async function profile(actor: Actor): Promise<AccountRow | null> {
  const active = assertActiveAccount(actor);
  return guard(async () => {
    const doc = await getAdminDb().collection("accounts").doc(active.uid).get();
    if (!doc.exists) return null;
    return toAccountRow({ ...(doc.data() as AccountDocument), uid: active.uid });
  });
}

// ---------------------------------------------------------------------------
// Alumno
// ---------------------------------------------------------------------------

export async function learnerCourses(actor: Actor): Promise<CourseCard[]> {
  return coursesForLearner(firestoreDeps(), actor);
}

export async function learnerCourseView(actor: Actor, courseId: string): Promise<CourseView> {
  return courseViewForLearner(firestoreDeps(), actor, courseId);
}

export interface PdfReadingView {
  kind: "pdf";
  courseId: string;
  topicId: string;
  topicTitle: string;
  documentId: string;
  documentTitle: string;
  totalPages: number;
  page: number;
  lastPageViewed: number;
  finished: boolean;
  bytes: number;
  sha256: string;
}

/**
 * Estado de lectura de un documento.
 *
 * A diferencia de la demostración, aquí no hay texto: el documento es un PDF
 * troceado en Firestore. La vista devuelve la posición permitida y los datos
 * del fichero; los bytes se piden al endpoint autorizado
 * `/api/documents/{id}/pages`, que también registra la lectura.
 */
export async function learnerReadingView(
  actor: Actor,
  input: { courseId: string; documentId: string; page?: number },
): Promise<PdfReadingView> {
  const located = await locatePublishedDocument(
    firestoreDeps(),
    actor,
    input.courseId,
    input.documentId,
  );

  const meta = await documentDependencies().documents.getMeta(input.documentId);
  if (!meta) {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no tiene contenido cargado.", 404);
  }

  const current = located.progress.documents[located.document.id];
  const lastPageViewed = current?.lastPageViewed ?? 0;
  const allowed = current ? nextAllowedPage(current) : 1;
  const requested = input.page ?? allowed;
  const page = Math.min(Math.max(1, requested), allowed);

  return {
    kind: "pdf",
    courseId: input.courseId,
    topicId: located.topic.id,
    topicTitle: located.topic.title,
    documentId: located.document.id,
    documentTitle: located.document.title,
    totalPages: located.document.pageCount,
    page,
    lastPageViewed,
    finished: lastPageViewed >= located.document.pageCount,
    bytes: meta.bytes,
    sha256: meta.sha256,
  };
}

/**
 * Registra la lectura de una página.
 *
 * Pasa por el mismo servicio que sirve los bytes (`readDocumentPages`): así la
 * secuencia, la matrícula y el límite de peticiones se comprueban una sola vez
 * y en el mismo sitio. Los bytes se descartan aquí; el visor de PDF es la
 * pieza que falta y está declarada como pendiente en el informe.
 */
export async function learnerReadPage(
  actor: Actor,
  input: { courseId: string; documentId: string; page: number },
): Promise<{ nextPage: number; finished: boolean; topicId: string; note: string }> {
  const located = await locatePublishedDocument(
    firestoreDeps(),
    actor,
    input.courseId,
    input.documentId,
  );

  const result = await readDocumentPages(
    { actor, documentId: input.documentId, from: input.page, to: input.page },
    documentDependencies(),
  );

  return {
    nextPage: result.nextPage,
    finished: result.remainingPages === 0,
    topicId: located.topic.id,
    note: `Página ${result.from} servida desde Firestore (${result.bytes.length} bytes del PDF).`,
  };
}

export async function learnerSubmit(input: {
  actor: Actor;
  courseId: string;
  assessmentType: "topic" | "final";
  topicId?: string;
  answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
}) {
  return submitAssessment(input, firestoreDeps());
}

// ---------------------------------------------------------------------------
// Administración: resúmenes
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

async function countOf(collection: string, filters: Array<[string, "==" | "!=", unknown]> = []) {
  let query = getAdminDb().collection(collection) as FirebaseFirestore.Query;
  for (const [field, op, value] of filters) {
    query = query.where(field, op, value);
  }
  const snapshot = await query.count().get();
  return snapshot.data().count;
}

export async function adminOverview(actor: Actor): Promise<AdminOverview> {
  assertAdmin(actor);
  return guard(async () => {
    const deps = firestoreDeps();
    const db = getAdminDb();

    const [accountCount, activeAccounts, pendingAccounts, coursesSnapshot, enrollments, active] =
      await Promise.all([
        countOf("accounts"),
        countOf("accounts", [["status", "==", "active"]]),
        countOf("accounts", [["status", "==", "pending_activation"]]),
        db.collection(COLLECTIONS.courses).get(),
        countOf(COLLECTIONS.enrollments),
        countOf(COLLECTIONS.enrollments, [["status", "==", "active"]]),
      ]);

    let publishedCourses = 0;
    let draftVersions = 0;
    for (const courseDoc of coursesSnapshot.docs) {
      const data = courseDoc.data() as { publishedVersion?: number | null };
      if (typeof data.publishedVersion === "number") publishedCourses += 1;
      const versions = await deps.catalog.listVersions(courseDoc.id);
      draftVersions += versions.filter((version) => version.status === "draft").length;
    }

    // `completedAt` siempre existe (null o fecha ISO): `!=` lo excluye bien.
    const completions = await countOf(COLLECTIONS.progress, [["completedAt", "!=", null]]);

    return {
      accounts: accountCount,
      activeAccounts,
      pendingAccounts,
      courses: coursesSnapshot.size,
      publishedCourses,
      draftVersions,
      enrollments,
      activeEnrollments: active,
      attempts: await countOf(COLLECTIONS.attempts),
      completions,
    };
  });
}

export interface AdminCourseRow {
  courseId: string;
  title: string;
  publishedVersion: number | null;
  versions: Array<{ version: number; status: string; title: string }>;
  drafts: number;
}

export async function adminCourses(actor: Actor): Promise<AdminCourseRow[]> {
  assertAdmin(actor);
  return guard(async () => {
    const deps = firestoreDeps();
    const snapshot = await getAdminDb().collection(COLLECTIONS.courses).get();
    const rows: AdminCourseRow[] = [];

    for (const doc of snapshot.docs) {
      const data = doc.data() as { title?: string; publishedVersion?: number | null };
      const versions = await deps.catalog.listVersions(doc.id);
      const detailed: Array<{ version: number; status: string; title: string }> = [];
      for (const version of versions) {
        const document = await deps.catalog.getVersion(doc.id, version.version);
        detailed.push({
          version: version.version,
          status: version.status,
          title: document?.title ?? data.title ?? doc.id,
        });
      }

      rows.push({
        courseId: doc.id,
        title: data.title ?? doc.id,
        publishedVersion: data.publishedVersion ?? null,
        versions: detailed,
        drafts: detailed.filter((version) => version.status === "draft").length,
      });
    }

    return rows.sort((a, b) => a.title.localeCompare(b.title, "es"));
  });
}

export interface AdminCourseDetail extends AdminCourseRow {
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
  actor: Actor,
  courseId: string,
  version?: number,
): Promise<AdminCourseDetail | null> {
  assertAdmin(actor);
  const deps = firestoreDeps();
  const row = (await adminCourses(actor)).find((item) => item.courseId === courseId);
  if (!row) return null;

  const target = version ?? row.publishedVersion ?? row.versions[0]?.version ?? null;
  if (target === null) return { ...row, selected: null };

  const selected = await deps.catalog.getVersion(courseId, target);
  if (!selected) return { ...row, selected: null };

  const keys = await deps.catalog.getAnswerKeys(courseId, target);

  return {
    ...row,
    selected: {
      version: selected.version,
      status: selected.status,
      definition: keys ? definitionFromDocuments(selected, keys) : null,
      topics: selected.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        order: topic.order,
        mandatory: topic.mandatory,
        documents: topic.documents.map((document) => ({ ...document })),
        questions: topic.quiz.length,
      })),
      finalExamQuestions: selected.finalExam.length,
      publishedAt: selected.publishedAt,
      publishedBy: selected.publishedBy,
    },
  };
}

/** Definición editable de una versión (contenido + claves), o `null`. */
export async function definitionOf(
  actor: Actor,
  courseId: string,
  version: number,
): Promise<CourseVersionDefinition | null> {
  assertAdmin(actor);
  const deps = firestoreDeps();
  const document = await deps.catalog.getVersion(courseId, version);
  if (!document) return null;
  const keys = await deps.catalog.getAnswerKeys(courseId, version);
  if (!keys) return null;
  return definitionFromDocuments(document, keys);
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

async function enrollmentRows(actor: Actor): Promise<EnrollmentRow[]> {
  assertAdmin(actor);
  const deps = firestoreDeps();
  const db = getAdminDb();

  const [enrollmentsSnapshot, accountsSnapshot] = await Promise.all([
    db.collection(COLLECTIONS.enrollments).limit(2000).get(),
    db.collection("accounts").limit(1000).get(),
  ]);

  const accountByUid = new Map<string, AccountDocument>();
  for (const doc of accountsSnapshot.docs) {
    accountByUid.set(doc.id, { ...(doc.data() as AccountDocument), uid: doc.id });
  }

  const rows: EnrollmentRow[] = [];
  for (const doc of enrollmentsSnapshot.docs) {
    const data = doc.data() as {
      uid?: string;
      courseId?: string;
      status?: string;
      enrolledAt?: string;
    };
    const uid = String(data.uid ?? "");
    const courseId = String(data.courseId ?? "");
    const account = accountByUid.get(uid);
    const course = await deps.catalog.getCourse(courseId);
    const version =
      course?.publishedVersion != null
        ? await deps.catalog.getVersion(courseId, course.publishedVersion)
        : null;
    const progress = await deps.learning.getProgress(uid, courseId);

    rows.push({
      uid,
      username: account?.username ?? uid,
      personRol: account?.personRol ?? "—",
      courseId,
      courseTitle: version?.title ?? course?.title ?? courseId,
      status: String(data.status ?? "revoked"),
      enrolledAt: String(data.enrolledAt ?? ""),
      percent: progress ? completionPercent(progress) : 0,
      topicsPassed: progress
        ? progress.mandatoryTopicIds.filter((topicId) => progress.topics[topicId]?.passed).length
        : 0,
      topicsTotal: version ? mandatoryTopicsOf(version).length : 0,
      finalExamPassed: progress?.finalExam.passed ?? false,
      completed: progress?.completedAt != null,
    });
  }

  return rows.sort((a, b) => a.username.localeCompare(b.username, "es"));
}

export async function adminEnrollments(actor: Actor): Promise<EnrollmentRow[]> {
  return guard(() => enrollmentRows(actor));
}

export interface ProgressRow extends EnrollmentRow {
  attempts: AttemptRecord[];
  pending: string[];
}

export async function adminProgress(actor: Actor): Promise<ProgressRow[]> {
  assertAdmin(actor);
  return guard(async () => {
    const deps = firestoreDeps();
    const rows = await enrollmentRows(actor);
    const attemptsSnapshot = await getAdminDb()
      .collection(COLLECTIONS.attempts)
      .orderBy("at", "desc")
      .limit(1000)
      .get();
    const attempts = attemptsSnapshot.docs.map((doc) => doc.data() as AttemptRecord);

    return Promise.all(
      rows.map(async (row) => {
        const progress: StoredProgress | null = await deps.learning.getProgress(
          row.uid,
          row.courseId,
        );
        const course = await deps.catalog.getCourse(row.courseId);
        const version =
          course?.publishedVersion != null
            ? await deps.catalog.getVersion(row.courseId, course.publishedVersion)
            : null;

        const pending: string[] = [];
        if (version) {
          for (const topic of version.topics) {
            if (topic.mandatory && !progress?.topics[topic.id]?.passed) pending.push(topic.title);
          }
          if (!progress?.finalExam.passed) pending.push("Examen final");
        }

        return {
          ...row,
          attempts: attempts.filter(
            (attempt) => attempt.uid === row.uid && attempt.courseId === row.courseId,
          ),
          pending,
        };
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Administración: escrituras
// ---------------------------------------------------------------------------

export async function adminEnroll(actor: Actor, uid: string, courseId: string) {
  return guard(() => enrollStudent({ actor, uid, courseId }, firestoreDeps()));
}

export async function adminRevokeEnrollment(actor: Actor, uid: string, courseId: string) {
  return guard(() => revokeEnrollment({ actor, uid, courseId }, firestoreDeps()));
}

export async function adminSaveDraft(actor: Actor, definition: CourseVersionDefinition) {
  return saveDraftVersion(
    { definition, actor },
    { store: firestoreDeps().catalog },
  );
}

export async function adminUpdateDraft(actor: Actor, definition: CourseVersionDefinition) {
  return updateDraftVersion(
    { definition, actor },
    { store: firestoreDeps().catalog },
  );
}

export async function adminPublish(actor: Actor, courseId: string, version: number) {
  return publishCourseVersion({ actor, courseId, version }, { store: firestoreDeps().catalog });
}

/** Crea la versión siguiente a partir de una ya existente. */
export async function adminNewDraft(actor: Actor, courseId: string, fromVersion: number) {
  const base = await definitionOf(actor, courseId, fromVersion);
  if (!base) {
    throw new DomainError("VERSION_NOT_FOUND", "No se encontró la versión base.", 404);
  }

  const versions = await firestoreDeps().catalog.listVersions(courseId);
  const nextVersion = Math.max(...versions.map((item) => item.version), 0) + 1;
  return adminSaveDraft(actor, { ...base, version: nextVersion });
}

// ---------------------------------------------------------------------------
// Importación y documentos
// ---------------------------------------------------------------------------

export async function previewImport(
  actor: Actor,
  buffer: Buffer,
): Promise<{ preview: ImportPreview; skippedEmptyRows: number }> {
  assertAdmin(actor);
  const parsed = await parsePeopleWorkbook(buffer);
  const { preview } = await buildImportPreview({ rows: parsed.rows, actor }, importDependencies());
  return { preview, skippedEmptyRows: parsed.skippedEmptyRows };
}

export async function uploadDocument(
  actor: Actor,
  input: {
    courseId: string;
    version: number;
    topicId: string;
    documentId: string;
    title: string;
    pageCount: number;
    bytes: Uint8Array;
  },
) {
  return uploadPdfDocument({ actor, ...input }, documentDependencies());
}

/**
 * Comprobación de vida de la conexión real.
 *
 * Se usa en `/estado` para no afirmar «conectado» sin haber hablado con la
 * base de datos: si esto falla, la interfaz debe decir que no está disponible.
 */
export async function checkConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    await getAdminDb().collection("meta").limit(1).get();
    return { ok: true, detail: "Firestore respondió a una lectura de comprobación." };
  } catch {
    return {
      ok: false,
      detail:
        "No se pudo leer Firestore. Revisa credenciales, el ID del proyecto y que la base de datos (default) exista.",
    };
  }
}
