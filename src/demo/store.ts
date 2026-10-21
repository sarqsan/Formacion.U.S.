import { DomainError } from "@/domain/text";
import { initProgress, recordTopicAttempt, type CourseProgress } from "@/domain/progress/course-progress";
import type { CourseVersionDefinition, TopicDefinition } from "@/domain/courses/content";
import type { Enrollment } from "@/domain/courses/enrollment";
import {
  toAnswerKeys,
  toPublicVersion,
  type AnswerKeysDocument,
  type CourseCatalogStore,
  type CourseSummary,
  type CourseVersionDocument,
  type PublicDocument,
} from "@/server/courses/catalog";
import type { CourseVersionStatus, CourseVersionSummary } from "@/domain/courses/versioning";
import type { CourseEditorStore } from "@/server/courses/editor";
import type { EnrollmentStore } from "@/server/enrollments/store";
import type { AttemptRecord, LearningStore, StoredProgress } from "@/server/learning/store";
import {
  DEMO_ACCOUNTS,
  DEMO_COURSES,
  DEMO_ENROLLMENTS,
  type DemoAccount,
} from "@/demo/content";

/**
 * ALMACÉN EN MEMORIA DE LA DEMOSTRACIÓN
 * ====================================
 *
 * Implementa los MISMOS puertos que las versiones de Firestore
 * (`CourseCatalogStore`, `EnrollmentStore`, `LearningStore`), de modo que los
 * servicios reales —corrección de cuestionarios, matrículas, publicación de
 * versiones, progreso— se ejecutan sin cambios. Lo único que cambia es dónde
 * se guardan los datos: la memoria del proceso.
 *
 * Consecuencias, dichas sin adornos:
 *   · no hay persistencia: al reiniciar el servidor se vuelve al estado inicial;
 *   · no hay concurrencia real ni transacciones de Firestore;
 *   · no hay Firebase Authentication ni PDF servidos por fragmentos;
 *   · nada de esto demuestra que las reglas de Firestore funcionen.
 */

export interface DemoCourseRecord {
  summary: CourseSummary;
  versions: Map<
    number,
    { version: CourseVersionDocument; keys: AnswerKeysDocument }
  >;
}

export interface DemoState {
  accounts: DemoAccount[];
  courses: Map<string, DemoCourseRecord>;
  enrollments: Map<string, Enrollment>;
  progress: Map<string, StoredProgress>;
  attempts: AttemptRecord[];
}

const SEED_NOW = "2026-01-08T09:00:00.000Z";

export function enrollmentKey(uid: string, courseId: string): string {
  return `${uid}_${courseId}`;
}

export function progressKey(uid: string, courseId: string): string {
  return `${uid}_${courseId}`;
}

