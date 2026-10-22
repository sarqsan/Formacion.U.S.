/**
 * DOBLES EN MEMORIA DE LOS ALMACENES
 * ==================================
 *
 * Implementan los mismos puertos que las versiones Firestore
 * (`CourseCatalogStore`, `LearningStore`) sin red. Permiten probar los
 * servicios —corrección en servidor, publicación de versiones, archivado— hoy,
 * mientras el emulador no se puede ejecutar por falta de JVM.
 *
 * No son mocks de conveniencia: reproducen las invariantes que importan
 * (versión inmutable, claves separadas, transacción de intento+progreso) para
 * que una prueba que pase aquí diga algo real sobre el comportamiento.
 */

import {
  toAnswerKeys,
  toPublicVersion,
  type AnswerKeysDocument,
  CourseCatalogStore,
  CourseSummary,
  type CourseVersionDocument,
  type PublicDocument,
} from "@/server/courses/catalog";
import type { CourseVersionSummary } from "@/domain/courses/versioning";
import type { AttemptRecord, LearningStore, StoredProgress } from "@/server/learning/store";
import type { Actor } from "@/domain/auth/authorization";
import { DomainError } from "@/domain/text";
import type { CourseEditorStore } from "@/server/courses/editor";
import type { CourseVersionDefinition, TopicDefinition } from "@/domain/courses/content";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";

export const ADMIN: Actor = { uid: "admin-uid-0001", role: "admin", status: "active" };
export const LEARNER: Actor = { uid: "learner-uid-0001", role: "learner", status: "active" };
export const PENDING: Actor = { uid: "pending-uid-0001", role: "learner", status: "pending_activation" };

export const FIXED_NOW = new Date("2026-03-01T10:00:00.000Z");

// ---------------------------------------------------------------------------
// Contenido de ejemplo
// ---------------------------------------------------------------------------

function question(
  id: string,
  correct: string,
  options = ["a", "b", "c"],
): QuizQuestionDefinition {
  return {
    id,
    type: "single_choice",
    optionIds: options,
    correctOptionIds: [correct],
    prompt: `Pregunta ${id}`,
    // Con texto en cada opción, como el contenido real: sin él, el editor
    // mostraría un aviso (la opción se vería como su identificador).
    optionLabels: Object.fromEntries(options.map((option) => [option, `Opción ${option}`])),
  };
}

export function makeTopic(overrides: Partial<TopicDefinition> & { id: string }): TopicDefinition {
  return {
    title: `Tema ${overrides.id}`,
    order: 1,
    mandatory: true,
    documents: [{ id: `doc-${overrides.id}`, title: `PDF ${overrides.id}`, pageCount: 3 }],
    quiz: [question(`q-${overrides.id}`, "a")],
    ...overrides,
  };
}

export function makeDefinition(
  overrides: Partial<CourseVersionDefinition> = {},
): CourseVersionDefinition {
  return {
    courseId: "curso-a",
    version: 1,
    title: "Curso A",
    description: "Descripción",
    topics: [makeTopic({ id: "tema-1", order: 1 })],
    finalExam: [question("q-final", "b")],
    ...overrides,
  };
}

