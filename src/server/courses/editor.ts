import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  validateCourseVersion,
  type CourseVersionDefinition,
  type TopicDefinition,
} from "@/domain/courses/content";
import {
  EMPTY_COURSE_TEMPLATE,
  cloneVersionAsDraft,
  draftMetadata,
  emptyCourseDefinition,
  type CourseTemplateId,
} from "@/domain/courses/template";
import {
  DRAFT_LIMITS,
  checkDraftStructure,
  jsonByteLength,
  normalizeTopicOrder,
  reviewDraft,
  type DraftIssue,
} from "@/domain/courses/draft";
import type { CourseVersionStatus } from "@/domain/courses/versioning";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  toPublicVersion,
  type AnswerKeysDocument,
  type CourseCatalogStore,
  type CourseSummary,
  type CourseVersionDocument,
} from "@/server/courses/catalog";

/**
 * CICLO DE VIDA DEL BORRADOR
 * ==========================
 *
 * Este módulo separa cuatro cosas que es fácil confundir:
 *
 *   ficha del curso (`courses/{id}`)      título + punteros
 *   versión publicada                     inmutable, la que ve el alumnado
 *   último borrador (`lastDraftVersion`)  el que se está editando
 *   versiones históricas                  archivadas, intactas
 *
 * Reglas que se sostienen aquí y se prueban en `tests/server/draft-editor.test.ts`:
 *
 *   - un curso recién creado puede empezar su primer borrador (v1), vacío;
 *   - si ya hay un borrador, `startDraft` lo **devuelve**, no crea otro;
 *   - si hay una versión publicada, el borrador es una **clonación profunda**
 *     de ella: la publicada no se toca ni comparte referencias;
 *   - guardar solo valida la **estructura** (`checkDraftStructure`); un
 *     borrador vacío o incompleto se guarda, y lo que falta se muestra como
 *     aviso, no como error;
 *   - nada de este módulo publica.
 *
 * Concurrencia: la creación de la versión y el puntero de la ficha van en una
 * sola operación del almacén con comprobación de estado esperado, y cada
 * guardado exige la revisión que el editor tenía abierta. Dos pestañas o dos
 * administradores reciben `DRAFT_CONFLICT` / `DRAFT_STALE` en lugar de
 * pisarse en silencio.
 */

const MAX_START_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Creación de cursos (bloque 03)
// ---------------------------------------------------------------------------

/** Puerto de persistencia: solo lo que la creación necesita. */
export interface CourseEditorStore {
  /** Crea la ficha del curso. Si ya existe, falla con `COURSE_ALREADY_EXISTS`. */
  createCourse(summary: CourseSummary & { createdAt: string; createdBy: string }): Promise<void>;
  getCourse(courseId: string): Promise<CourseSummary | null>;
}

export interface CourseEditorDependencies {
  store: CourseEditorStore;
  now?: () => Date;
}

export interface CreateCourseInput {
  courseId: string;
  title: string;
  description?: string;
  /** Solo se admite la plantilla vacía; el tipo deja sitio a las siguientes. */
  template?: CourseTemplateId;
  actor: Actor;
}

export interface CreateCourseResult {
  courseId: string;
  title: string;
  publishedVersion: null;
  lastDraftVersion: null;
}

/**
 * Crea un curso vacío a partir de una plantilla.
 *
 * Solo administradores. El identificador se valida con la misma regla que usa
 * la validación de contenido (`isSlug`), para no poder crear un curso que
 * después ninguna versión podría guardar.
 *
 * Es **una sola escritura**: `create()` es atómica y no sobrescribe un curso
 * existente. No hay estado intermedio posible, así que una transacción no
 * aportaría nada. (La creación del primer borrador, que sí escribe dos
 * documentos, va aparte: ver `startDraft`.)
 */