function seedState(): DemoState {
  const state: DemoState = {
    accounts: DEMO_ACCOUNTS.map((account) => ({ ...account })),
    courses: new Map(),
    enrollments: new Map(),
    progress: new Map(),
    attempts: [],
  };

  for (const { definition, published } of DEMO_COURSES) {
    let record = state.courses.get(definition.courseId);
    if (!record) {
      record = {
        summary: {
          courseId: definition.courseId,
          title: definition.title,
          publishedVersion: null,
          lastDraftVersion: null,
        },
        versions: new Map(),
      };
      state.courses.set(definition.courseId, record);
    }

    const createdAt = "2026-01-05T09:00:00.000Z";
    const version = toPublicVersion(definition, {
      createdAt,
      createdBy: "demo-admin",
      status: published ? "published" : "draft",
    });

    if (published) {
      version.publishedAt = createdAt;
      version.publishedBy = "demo-admin";
      record.summary.publishedVersion = definition.version;
      record.summary.title = definition.title;
    }

    record.versions.set(definition.version, {
      version,
      keys: toAnswerKeys(definition, { createdAt }),
    });
    record.summary.lastDraftVersion = definition.version;
  }

  for (const enrollment of DEMO_ENROLLMENTS) {
    const course = state.courses.get(enrollment.courseId);
    state.enrollments.set(enrollmentKey(enrollment.uid, enrollment.courseId), {
      uid: enrollment.uid,
      courseId: enrollment.courseId,
      status: "active",
      version: course?.summary.publishedVersion ?? null,
      enrolledAt: enrollment.enrolledAt,
      enrolledBy: "demo-admin",
      updatedAt: enrollment.enrolledAt,
    });
  }

  // La segunda alumna ya ha superado el primer tema y se ha leído su guía:
  // sirve para que el panel de administración no esté vacío.
  const seeded = state.enrollments.get(enrollmentKey("demo-alumno-2", "curso-prevencion-riesgos"));
  if (seeded) {
    const risksRecord = state.courses.get("curso-prevencion-riesgos");
    const published = risksRecord?.summary.publishedVersion;
    if (risksRecord && published) {
      let progress: CourseProgress & { documents: StoredProgress["documents"] } = {
        ...initProgress("curso-prevencion-riesgos", published, ["riesgos", "emergencias"]),
        documents: {
          "doc-riesgos": {
            documentId: "doc-riesgos",
            totalPages: 3,
            lastPageViewed: 3,
            completedAt: SEED_NOW,
          },
        },
      };
      progress = {
        ...recordTopicAttempt(progress, "riesgos", { passed: false, score: 50 }, "2026-01-07T10:00:00.000Z"),
        documents: progress.documents,
      };
      progress = {
        ...recordTopicAttempt(progress, "riesgos", { passed: true, score: 100 }, SEED_NOW),
        documents: progress.documents,
      };

      state.progress.set(progressKey("demo-alumno-2", "curso-prevencion-riesgos"), {
        ...progress,
        uid: "demo-alumno-2",
        updatedAt: SEED_NOW,
      });

      state.attempts.push(
        {
          uid: "demo-alumno-2",
          courseId: "curso-prevencion-riesgos",
          version: published,
          assessmentType: "topic",
          topicId: "riesgos",
          answers: [{ questionId: "q-riesgos-1", selectedOptionIds: ["b"] }],
          passed: false,
          correctCount: 1,
          totalQuestions: 2,
          score: 50,
          at: "2026-01-07T10:00:00.000Z",
          gradedBy: "server",
        },
        {
          uid: "demo-alumno-2",
          courseId: "curso-prevencion-riesgos",
          version: published,
          assessmentType: "topic",
          topicId: "riesgos",
          answers: [
            { questionId: "q-riesgos-1", selectedOptionIds: ["a"] },
            { questionId: "q-riesgos-2", selectedOptionIds: ["a", "b"] },
          ],
          passed: true,
          correctCount: 2,
          totalQuestions: 2,
          score: 100,
          at: SEED_NOW,
          gradedBy: "server",
        },
      );
    }
  }

  return state;
}

/**
 * Estado compartido por todo el proceso. `globalThis` evita perderlo cuando
 * Next recarga módulos en desarrollo.
 */
const GLOBAL_KEY = Symbol.for("formacion.demo.state");

type DemoGlobal = { [GLOBAL_KEY]?: DemoState };

export function demoState(): DemoState {
  const globalStore = globalThis as unknown as DemoGlobal;
  if (!globalStore[GLOBAL_KEY]) globalStore[GLOBAL_KEY] = seedState();
  return globalStore[GLOBAL_KEY] as DemoState;
}

/** Devuelve la demostración a su estado inicial (botón «reiniciar»). */
export function resetDemoState(): void {
  (globalThis as unknown as DemoGlobal)[GLOBAL_KEY] = seedState();
}

export function demoAccountByUid(uid: string): DemoAccount | null {
  return demoState().accounts.find((account) => account.uid === uid) ?? null;
}

/** Reconstruye la definición editable a partir de lo publicado + las claves. */
export function definitionOf(
  courseId: string,
  version: number,
): CourseVersionDefinition | null {
  const record = demoState().courses.get(courseId);
  const stored = record?.versions.get(version);
  if (!record || !stored) return null;

  const { version: publicVersion, keys } = stored;

  const topics: TopicDefinition[] = publicVersion.topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    order: topic.order,
    mandatory: topic.mandatory,
    documents: topic.documents.map((document) => ({
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
    })),
    quiz: topic.quiz.map((question) => ({
      ...question,
      correctOptionIds: keys.quizByTopic[topic.id]?.find((key) => key.id === question.id)?.correctOptionIds ?? [],
    })),
  }));

  return {
    courseId,
    version: publicVersion.version,
    title: publicVersion.title,
    description: publicVersion.description ?? undefined,
    topics,
    finalExam: publicVersion.finalExam.map((question) => ({
      ...question,
      correctOptionIds: keys.finalExam.find((key) => key.id === question.id)?.correctOptionIds ?? [],
    })),
  };
}

