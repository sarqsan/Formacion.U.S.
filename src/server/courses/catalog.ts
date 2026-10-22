import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  assertValidCourseVersion,
  orderedTopics,
  type CourseVersionDefinition,
} from "@/domain/courses/content";
import {
  assertPublishable,
  type CourseVersionStatus,
  type CourseVersionSummary,
} from "@/domain/courses/versioning";
import { toClientQuiz, type QuestionType } from "@/domain/assessments/scoring";
import { isSafeDocumentId } from "@/domain/storage/document-id";
import { definitionFromDocuments } from "@/server/courses/definition";

/**
 * CATÁLOGO DE CURSOS (contenido publicado)
 * ========================================
 *
 * Aquí se decide QUÉ se guarda y DÓNDE. La separación es deliberada y es una
 * de las garantías de seguridad del sistema:
 *
 *   courses/{courseId}/versions/{n}   contenido PÚBLICO: sin respuestas
 *   answerKeys/{courseId}_v{n}_{id}   claves de corrección: solo servidor
 *
 * El documento de versión se construye SIEMPRE con `toPublicVersion`, que usa
 * `toClientQuiz` para eliminar `correctOptionIds`. Así no hay ninguna ruta de
 * código que pueda publicar las respuestas por descuido.
 */

export interface PublicQuestion {
  id: string;
  type: QuestionType;
  optionIds: string[];
  prompt?: string;
  /** Texto visible de cada opción; nunca indica cuál es la correcta. */
  optionLabels?: Record<string, string>;
}

/**
 * Documento tal y como lo ve el alumno.
 *
 * NO lleva ruta de Storage ni identificador de fragmento: el PDF no tiene
 * ubicación pública. El binario se pide al servidor por documento y ventana de
 * bytes (`/api/documents/{id}/window`), que comprueba sesión y publicación.
 */
export interface PublicDocument {
  id: string;
  title: string;
  pageCount: number;
}

export interface PublicTopic {
  id: string;
  title: string;
  order: number;
  mandatory: boolean;
  documents: PublicDocument[];
  quiz: PublicQuestion[];
}