export async function createCourse(
  input: CreateCourseInput,
  deps: CourseEditorDependencies,
): Promise<CreateCourseResult> {
  const admin = assertAdmin(input.actor);

  const template = input.template ?? EMPTY_COURSE_TEMPLATE;
  if (template !== EMPTY_COURSE_TEMPLATE) {
    throw new DomainError("COURSE_TEMPLATE_UNKNOWN", "Esa plantilla de curso no existe.", 400);
  }

  const definition = emptyCourseDefinition({
    courseId: input.courseId,
    title: input.title,
    description: input.description,
  });

  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();

  const summary: CourseSummary & { createdAt: string; createdBy: string } = {
    courseId: definition.courseId,
    title: definition.title,
    publishedVersion: null,
    lastDraftVersion: null,
    createdAt,
    createdBy: admin.uid,
  };

  await deps.store.createCourse(summary);

  return {
    courseId: summary.courseId,
    title: summary.title,
    publishedVersion: null,
    lastDraftVersion: null,
  };
}

// ---------------------------------------------------------------------------
// Borradores
// ---------------------------------------------------------------------------

export interface DraftDependencies {
  store: CourseCatalogStore;
  now?: () => Date;
}

export interface StartDraftResult {
  courseId: string;
  version: number;
  /** `false` cuando ya había un borrador y se reanuda. */
  created: boolean;
  revision: number;
  /** Versión publicada de la que se copió el contenido, si la había. */
  clonedFrom: number | null;
}

/** Copia profunda de las claves, apuntando a la versión nueva. */
function cloneAnswerKeys(
  keys: AnswerKeysDocument,
  version: number,
  createdAt: string,
): AnswerKeysDocument {
  const quizByTopic: AnswerKeysDocument["quizByTopic"] = {};
  for (const [topicId, questions] of Object.entries(keys.quizByTopic)) {
    quizByTopic[topicId] = questions.map((question) => ({
      id: question.id,
      correctOptionIds: [...question.correctOptionIds],
    }));
  }
  return {
    courseId: keys.courseId,
    version,
    quizByTopic,
    finalExam: keys.finalExam.map((question) => ({
      id: question.id,
      correctOptionIds: [...question.correctOptionIds],
    })),
    createdAt,
  };
}

function isDomainCode(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

/**
 * Abre el borrador de un curso: lo crea si no existe y lo devuelve si ya está.
 *
 * No publica nada, no exige contenido y no invalida la versión publicada: si
 * existe una publicada, el borrador es una copia profunda de ella (la
 * original sigue intacta y con su mismo `sha256` lógico de contenido).
 */
export async function startDraft(
  input: { actor: Actor; courseId: string },
  deps: DraftDependencies,
): Promise<StartDraftResult> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
    const course = await deps.store.getCourse(input.courseId);
    if (!course) {
      throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
    }

    // 1. Ya hay borrador: se reanuda tal cual. Nunca se crea otro encima.
    if (course.lastDraftVersion !== null) {
      const existing = await deps.store.getVersion(input.courseId, course.lastDraftVersion);
      if (existing?.status === "draft") {
        return {
          courseId: input.courseId,
          version: existing.version,
          created: false,
          revision: existing.revision ?? 0,
          clonedFrom: null,
        };
      }
    }

    const nextVersion =
      Math.max(course.publishedVersion ?? 0, course.lastDraftVersion ?? 0) + 1;

    // 2. Contenido de partida: la versión publicada (clonada) o nada.
    let definition: CourseVersionDefinition;
    let answerKeys: AnswerKeysDocument | null = null;
    let clonedFrom: number | null = null;

    if (course.publishedVersion !== null) {
      const source = await deps.store.getVersion(input.courseId, course.publishedVersion);
      if (!source || source.status !== "published") {
        throw new DomainError(
          "VERSION_STATE_INCONSISTENT",
          "El curso apunta a una versión publicada que no existe. No se ha creado el borrador.",
          500,
        );
      }

      const sourceKeys = await deps.store.getAnswerKeys(input.courseId, source.version);
      if (!sourceKeys) {
        // Sin claves no se puede reconstruir el cuestionario: clonar ahora
        // perdería las respuestas correctas en silencio.
        throw new DomainError(
          "ANSWER_KEYS_MISSING",
          "La versión publicada no tiene claves de corrección; no se puede preparar el borrador.",
          500,
        );
      }

      definition = cloneVersionAsDraft(definitionFromDocuments(source, sourceKeys), {
        version: nextVersion,
        title: source.title,
      });
      answerKeys = cloneAnswerKeys(sourceKeys, nextVersion, now.toISOString());
      clonedFrom = source.version;
    } else {
      definition = emptyCourseDefinition({
        courseId: input.courseId,
        title: course.title,
        version: nextVersion,
      });
    }

    const meta = draftMetadata(now, admin.uid);
    const versionDoc = toPublicVersion(definition, {
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      status: meta.status,
    });
    versionDoc.revision = 1;

    try {
      const { adopted } = await deps.store.createDraftVersion({
        courseId: input.courseId,
        versionDoc,
        answerKeys,
        expected: {
          publishedVersion: course.publishedVersion,
          lastDraftVersion: course.lastDraftVersion,
        },
      });

      if (!adopted) {
        return {
          courseId: input.courseId,
          version: nextVersion,
          created: true,
          revision: 1,
          clonedFrom,
        };
      }

      // Se adoptó un borrador que ya existía (datos anteriores al puntero).
      const existing = await deps.store.getVersion(input.courseId, nextVersion);
      return {
        courseId: input.courseId,
        version: nextVersion,
        created: false,
        revision: existing?.revision ?? 0,
        clonedFrom: null,
      };
    } catch (error) {
      if (isDomainCode(error, "DRAFT_CONFLICT") && attempt < MAX_START_ATTEMPTS) {
        // Otra operación tocó la ficha: se relee y se decide con el estado
        // nuevo (probablemente ya hay un borrador que reanudar).
        continue;
      }
      if (isDomainCode(error, "DRAFT_CONFLICT")) {
        throw new DomainError(
          "DRAFT_CONFLICT",
          "Otro administrador está preparando el borrador de este curso. Vuelve a abrir la página: no se ha creado nada.",
          409,
        );
      }
      if (isDomainCode(error, "VERSION_ALREADY_EXISTS")) {
        throw new DomainError(
          "VERSION_CONFLICT",
          `La versión ${nextVersion} ya existe y no es un borrador. Revisa el historial del curso antes de continuar.`,
          409,
        );
      }
      throw error;
    }
  }

  // Inalcanzable: el bucle o devuelve o lanza.
  throw new DomainError(
    "DRAFT_CONFLICT",
    "No se ha podido preparar el borrador por cambios concurrentes. Inténtalo de nuevo.",
    409,
  );
}

