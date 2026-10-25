import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  validateCourseVersion,
  type CourseVersionDefinition,
  type TopicDefinition,
} from "@/domain/courses/content";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { checkDraftQuizzes } from "@/domain/courses/quiz-draft";
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
import { normalizeScreens, type StudyScreen } from "@/domain/courses/screens";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  toAnswerKeys,
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
      ...(question.explanation ? { explanation: question.explanation } : {}),
    }));
  }
  return {
    courseId: keys.courseId,
    version,
    quizByTopic,
    finalExam: keys.finalExam.map((question) => ({
      id: question.id,
      correctOptionIds: [...question.correctOptionIds],
      ...(question.explanation ? { explanation: question.explanation } : {}),
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
      // `screens` solo existe si hay pantallas: un array vacío no es un tema
      // «con pantallas vacías», es un tema sin pantallas.
      ...(existing?.screens && existing.screens.length > 0 ? { screens: existing.screens } : {}),
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

  // Las claves se recalculan del contenido resultante: si un tema se ha
  // eliminado, sus preguntas (y su respuesta correcta) desaparecen con él. Se
  // escriben en la misma operación que la versión, así que la base nunca queda
  // con preguntas sin clave ni con claves de preguntas que ya no existen.
  const answerKeys = toAnswerKeys(merged, {
    createdAt: keys?.createdAt ?? current.createdAt,
  });

  // Dos documentos por versión (contenido y claves): ninguno puede acercarse al
  // 1 MiB por documento de Firestore. Se comprueban juntos por prudencia.
  const bytes = jsonByteLength(versionDoc) + jsonByteLength(answerKeys);
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
    answerKeys,
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
// Cuestionarios y examen final
// ---------------------------------------------------------------------------

export interface SaveAssessmentsResult {
  courseId: string;
  version: number;
  revision: number;
  /** Lo que falta para publicar; no bloquea el guardado. */
  warnings: DraftIssue[];
  quiz: { topics: number; questions: number; finalExam: number };
}

/** Limpia espacios y deja las etiquetas solo de las opciones que existen. */
function normalizeQuestion(question: QuizQuestionDefinition): QuizQuestionDefinition {
  const optionIds = [...question.optionIds];
  const labels = question.optionLabels ?? {};
  const optionLabels: Record<string, string> = {};
  for (const optionId of optionIds) {
    const label = labels[optionId]?.trim();
    if (label) optionLabels[optionId] = label;
  }

  const prompt = question.prompt?.trim();
  const explanation = question.explanation?.trim();

  return {
    id: question.id.trim(),
    type: question.type,
    optionIds,
    correctOptionIds: [...question.correctOptionIds],
    ...(prompt ? { prompt } : {}),
    ...(Object.keys(optionLabels).length > 0 ? { optionLabels } : {}),
    // La justificación viaja con la pregunta hasta las claves, donde se queda
    // (solo servidor): es lo que permite explicar el resultado al corregir.
    ...(explanation ? { explanation } : {}),
  };
}

/**
 * Guarda los cuestionarios de los temas y el examen final de un borrador.
 *
 * Tres decisiones que importan:
 *
 *   1. **Contenido y claves se escriben juntos** (`replaceDraftContent`).
 *      Si se escribieran por separado, entre una escritura y otra habría
 *      preguntas sin respuesta correcta, y un intento entregado en ese hueco
 *      sería incobrable.
 *   2. **Las claves se recalculan del contenido** (`toAnswerKeys`), no se
 *      mezclan: una pregunta eliminada no deja su respuesta correcta suelta.
 *   3. Solo admite borradores. La versión publicada y su documento de claves
 *      son inmutables (`VERSION_NOT_EDITABLE`); editarlas es crear la
 *      siguiente versión.
 *
 * Un cuestionario vacío es válido: se está escribiendo. Lo que falta se
 * devuelve como aviso y es la puerta de publicación (`validateCourseVersion`,
 * sin tocar) la que lo impide.
 */
export async function saveDraftAssessments(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    /** Preguntas por tema; los temas que no aparezcan no se tocan. */
    topicQuizzes?: Record<string, QuizQuestionDefinition[]>;
    /** Examen final completo; si falta, no se toca. */
    finalExam?: QuizQuestionDefinition[];
  },
  deps: DraftDependencies,
): Promise<SaveAssessmentsResult> {
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

  const storedKeys = await deps.store.getAnswerKeys(input.courseId, input.version);
  const definition = definitionFromDocuments(current, storedKeys);

  const unknownTopics = Object.keys(input.topicQuizzes ?? {}).filter(
    (topicId) => !definition.topics.some((topic) => topic.id === topicId),
  );
  if (unknownTopics.length > 0) {
    throw new DomainError(
      "TOPIC_NOT_FOUND",
      `No existe el tema «${unknownTopics[0]}» en esta versión. Recarga la página.`,
      404,
    );
  }

  const topics: TopicDefinition[] = definition.topics.map((topic) => {
    const edited = input.topicQuizzes?.[topic.id];
    return edited
      ? { ...topic, quiz: edited.map(normalizeQuestion) }
      : topic;
  });

  const merged: CourseVersionDefinition = {
    ...definition,
    topics,
    finalExam: (input.finalExam ?? definition.finalExam).map(normalizeQuestion),
  };

  // Solo los errores bloquean: una opción sin texto es un aviso (el alumnado
  // vería el identificador) y el contenido anterior al editor no tiene
  // etiquetas, así que no puede impedir guardar.
  const issues = [...checkDraftQuizzes(merged.topics, merged.finalExam), ...checkDraftStructure(merged)];
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw new DomainError(
      "COURSE_QUIZ_INVALID",
      blocking[0].message,
      400,
      { issues: blocking },
    );
  }

  const versionDoc = toPublicVersion(merged, {
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    status: "draft",
  });
  versionDoc.revision = input.expectedRevision + 1;

  const answerKeys = toAnswerKeys(merged, {
    // El documento de claves conserva su fecha original si ya existía.
    createdAt: storedKeys?.createdAt ?? current.createdAt,
  });

  const bytes = jsonByteLength(versionDoc) + jsonByteLength(answerKeys);
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
    answerKeys,
    expectedRevision: input.expectedRevision,
  });

  return {
    courseId: input.courseId,
    version: input.version,
    revision: versionDoc.revision,
    warnings: reviewDraft(merged, validateCourseVersion(merged)),
    quiz: {
      topics: merged.topics.filter((topic) => topic.quiz.length > 0).length,
      questions: merged.topics.reduce((sum, topic) => sum + topic.quiz.length, 0),
      finalExam: merged.finalExam.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Pantallas de estudio (contenido generado con IA o escrito a mano)
// ---------------------------------------------------------------------------

export interface SaveScreensResult {
  courseId: string;
  version: number;
  revision: number;
  /** Lo que falta para publicar; no bloquea el guardado. */
  warnings: DraftIssue[];
  screens: { topics: number; total: number };
}

/**
 * Guarda las pantallas de estudio de uno o varios temas de un borrador.
 *
 * Es el punto de escritura del contenido generado con IA, y por eso está aquí y
 * no en el servicio de IA: **lo que se guarda pasa por las mismas reglas que el
 * contenido escrito a mano**. El servicio de IA no escribe en la base; propone
 * pantallas y esta función las valida y las funde con el borrador.
 *
 * Qué toca y qué no:
 *   - sustituye **solo** las pantallas de los temas indicados;
 *   - conserva documentos, cuestionarios, examen final, título y descripción;
 *   - los temas que no se indican quedan exactamente igual (regenerar un tema
 *     no borra las correcciones hechas en los demás);
 *   - solo admite borradores: la versión publicada y el histórico no se tocan.
 *
 * La revisión esperada (`expectedRevision`) evita que dos pestañas se pisen: si
 * el borrador cambió desde que se abrió la página, se devuelve `DRAFT_STALE` y
 * no se escribe nada.
 */
export async function saveDraftScreens(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    /** Pantallas nuevas por tema. Los temas que no aparezcan no se tocan. */
    topicScreens: Record<string, StudyScreen[]>;
    /** Páginas conocidas del PDF de origen, para no aceptar citas imposibles. */
    pageCount?: number | null;
  },
  deps: DraftDependencies,
): Promise<SaveScreensResult> {
  assertAdmin(input.actor);

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

  const keys = await deps.store.getAnswerKeys(input.courseId, input.version);
  const definition = definitionFromDocuments(current, keys);

  const unknown = Object.keys(input.topicScreens).filter(
    (topicId) => !definition.topics.some((topic) => topic.id === topicId),
  );
  if (unknown.length > 0) {
    throw new DomainError(
      "TOPIC_NOT_FOUND",
      `No existe el tema «${unknown[0]}» en esta versión. Recarga la página.`,
      404,
    );
  }

  const topics: TopicDefinition[] = definition.topics.map((topic) => {
    const incoming = input.topicScreens[topic.id];
    if (!incoming) return topic;
    if (incoming.length === 0) {
      // Quitar todas las pantallas es una edición legítima: el tema se queda
      // con lo que tenga (documentos). Si no le queda nada, la validación de
      // estructura lo dirá (`TOPIC_WITHOUT_CONTENT`).
      return {
        id: topic.id,
        title: topic.title,
        order: topic.order,
        mandatory: topic.mandatory,
        documents: topic.documents,
        quiz: topic.quiz,
      };
    }
    return {
      ...topic,
      screens: normalizeScreens(incoming, { pageCount: input.pageCount ?? null }),
    };
  });

  const merged: CourseVersionDefinition = { ...definition, topics };

  const issues = checkDraftStructure(merged);
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw new DomainError("COURSE_SCREENS_INVALID", blocking[0].message, 400, {
      issues: blocking,
    });
  }

  const versionDoc = toPublicVersion(merged, {
    createdAt: current.createdAt,
    createdBy: current.createdBy,
    status: "draft",
  });
  versionDoc.revision = input.expectedRevision + 1;

  const answerKeys = toAnswerKeys(merged, {
    createdAt: keys?.createdAt ?? current.createdAt,
  });

  const bytes = jsonByteLength(versionDoc) + jsonByteLength(answerKeys);
  if (bytes > DRAFT_LIMITS.definitionBytes) {
    throw new DomainError(
      "DEFINITION_TOO_LARGE",
      `El borrador ocupa ${bytes} bytes y el máximo son ${DRAFT_LIMITS.definitionBytes}. Reduce las pantallas de algún tema o reparte el contenido en más temas.`,
      413,
      { bytes, maxBytes: DRAFT_LIMITS.definitionBytes },
    );
  }

  await deps.store.replaceDraftContent({
    versionDoc,
    answerKeys,
    expectedRevision: input.expectedRevision,
  });

  const withScreens = merged.topics.filter((topic) => (topic.screens?.length ?? 0) > 0);

  return {
    courseId: input.courseId,
    version: input.version,
    revision: versionDoc.revision,
    warnings: reviewDraft(merged, validateCourseVersion(merged)),
    screens: {
      topics: withScreens.length,
      total: withScreens.reduce((sum, topic) => sum + (topic.screens?.length ?? 0), 0),
    },
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
  /** Referencias de los PDF asociados al tema (título y páginas declaradas). */
  documentList: Array<{ id: string; title: string; pageCount: number }>;
  questions: number;
  /**
   * Preguntas con su clave, para el editor. Esta vista solo la usan las
   * pantallas de administración: el alumnado recibe `PublicQuestion`, sin
   * `correctOptionIds` (ver `toClientQuiz`).
   */
  quiz: QuizQuestionDefinition[];
  /** Pantallas de estudio del tema (contenido, sin respuestas). */
  screens: StudyScreen[];
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
  finalExam: QuizQuestionDefinition[];
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
        documentList: topic.documents.map((document) => ({
          id: document.id,
          title: document.title,
          pageCount: document.pageCount,
        })),
        screens: (topic.screens ?? []).map((screen) => ({
          id: screen.id,
          title: screen.title,
          paragraphs: [...screen.paragraphs],
          bullets: [...screen.bullets],
          pages: [...screen.pages],
        })),
        questions: topic.quiz.length,
        quiz: topic.quiz.map((question) => ({
          ...question,
          optionIds: [...question.optionIds],
          correctOptionIds: [...question.correctOptionIds],
        })),
      })),
    finalExam: definition.finalExam.map((question) => ({
      ...question,
      optionIds: [...question.optionIds],
      correctOptionIds: [...question.correctOptionIds],
    })),
    finalExamQuestions: definition.finalExam.length,
    createdAt: version.createdAt,
    errors: checkDraftStructure(definition),
    warnings: reviewDraft(definition, validateCourseVersion(definition)),
  };
}