export interface CourseVersionDocument {
  courseId: string;
  version: number;
  status: CourseVersionStatus;
  /**
   * Revisión del borrador (concurrencia optimista). Se incrementa en cada
   * guardado y el editor exige la que tenía al abrirlo: dos pestañas no pueden
   * pisarse en silencio. Las versiones publicadas no la usan.
   */
  revision?: number;
  title: string;
  description: string | null;
  topics: PublicTopic[];
  finalExam: PublicQuestion[];
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface AnswerKeyQuestion {
  id: string;
  correctOptionIds: string[];
}

export interface AnswerKeysDocument {
  courseId: string;
  version: number;
  quizByTopic: Record<string, AnswerKeyQuestion[]>;
  finalExam: AnswerKeyQuestion[];
  createdAt: string;
}

export interface CourseSummary {
  courseId: string;
  title: string;
  /** Versión visible para el alumnado; `null` mientras el curso no se publica. */
  publishedVersion: number | null;
  /**
   * Última versión guardada como borrador (aunque nunca se publique); `null`
   * en un curso recién creado, que por tanto no tiene ninguna versión.
   */
  lastDraftVersion: number | null;
}

/** Puerto de persistencia del catálogo (implementación Firestore aparte). */
export interface CourseCatalogStore {
  getCourse(courseId: string): Promise<CourseSummary | null>;
  listVersions(courseId: string): Promise<CourseVersionSummary[]>;
  getVersion(courseId: string, version: number): Promise<CourseVersionDocument | null>;
  getAnswerKeys(courseId: string, version: number): Promise<AnswerKeysDocument | null>;
  /**
   * Escribe versión en borrador y sus claves en una sola operación.
   *
   * `course` es la ficha que el llamador quiere persistir (título y última
   * versión de borrador). La implementación **nunca** cambia
   * `publishedVersion` aquí: publicar es otra operación, con su propio
   * invariante.
   */
  saveVersion(input: {
    course: CourseSummary;
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void>;
  /** Reemplaza el contenido de una versión que sigue en borrador. */
  replaceDraftVersion(input: {
    version: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
  }): Promise<void>;

  /**
   * Crea la versión de borrador y fija `lastDraftVersion` **en la misma
   * operación**, o falla si la ficha cambió desde que se leyó.
   *
   * Contrato que debe cumplir cualquier implementación:
   *   - si `publishedVersion` o `lastDraftVersion` ya no son los esperados →
   *     `DRAFT_CONFLICT` (otra operación creó un borrador o publicó), sin
   *     escribir nada;
   *   - si la versión ya existe y es un borrador → se **adopta** (solo se fija
   *     el puntero), sin tocar su contenido ni sus claves; devuelve
   *     `{ adopted: true }`;
   *   - si la versión ya existe y no es un borrador → `VERSION_ALREADY_EXISTS`;
   *   - nunca queda una versión sin que el curso apunte a ella, ni al revés.
   */
  createDraftVersion(input: {
    courseId: string;
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument | null;
    expected: { publishedVersion: number | null; lastDraftVersion: number | null };
  }): Promise<{ adopted: boolean }>;

  /**
   * Guarda el contenido del borrador **y sus claves de corrección** en una
   * sola operación.
   *
   * Siempre escribe los dos documentos, aunque solo cambien los títulos: es la
   * única forma de que las claves no se queden atrás. Si se editaran por
   * separado, habría un instante con preguntas cuya respuesta correcta no
   * existe (un intento entregado ahí sería incobrable) y, al eliminar un tema,
   * sus claves se quedarían huérfanas en la base.
   *
   *   - la versión debe existir, estar en borrador y tener la revisión
   *     esperada; si no, `VERSION_NOT_EDITABLE` o `DRAFT_STALE`, sin escribir;
   *   - la revisión guardada es `expectedRevision + 1`;
   *   - las claves se **sustituyen** por completo; el `createdAt` del documento
   *     de claves lo aporta el llamador para conservar el original.
   */
  replaceDraftContent(input: {
    versionDoc: CourseVersionDocument;
    answerKeys: AnswerKeysDocument;
    expectedRevision: number;
  }): Promise<void>;

  /** Transacción: la versión pasa a `published` y el curso apunta a ella. */
  publishVersion(input: {
    courseId: string;
    version: number;
    publishedAt: string;
    publishedBy: string;
  }): Promise<void>;
  listDocuments(courseId: string, version: number, topicId: string): Promise<PublicDocument[]>;
}

// ---------------------------------------------------------------------------
// Construcción de documentos
// ---------------------------------------------------------------------------

/**
 * Documento público de una versión: nunca contiene respuestas correctas.
 */
export function toPublicVersion(
  definition: CourseVersionDefinition,
  meta: { createdAt: string; createdBy: string; status: CourseVersionStatus },
): CourseVersionDocument {
  const topics: PublicTopic[] = orderedTopics(definition).map((topic) => ({
    id: topic.id,
    title: topic.title,
    order: topic.order,
    mandatory: topic.mandatory,
    documents: topic.documents.map((document) => ({
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
    })),
    quiz: toClientQuiz(topic.quiz) as PublicQuestion[],
  }));

  return {
    courseId: definition.courseId,
    version: definition.version,
    status: meta.status,
    title: definition.title.trim(),
    description: definition.description?.trim() ?? null,
    topics,
    finalExam: toClientQuiz(definition.finalExam) as PublicQuestion[],
    createdAt: meta.createdAt,
    createdBy: meta.createdBy,
    publishedAt: null,
    publishedBy: null,
  };
}

/** Claves de corrección: viven separadas del contenido público. */
export function toAnswerKeys(
  definition: CourseVersionDefinition,
  meta: { createdAt: string },
): AnswerKeysDocument {
  const quizByTopic: Record<string, AnswerKeyQuestion[]> = {};
  for (const topic of definition.topics) {
    quizByTopic[topic.id] = topic.quiz.map((question) => ({
      id: question.id,
      correctOptionIds: [...question.correctOptionIds],
    }));
  }

  return {
    courseId: definition.courseId,
    version: definition.version,
    quizByTopic,
    finalExam: definition.finalExam.map((question) => ({
      id: question.id,
      correctOptionIds: [...question.correctOptionIds],
    })),
    createdAt: meta.createdAt,
  };
}

/** Comprobación defensiva: el documento público no debe llevar la clave. */
export function assertNoAnswerLeak(version: CourseVersionDocument): void {
  const serialized = JSON.stringify(version);
  if (serialized.includes("correctOptionIds")) {
    throw new DomainError(
      "CONTENT_LEAK",
      "El contenido público contiene respuestas correctas. Escritura abortada.",
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Servicios
// ---------------------------------------------------------------------------

export interface CatalogDependencies {
  store: CourseCatalogStore;
  now?: () => Date;
}

export interface SaveVersionInput {
  definition: CourseVersionDefinition;
  actor: Actor;
}

/**
 * Guarda una versión en BORRADOR junto con sus claves.
 *
 * Solo administradores. Valida el contenido completo antes de escribir y
 * rechaza cualquier versión que no esté en borrador.
 */
export async function saveDraftVersion(
  input: SaveVersionInput,
  deps: CatalogDependencies,
): Promise<{ courseId: string; version: number }> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();

  assertValidCourseVersion(input.definition);

  const existingVersions = await deps.store.listVersions(input.definition.courseId);
  if (existingVersions.some((item) => item.version === input.definition.version)) {
    throw new DomainError(
      "VERSION_ALREADY_EXISTS",
      "Esa versión ya existe. Las versiones son inmutables: crea la siguiente.",
      409,
    );
  }

  const publicVersion = toPublicVersion(input.definition, {
    createdAt,
    createdBy: admin.uid,
    status: "draft",
  });
  assertNoAnswerLeak(publicVersion);

  const answerKeys = toAnswerKeys(input.definition, { createdAt });

  await deps.store.saveVersion({
    course: {
      courseId: input.definition.courseId,
      title: publicVersion.title,
      publishedVersion: null,
      lastDraftVersion: publicVersion.version,
    },
    version: publicVersion,
    answerKeys,
  });

  return { courseId: publicVersion.courseId, version: publicVersion.version };
}

/**
 * Edita una versión que sigue en BORRADOR.
 *
 * Solo administradores y solo mientras no se haya publicado: el contenido
 * publicado es inmutable (cambiarlo obliga a una versión nueva, que hace
 * repetir el curso). Las claves se reemplazan en la misma operación para que
 * nunca queden desalineadas del contenido.
 */
export async function updateDraftVersion(
  input: SaveVersionInput,
  deps: CatalogDependencies,
): Promise<{ courseId: string; version: number }> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();

  assertValidCourseVersion(input.definition);

  const versions = await deps.store.listVersions(input.definition.courseId);
  const existing = versions.find((item) => item.version === input.definition.version);
  if (!existing) {
    throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
  }
  if (existing.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Una versión publicada no se puede editar: crea una versión nueva.",
      409,
    );
  }

  const publicVersion = toPublicVersion(input.definition, {
    createdAt: now.toISOString(),
    createdBy: admin.uid,
    status: "draft",
  });
  assertNoAnswerLeak(publicVersion);

  await deps.store.replaceDraftVersion({
    version: publicVersion,
    answerKeys: toAnswerKeys(input.definition, { createdAt: now.toISOString() }),
  });

  return { courseId: publicVersion.courseId, version: publicVersion.version };
}

export interface PublishVersionInput {
  courseId: string;
  version: number;
  actor: Actor;
}

/**
 * Consulta mínima de documentos que necesita la publicación.
 *
 * Es un puerto estrecho a propósito: publicar no lee el PDF ni sus fragmentos,
 * solo necesita saber si el documento está **activo y completo**. Así el
 * catálogo no depende del almacén de ficheros más de lo imprescindible.
 */
export interface PublishDocumentLookup {
  getMeta(documentId: string): Promise<{
    courseId: string;
    state: string;
    partsReceived: number;
    chunkLengths: readonly number[];
  } | null>;
}

/**
 * Dependencias de la publicación: las del catálogo **más** la consulta de
 * documentos.
 *
 * Es un tipo distinto a propósito, para que el compilador impida publicar sin
 * comprobar los PDF: si el campo fuera opcional, una llamada podría omitirlo y
 * dejar publicado un curso cuyos documentos no se sirven.
 */
export interface PublishDependencies extends CatalogDependencies {
  documents: PublishDocumentLookup;
}

export type PublishDocumentProblem =
  | "id"
  | "missing"
  | "inactive"
  | "incomplete"
  | "course";

/**
 * ¿Se puede servir cada documento que la versión publica?
 *
 * Devuelve **todos** los problemas de una vez (la administración los ve juntos)
 * en lugar de fallar con el primero. No lee bytes: solo metadatos.
 *
 * Motivos posibles:
 *   - `id`: identificador con forma insegura (no puede acabar en una ruta);
 *   - `missing`: el documento no existe en el almacén;
 *   - `inactive`: está pendiente, cancelado o archivado;
 *   - `incomplete`: no tiene todas sus partes (nunca se verificó entero);
 *   - `course`: pertenece a otro curso.
 */
export async function checkPublishableDocuments(
  version: CourseVersionDocument,
  documents: PublishDocumentLookup,
): Promise<Array<{ documentId: string; problem: PublishDocumentProblem }>> {
  const problems: Array<{ documentId: string; problem: PublishDocumentProblem }> = [];
  const seen = new Set<string>();

  for (const topic of version.topics) {
    for (const document of topic.documents) {
      if (seen.has(document.id)) continue;
      seen.add(document.id);

      if (!isSafeDocumentId(document.id)) {
        problems.push({ documentId: document.id, problem: "id" });
        continue;
      }

      const meta = await documents.getMeta(document.id);
      if (!meta) {
        problems.push({ documentId: document.id, problem: "missing" });
        continue;
      }
      if (meta.state !== "active") {
        problems.push({ documentId: document.id, problem: "inactive" });
        continue;
      }
      if (meta.partsReceived !== meta.chunkLengths.length) {
        problems.push({ documentId: document.id, problem: "incomplete" });
        continue;
      }
      if (meta.courseId !== version.courseId) {
        problems.push({ documentId: document.id, problem: "course" });
      }
    }
  }

  return problems;
}

const DOCUMENT_PROBLEM_MESSAGE: Record<PublishDocumentProblem, string> = {
  id: "tiene un identificador que no es válido",
  missing: "no existe en el almacén",
  inactive: "no está activo (pendiente, cancelado o archivado)",
  incomplete: "está incompleto: no se verificó entero",
  course: "pertenece a otro curso",
};

/**
 * Publica un borrador: la ÚNICA puerta por la que el contenido llega al
 * alumnado.
 *
 * Antes solo comprobaba el orden de las versiones y que hubiera claves. El
 * bloqueo vivía en la interfaz (el botón «Publicar» se desactiva) y eso no es
 * una garantía: una acción de servidor se puede enviar sin pasar por el
 * navegador. Ahora el servidor repite la validación completa:
 *
 *   1. `assertPublishable`: solo la versión siguiente a la publicada, en
 *      borrador, sin saltos ni republicaciones;
 *   2. `assertNoAnswerLeak`: el contenido público no lleva respuestas;
 *   3. existen las claves de corrección;
 *   4. **`validateCourseVersion`**, aplicada a la definición reconstruida con
 *      contenido + claves: es la misma función que usa el editor, así que no
 *      hay dos reglas que puedan divergir;
 *   5. **cada documento está activo, completo y es de este curso**: publicar no
 *      puede dejar un curso cuyos PDF devuelvan 404 o un fichero a medias.
 *
 * Cualquier fallo ocurre **antes** de la escritura: la versión sigue en
 * borrador, el curso no cambia de versión publicada y no hay estado intermedio.
 */
export async function publishCourseVersion(
  input: PublishVersionInput,
  deps: PublishDependencies,
): Promise<{ courseId: string; version: number; publishedAt: string }> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();
  const publishedAt = now.toISOString();

  const versions = await deps.store.listVersions(input.courseId);
  assertPublishable(versions, input.version);

  const version = await deps.store.getVersion(input.courseId, input.version);
  if (!version) {
    throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
  }

  // Nunca publicar contenido con claves dentro.
  assertNoAnswerLeak(version);

  const keys = await deps.store.getAnswerKeys(input.courseId, input.version);
  if (!keys) {
    throw new DomainError(
      "ANSWER_KEYS_MISSING",
      "La versión no tiene claves de corrección; no se puede publicar.",
      409,
    );
  }

  // La puerta dura: el contenido guardado, reconstruido con sus claves, tiene
  // que pasar la misma validación que usa el editor.
  assertValidCourseVersion(definitionFromDocuments(version, keys));

  const problems = await checkPublishableDocuments(version, deps.documents);
  if (problems.length > 0) {
    const first = problems[0];
    throw new DomainError(
      "DOCUMENT_NOT_PUBLISHABLE",
      `No se puede publicar: el documento ${first.documentId} ${DOCUMENT_PROBLEM_MESSAGE[first.problem]}.`,
      409,
      { documents: problems },
    );
  }

  await deps.store.publishVersion({
    courseId: input.courseId,
    version: input.version,
    publishedAt,
    publishedBy: admin.uid,
  });

  return { courseId: input.courseId, version: input.version, publishedAt };
}

/** Temas obligatorios de una versión publicada (base del progreso). */
export function mandatoryTopicsOf(version: CourseVersionDocument): string[] {
  return version.topics
    .filter((topic) => topic.mandatory)
    .sort((a, b) => a.order - b.order)
    .map((topic) => topic.id);
}