export interface TopicStructure {
  id: string;
  title: string;
  order: number;
  mandatory: boolean;
}

export interface DraftStructure {
  title: string;
  description?: string | null;
  /** Temas en el orden en que se quieren ver; los que no estén, se eliminan. */
  topics: TopicStructure[];
}

export interface SaveDraftResult {
  courseId: string;
  version: number;
  revision: number;
  /** Lo que falta para poder publicar, y avisos. No bloquea el guardado. */
  warnings: DraftIssue[];
}

/**
 * Guarda la estructura del borrador: título, descripción y temas.
 *
 * Qué hace con los temas:
 *   - los que llegan con un id existente conservan sus documentos y su
 *     cuestionario (este bloque no los edita);
 *   - los nuevos entran vacíos;
 *   - los que no llegan **se eliminan del borrador**. Es seguro porque solo se
 *     puede editar un borrador: la versión publicada y el histórico no se
 *     tocan (lo comprueban las pruebas).
 *
 * No genera claves de corrección: las del borrador se quedan como estaban.
 */
export async function saveDraftStructure(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    structure: DraftStructure;
  },
  deps: DraftDependencies,
): Promise<SaveDraftResult> {
  assertAdmin(input.actor);

  const course = await deps.store.getCourse(input.courseId);
  if (!course) {
    throw new DomainError("COURSE_NOT_FOUND", "El curso no existe.", 404);
  }

  const current = await deps.store.getVersion(input.courseId, input.version);
  if (!current) {
    throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
  }
  if (current.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Solo se puede editar un borrador. Una versión publicada o archivada no se modifica: prepara la siguiente.",
      409,
    );
  }

  // Un borrador sin claves (todavía sin cuestionarios) también se edita.
  const keys = await deps.store.getAnswerKeys(input.courseId, input.version);
  const definition = definitionFromDocuments(current, keys);

  const currentById = new Map(definition.topics.map((topic) => [topic.id, topic]));
  const topics: TopicDefinition[] = input.structure.topics.map((topic) => {
    const existing = currentById.get(topic.id);
    return {
      id: topic.id,
      title: topic.title,
      order: topic.order,
      mandatory: topic.mandatory,
      // Contenido que este editor no gestiona: se conserva si el tema ya existía.
      documents: existing?.documents ?? [],
      quiz: existing?.quiz ?? [],
    };
  });

  const description = input.structure.description?.trim();

  const merged: CourseVersionDefinition = {
    ...definition,
    title: input.structure.title,
    ...(description === undefined || description === null || description === ""
      ? { description: undefined }
      : { description }),
    topics: normalizeTopicOrder(topics),
    // El examen final no se edita en este bloque: se conserva tal cual.
    finalExam: definition.finalExam,
  };

  const errors = checkDraftStructure(merged);
  if (errors.length > 0) {
    throw new DomainError("COURSE_STRUCTURE_INVALID", errors[0].message, 400, { issues: errors });
  }

  const versionDoc = toPublicVersion(merged, {
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    status: "draft",
  });
  versionDoc.revision = input.expectedRevision + 1;

  // Dos documentos por versión (contenido y claves): ninguno puede acercarse al
  // 1 MiB por documento de Firestore. Se comprueban juntos por prudencia.
  const bytes = jsonByteLength(versionDoc) + (keys ? jsonByteLength(keys) : 0);
  if (bytes > DRAFT_LIMITS.definitionBytes) {
    throw new DomainError(
      "DEFINITION_TOO_LARGE",
      `El borrador ocupa ${bytes} bytes y el máximo son ${DRAFT_LIMITS.definitionBytes}. Divide el contenido en más temas o acorta los textos.`,
      413,
      { bytes, maxBytes: DRAFT_LIMITS.definitionBytes },
    );
  }

  await deps.store.replaceDraftContent({
    versionDoc,
    expectedRevision: input.expectedRevision,
  });

  return {
    courseId: input.courseId,
    version: input.version,
    revision: versionDoc.revision,
    warnings: reviewDraft(merged, validateCourseVersion(merged)),
  };
}