/** Progreso con todos los documentos del tema leídos. */
export function fullyReadDocuments(topicId: string): StoredProgress["documents"] {
  return {
    [`doc-${topicId}`]: {
      documentId: `doc-${topicId}`,
      totalPages: 3,
      lastPageViewed: 3,
      completedAt: FIXED_NOW.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Catálogo en memoria
// ---------------------------------------------------------------------------

export class InMemoryCatalogStore implements CourseCatalogStore {
  courses = new Map<string, CourseSummary>();
  versions = new Map<string, CourseVersionDocument>();
  // Las claves pueden faltar: un borrador vacío todavía no tiene cuestionarios.
  keys = new Map<string, AnswerKeysDocument | null>();
  documents: PublicDocument[] = [];
  saveVersionCalls = 0;
  publishVersionCalls = 0;
  draftContentWrites = 0;

  private versionKey(courseId: string, version: number) {
    return `${courseId}@${version}`;
  }

  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return this.courses.get(courseId) ?? null;
  }

  async listVersions(courseId: string): Promise<CourseVersionSummary[]> {
    return [...this.versions.values()]
      .filter((version) => version.courseId === courseId)
      .map((version) => ({ version: version.version, status: version.status }));
  }

  async getVersion(courseId: string, version: number): Promise<CourseVersionDocument | null> {
    return this.versions.get(this.versionKey(courseId, version)) ?? null;
  }

  async getAnswerKeys(courseId: string, version: number): Promise<AnswerKeysDocument | null> {
    return this.keys.get(this.versionKey(courseId, version)) ?? null;
  }

  /**
   * Gancho de prueba: se ejecuta UNA vez justo antes de comprobar el estado de
   * la ficha al crear un borrador. Permite simular que otra operación escribió
   * entre la lectura y la escritura (carrera real en Firestore).
   */
  beforeCreateDraft?: () => void;

  async saveVersion(input: {
    course: CourseSummary;
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    this.saveVersionCalls += 1;
    const key = this.versionKey(input.version.courseId, input.version.version);
    if (this.versions.has(key)) throw new Error("VERSIÓN DUPLICADA: el doble debe rechazarla como Firestore");

    this.versions.set(key, structuredClone(input.version));
    this.keys.set(key, structuredClone(input.answerKeys));

    const existing = this.courses.get(input.course.courseId);
    this.courses.set(input.course.courseId, {
      ...input.course,
      publishedVersion: existing?.publishedVersion ?? null,
      title: existing?.title ?? input.course.title,
      lastDraftVersion: Math.max(
        existing?.lastDraftVersion ?? 0,
        input.course.lastDraftVersion ?? 0,
      ) || null,
    });
  }

  async replaceDraftVersion(input: {
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void> {
    const key = this.versionKey(input.version.courseId, input.version.version);
    const current = this.versions.get(key);
    if (!current) throw new Error("VERSIÓN INEXISTENTE");
    if (current.status !== "draft") throw new Error("VERSIÓN NO EDITABLE");

    this.versions.set(key, { ...structuredClone(input.version), createdAt: current.createdAt });
    this.keys.set(key, structuredClone(input.answerKeys));
  }

  async publishVersion(input: {
    courseId: string;
    version: number;
    publishedAt: string;
    publishedBy: string;
  }): Promise<void> {
    this.publishVersionCalls += 1;
    const key = this.versionKey(input.courseId, input.version);
    const version = this.versions.get(key);
    if (!version) throw new Error("VERSIÓN INEXISTENTE");

    // Igual que la transacción real: las anteriores pasan a `archived`.
    for (const [otherKey, other] of this.versions) {
      if (other.courseId === input.courseId && other.status === "published") {
        this.versions.set(otherKey, { ...other, status: "archived" });
      }
    }

    this.versions.set(key, {
      ...version,
      status: "published",
      publishedAt: input.publishedAt,
      publishedBy: input.publishedBy,
    });

    const course = this.courses.get(input.courseId);
    if (!course) throw new Error("CURSO INEXISTENTE");
    // Publicar consume el borrador: el puntero vuelve a null.
    this.courses.set(input.courseId, {
      ...course,
      publishedVersion: input.version,
      lastDraftVersion: null,
    });
  }

  async createDraftVersion(input: {
    courseId: string;
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument | null;
    expected: { publishedVersion: number | null; lastDraftVersion: number | null };
  }): Promise<{ adopted: boolean }> {
    if (this.beforeCreateDraft) {
      const hook = this.beforeCreateDraft;
      this.beforeCreateDraft = undefined;
      hook();
    }

    const course = this.courses.get(input.courseId);
    if (!course) throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);

    if (
      course.publishedVersion !== input.expected.publishedVersion ||
      course.lastDraftVersion !== input.expected.lastDraftVersion
    ) {
      throw new DomainError("DRAFT_CONFLICT", "El curso cambió mientras se preparaba el borrador.", 409);
    }

    const key = this.versionKey(input.courseId, input.versionDoc.version);
    const existing = this.versions.get(key);
    if (existing) {
      if (existing.status !== "draft") {
        throw new DomainError(
          "VERSION_ALREADY_EXISTS",
          "Esa versión ya existe y no es un borrador.",
          409,
        );
      }
      this.courses.set(input.courseId, {
        ...course,
        lastDraftVersion: input.versionDoc.version,
      });
      return { adopted: true };
    }

    this.versions.set(key, {
      ...structuredClone(input.versionDoc),
      revision: input.versionDoc.revision ?? 1,
    });
    this.keys.set(key, input.answerKeys ? structuredClone(input.answerKeys) : null);
    this.courses.set(input.courseId, {
      ...course,
      lastDraftVersion: input.versionDoc.version,
    });
    return { adopted: false };
  }

  /**
   * Guarda contenido y claves del borrador en una sola operación, como la
   * transacción real: si la revisión no coincide, no se escribe nada. Las
   * claves se sustituyen enteras (no quedan restos de temas o preguntas
   * eliminados).
   */
  async replaceDraftContent(input: {
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
    expectedRevision: number;
  }): Promise<void> {
    const key = this.versionKey(input.versionDoc.courseId, input.versionDoc.version);
    const current = this.versions.get(key);
    if (!current) throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
    if (current.status !== "draft") {
      throw new DomainError(
        "VERSION_NOT_EDITABLE",
        "Solo se puede editar un borrador.",
        409,
      );
    }

    const revision = current.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new DomainError(
        "DRAFT_STALE",
        "El borrador se ha modificado desde que abriste el editor.",
        409,
      );
    }

    this.versions.set(key, {
      ...structuredClone(input.versionDoc),
      revision: revision + 1,
      createdAt: current.createdAt,
      createdBy: current.createdBy,
      publishedAt: null,
      publishedBy: null,
    });
    this.keys.set(key, structuredClone(input.answerKeys));
    this.draftContentWrites += 1;
  }

  async listDocuments(): Promise<PublicDocument[]> {
    // El contenido público no incluye rutas: el binario se pide al endpoint
    // de ventanas, que comprueba sesión y publicación.
    return this.documents;
  }

  /** Atajo de prueba: deja un curso con una versión publicada y sus claves. */
  seedPublished(definition = makeDefinition()): CourseVersionDefinition {
    const now = FIXED_NOW.toISOString();
    const key = this.versionKey(definition.courseId, definition.version);
    this.courses.set(definition.courseId, {
      courseId: definition.courseId,
      title: definition.title,
      publishedVersion: definition.version,
      // Publicar no deja borrador: el puntero apunta solo a versiones editables.
      lastDraftVersion: null,
    });
    this.versions.set(
      key,
      toPublicVersion(definition, { createdAt: now, createdBy: ADMIN.uid, status: "published" }),
    );
    this.keys.set(key, toAnswerKeys(definition, { createdAt: now }));
    return definition;
  }
}

// ---------------------------------------------------------------------------
// Creación de cursos en memoria
// ---------------------------------------------------------------------------

/**
 * Doble del puerto de creación.
 *
 * Reproduce las dos invariantes que importan: el curso nace con los dos
 * punteros a null y **crear no sobrescribe** un curso existente (lanza
 * `COURSE_ALREADY_EXISTS`, igual que `create()` en Firestore).
 */
export class InMemoryCourseEditorStore implements CourseEditorStore {
  courses = new Map<string, CourseSummary>();
  createCalls = 0;
  /** Metadatos de autoría de cada alta, para poder comprobarlos. */
  created: Array<{ courseId: string; createdAt: string; createdBy: string }> = [];

  async getCourse(courseId: string): Promise<CourseSummary | null> {
    return this.courses.get(courseId) ?? null;
  }

  async createCourse(
    summary: CourseSummary & { createdAt: string; createdBy: string },
  ): Promise<void> {
    this.createCalls += 1;
    if (this.courses.has(summary.courseId)) {
      throw new DomainError(
        "COURSE_ALREADY_EXISTS",
        "Ya existe un curso con ese identificador. Elige otro.",
        409,
      );
    }
    this.created.push({
      courseId: summary.courseId,
      createdAt: summary.createdAt,
      createdBy: summary.createdBy,
    });
    this.courses.set(summary.courseId, {
      courseId: summary.courseId,
      title: summary.title,
      publishedVersion: null,
      lastDraftVersion: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Aprendizaje en memoria
// ---------------------------------------------------------------------------

export class InMemoryLearningStore implements LearningStore {
  progress = new Map<string, StoredProgress>();
  archive = new Map<string, StoredProgress>();
  attempts: AttemptRecord[] = [];
  commits = 0;

  private progressKey(uid: string, courseId: string) {
    return `${uid}@${courseId}`;
  }

  async getProgress(uid: string, courseId: string): Promise<StoredProgress | null> {
    const found = this.progress.get(this.progressKey(uid, courseId));
    return found ? structuredClone(found) : null;
  }

  async commitAttempt(input: {
    attempt: AttemptRecord;
    progress: StoredProgress;
    archive: StoredProgress | null;
  }): Promise<void> {
    this.commits += 1;
    if (input.archive) {
      this.archive.set(
        `${input.archive.uid}@${input.archive.courseId}@v${input.archive.version}`,
        structuredClone(input.archive),
      );
    }
    this.attempts.push(structuredClone(input.attempt));
    this.progress.set(
      this.progressKey(input.progress.uid, input.progress.courseId),
      structuredClone(input.progress),
    );
  }

  async saveProgress(
    progress: StoredProgress,
    archive: StoredProgress | null = null,
  ): Promise<void> {
    if (archive) {
      this.archive.set(
        `${archive.uid}@${archive.courseId}@v${archive.version}`,
        structuredClone(archive),
      );
    }
    this.progress.set(this.progressKey(progress.uid, progress.courseId), structuredClone(progress));
  }

  async listProgressByCourse(courseId: string, version: number) {
    return [...this.progress.values()]
      .filter((entry) => entry.courseId === courseId && entry.version === version)
      .map((entry) => ({ uid: entry.uid, completedAt: entry.completedAt, version: entry.version }));
  }

  async listProgressByUser(uid: string): Promise<StoredProgress[]> {
    return [...this.progress.values()].filter((entry) => entry.uid === uid);
  }

  async listAttemptsByUser(uid: string): Promise<AttemptRecord[]> {
    return this.attempts.filter((attempt) => attempt.uid === uid);
  }

  async listAttemptsByCourse(courseId: string, version: number): Promise<AttemptRecord[]> {
    return this.attempts.filter(
      (attempt) => attempt.courseId === courseId && attempt.version === version,
    );
  }

  seedProgress(progress: StoredProgress): void {
    this.progress.set(this.progressKey(progress.uid, progress.courseId), structuredClone(progress));
  }
}