export function listCourseSummaries(): CourseSummary[] {
  return [...demoState().courses.values()]
    .map((record) => record.summary)
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}

export function listVersionsOf(courseId: string): Array<CourseVersionSummary & { title: string }> {
  const record = demoState().courses.get(courseId);
  if (!record) return [];
  return [...record.versions.entries()]
    .map(([version, stored]) => ({
      version,
      status: stored.version.status,
      title: stored.version.title,
    }))
    .sort((a, b) => b.version - a.version);
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export class DemoCatalogStore implements CourseCatalogStore {
  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return demoState().courses.get(courseId)?.summary ?? null;
  }

  async listVersions(courseId: string): Promise<CourseVersionSummary[]> {
    return listVersionsOf(courseId).map(({ version, status }) => ({ version, status }));
  }

  async getVersion(courseId: string, version: number): Promise<CourseVersionDocument | null> {
    return demoState().courses.get(courseId)?.versions.get(version)?.version ?? null;
  }

  async getAnswerKeys(courseId: string, version: number): Promise<AnswerKeysDocument | null> {
    return demoState().courses.get(courseId)?.versions.get(version)?.keys ?? null;
  }

  async saveVersion(input: {
    course: CourseSummary;
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    const state = demoState();
    const record = state.courses.get(input.course.courseId) ?? {
      summary: { ...input.course, publishedVersion: null, lastDraftVersion: null },
      versions: new Map(),
    };

    if (record.versions.has(input.version.version)) {
      throw new DomainError(
        "VERSION_ALREADY_EXISTS",
        "Esa versión ya existe. Las versiones son inmutables: crea la siguiente.",
        409,
      );
    }

    record.summary = {
      ...record.summary,
      title: input.version.title,
      publishedVersion: record.summary.publishedVersion ?? null,
      lastDraftVersion: Math.max(record.summary.lastDraftVersion ?? 0, input.version.version),
    };
    record.versions.set(input.version.version, {
      version: input.version,
      keys: input.answerKeys,
    });
    state.courses.set(record.summary.courseId, record);
  }

  async replaceDraftVersion(input: {
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    const record = demoState().courses.get(input.version.courseId);
    const current = record?.versions.get(input.version.version);
    if (!record || !current) {
      throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
    }
    if (current.version.status !== "draft") {
      throw new DomainError(
        "VERSION_NOT_EDITABLE",
        "Una versión publicada no se puede editar: crea una versión nueva.",
        409,
      );
    }

    record.versions.set(input.version.version, {
      version: { ...input.version, createdAt: current.version.createdAt },
      keys: input.answerKeys,
    });
  }

  async publishVersion(input: {
    courseId: string;
    version: number;
    publishedAt: string;
    publishedBy: string;
  }): Promise<void> {
    const record = demoState().courses.get(input.courseId);
    const target = record?.versions.get(input.version);
    if (!record || !target) {
      throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
    }

    for (const [versionNumber, stored] of record.versions) {
      if (stored.version.status === "published") {
        record.versions.set(versionNumber, {
          ...stored,
          version: { ...stored.version, status: "archived" as CourseVersionStatus },
        });
      }
    }

    record.versions.set(input.version, {
      ...target,
      version: {
        ...target.version,
        status: "published",
        publishedAt: input.publishedAt,
        publishedBy: input.publishedBy,
      },
    });
    record.summary.publishedVersion = input.version;
    record.summary.title = target.version.title;
  }

  async listDocuments(courseId: string, version: number, topicId: string): Promise<PublicDocument[]> {
    const document = await this.getVersion(courseId, version);
    return document?.topics.find((topic) => topic.id === topicId)?.documents ?? [];
  }
}

// ---------------------------------------------------------------------------
// Editor de cursos (creación)
// ---------------------------------------------------------------------------

/**
 * Creación de cursos en memoria.
 *
 * Reproduce la invariante que importa del adaptador real: crear **no**
 * sobrescribe un curso existente y deja `publishedVersion` y
 * `lastDraftVersion` a null (curso sin versiones). No reproduce transacciones
 * de Firestore porque aquí no las hay: el estado es de un solo proceso.
 */
export class DemoCourseEditorStore implements CourseEditorStore {
  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return demoState().courses.get(courseId)?.summary ?? null;
  }

  async createCourse(
    summary: CourseSummary & { createdAt: string; createdBy: string },
  ): Promise<void> {
    const state = demoState();
    if (state.courses.has(summary.courseId)) {
      throw new DomainError(
        "COURSE_ALREADY_EXISTS",
        "Ya existe un curso con ese identificador. Elige otro.",
        409,
      );
    }

    state.courses.set(summary.courseId, {
      summary: {
        courseId: summary.courseId,
        title: summary.title,
        publishedVersion: null,
        lastDraftVersion: null,
      },
      versions: new Map(),
    });
  }
}

// ---------------------------------------------------------------------------
// Matrículas
// ---------------------------------------------------------------------------

export class DemoEnrollmentStore implements EnrollmentStore {
  async get(uid: string, courseId: string): Promise<Enrollment | null> {
    return demoState().enrollments.get(enrollmentKey(uid, courseId)) ?? null;
  }

  async upsert(enrollment: Enrollment): Promise<void> {
    demoState().enrollments.set(enrollmentKey(enrollment.uid, enrollment.courseId), {
      ...enrollment,
    });
  }

  async revoke(input: {
    uid: string;
    courseId: string;
    revokedAt: string;
    revokedBy: string;
  }): Promise<void> {
    const key = enrollmentKey(input.uid, input.courseId);
    const current = demoState().enrollments.get(key);
    if (!current) {
      throw new DomainError("ENROLLMENT_NOT_FOUND", "La matrícula no existe.", 404);
    }
    // Igual que Firestore: el contrato de `Enrollment` no guarda quién revocó;
    // se conserva la matrícula con estado `revoked` y la fecha de cambio.
    demoState().enrollments.set(key, {
      ...current,
      status: "revoked",
      updatedAt: input.revokedAt,
    });
  }

  async listByUser(uid: string): Promise<Enrollment[]> {
    return [...demoState().enrollments.values()].filter((item) => item.uid === uid);
  }

  async listByCourse(courseId: string): Promise<Enrollment[]> {
    return [...demoState().enrollments.values()].filter((item) => item.courseId === courseId);
  }
}

// ---------------------------------------------------------------------------
// Progreso e intentos
// ---------------------------------------------------------------------------

export class DemoLearningStore implements LearningStore {
  async getProgress(uid: string, courseId: string): Promise<StoredProgress | null> {
    return demoState().progress.get(progressKey(uid, courseId)) ?? null;
  }

  async commitAttempt(input: {
    attempt: AttemptRecord;
    progress: StoredProgress;
    archive: StoredProgress | null;
  }): Promise<void> {
    const state = demoState();
    state.attempts.push({ ...input.attempt });
    state.progress.set(progressKey(input.progress.uid, input.progress.courseId), {
      ...input.progress,
    });
  }

  async saveProgress(progress: StoredProgress, archive?: StoredProgress | null): Promise<void> {
    const state = demoState();
    // El histórico de versiones anteriores no se representa en la demostración:
    // solo se conserva el progreso vigente.
    void archive;
    state.progress.set(progressKey(progress.uid, progress.courseId), { ...progress });
  }

  async listProgressByCourse(
    courseId: string,
    version: number,
  ): Promise<Array<Pick<StoredProgress, "uid" | "completedAt" | "version">>> {
    return [...demoState().progress.values()]
      .filter((item) => item.courseId === courseId && item.version === version)
      .map(({ uid, completedAt, version: storedVersion }) => ({
        uid,
        completedAt,
        version: storedVersion,
      }));
  }

  async listProgressByUser(uid: string): Promise<StoredProgress[]> {
    return [...demoState().progress.values()].filter((item) => item.uid === uid);
  }

  async listAttemptsByUser(uid: string): Promise<AttemptRecord[]> {
    return demoState().attempts.filter((attempt) => attempt.uid === uid);
  }

  async listAttemptsByCourse(courseId: string, version: number): Promise<AttemptRecord[]> {
    return demoState().attempts.filter(
      (attempt) => attempt.courseId === courseId && attempt.version === version,
    );
  }
}