// ---------------------------------------------------------------------------
// Vista del editor
// ---------------------------------------------------------------------------

export interface DraftTopicView {
  id: string;
  title: string;
  order: number;
  mandatory: boolean;
  documents: number;
  questions: number;
}

export interface DraftEditorView {
  courseId: string;
  courseTitle: string;
  publishedVersion: number | null;
  lastDraftVersion: number | null;
  version: number;
  status: CourseVersionStatus;
  revision: number;
  title: string;
  description: string | null;
  topics: DraftTopicView[];
  finalExamQuestions: number;
  createdAt: string;
  errors: DraftIssue[];
  warnings: DraftIssue[];
}

/** Versión a mostrar en el editor: la pedida, el borrador, la publicada o la última. */
export function resolveEditorVersion(
  course: CourseSummary,
  available: readonly number[],
  requested?: number,
): number | null {
  if (requested !== undefined && available.includes(requested)) return requested;
  if (course.lastDraftVersion !== null && available.includes(course.lastDraftVersion)) {
    return course.lastDraftVersion;
  }
  if (course.publishedVersion !== null && available.includes(course.publishedVersion)) {
    return course.publishedVersion;
  }
  return available.length > 0 ? Math.max(...available) : null;
}

/**
 * Vista del editor, construida una sola vez y compartida por la demostración y
 * Firestore: las dos pintan exactamente lo mismo.
 */
export function draftEditorView(input: {
  course: CourseSummary;
  version: CourseVersionDocument;
  definition: CourseVersionDefinition;
}): DraftEditorView {
  const { course, version, definition } = input;
  return {
    courseId: course.courseId,
    courseTitle: course.title,
    publishedVersion: course.publishedVersion,
    lastDraftVersion: course.lastDraftVersion,
    version: version.version,
    status: version.status,
    revision: version.revision ?? 0,
    title: definition.title,
    description: definition.description ?? null,
    topics: [...definition.topics]
      .sort((a, b) => a.order - b.order)
      .map((topic) => ({
        id: topic.id,
        title: topic.title,
        order: topic.order,
        mandatory: topic.mandatory,
        documents: topic.documents.length,
        questions: topic.quiz.length,
      })),
    finalExamQuestions: definition.finalExam.length,
    createdAt: version.createdAt,
    errors: checkDraftStructure(definition),
    warnings: reviewDraft(definition, validateCourseVersion(definition)),
  };
}
