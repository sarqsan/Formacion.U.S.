import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import type { TopicDefinition } from "@/domain/courses/content";
import type { StudyScreen } from "@/domain/courses/screens";
import {
  proposeQuiz,
  proposeScreens,
  proposeTopics,
  screensDigest,
  type PdfSource,
} from "@/server/courses/ai-service";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  createCourse,
  saveDraftAssessments,
  saveDraftScreens,
  saveDraftStructure,
  startDraft,
  type CourseEditorDependencies,
  type DraftDependencies,
} from "@/server/courses/editor";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import { attachDocumentToDraft } from "@/server/documents/attach";
import { readDraftDocumentFile } from "@/server/documents/draft-file";
import { uploadPdfDocument, type UploadDependencies } from "@/server/documents/service";
import type { PdfDocumentStore } from "@/server/documents/store";
import type { GeminiDeps } from "@/server/ai/gemini";
import { assertPageCountDeclared, assertPdfHeader } from "@/domain/storage/pdf-upload";
import { MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";

/**
 * «CREAR CURSO CON IA»: EL RECORRIDO COMPLETO
 * ===========================================
 *
 * Encadena las piezas sin inventar un segundo editor: la IA **propone** y el
 * editor de siempre **guarda** (`saveDraftStructure`, `saveDraftScreens`,
 * `saveDraftAssessments`), que aplica las mismas reglas que al contenido escrito
 * a mano. Nada de este módulo publica: el ciclo de vida sigue siendo borrador →
 * revisión → validación → publicación manual.
 *
 * Lo que se guarda y lo que no:
 *
 *   · el PDF del temario se sube como documento normal (`uploadPdfDocument`) y
 *     se asocia a un tema propio («Temario», opcional) del borrador; es el
 *     mismo almacén fragmentado, con su SHA-256 y su presupuesto;
 *   · cada paso escribe **solo lo suyo**: proponer temas no toca pantallas ni
 *     cuestionarios ya escritos; generar pantallas de un tema no toca los demás
 *     temas ni el examen final; generar un cuestionario no toca otros temas;
 *   · si Gemini falla o devuelve algo inválido, **no se escribe nada**: el
 *     borrador queda como estaba y reintentar no duplica contenido (se
 *     reemplaza el destino, no se añade).
 *
 * Concurrencia: todas las escrituras llevan la revisión que tenía la pantalla
 * (`expectedRevision`); si otra pestaña guardó antes, la operación falla con
 * `DRAFT_STALE` en lugar de pisar las correcciones manuales.
 */

/** Tema que guarda el PDF de origen. Se marca opcional: no tiene cuestionario. */
export const SOURCE_TOPIC_ID = "temario";
export const SOURCE_TOPIC_TITLE = "Temario completo (PDF)";

export interface AiFlowDependencies {
  editor: CourseEditorDependencies;
  draft: DraftDependencies;
  upload: UploadDependencies;
  catalog: CourseCatalogStore;
  documents: PdfDocumentStore;
  gemini?: GeminiDeps;
  now?: () => Date;
}

export interface StartedAiCourse {
  courseId: string;
  version: number;
  revision: number;
  documentId: string;
  bytes: number;
  pageCount: number;
}

/**
 * Paso 1: ficha del curso + PDF del temario.
 *
 * Crea el curso, abre su primer borrador, deja un tema «Temario» (opcional) que
 * hospeda el PDF y sube el fichero con las comprobaciones de siempre (firma
 * `%PDF-`, 8 MiB, páginas coherentes, huella SHA-256, presupuesto).
 */
export async function startAiCourse(
  input: {
    actor: Actor;
    courseId: string;
    title: string;
    description?: string;
    pageCount: number;
    pdfBytes: Uint8Array;
  },
  deps: AiFlowDependencies,
): Promise<StartedAiCourse> {
  const admin = assertAdmin(input.actor);

  // El PDF se comprueba **antes** de crear nada: si el fichero no vale, no
  // queda un curso vacío a medias que alguien tenga que borrar a mano.
  assertPdfHeader(input.pdfBytes);
  if (input.pdfBytes.length > MAX_PDF_BYTES) {
    throw new DomainError(
      "PDF_TOO_LARGE",
      `El documento supera el máximo permitido (${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB).`,
      413,
    );
  }
  assertPageCountDeclared(input.pageCount, input.pdfBytes.length);

  const course = await createCourse(
    {
      actor: admin,
      courseId: input.courseId,
      title: input.title,
      description: input.description,
    },
    deps.editor,
  );

  const draft = await startDraft({ actor: admin, courseId: course.courseId }, deps.draft);

  // El tema del PDF se crea antes de subir: la subida exige un tema real de
  // esta versión, y así el documento nunca queda «suelto».
  const saved = await saveDraftStructure(
    {
      actor: admin,
      courseId: course.courseId,
      version: draft.version,
      expectedRevision: draft.revision,
      structure: {
        title: input.title,
        description: input.description,
        topics: [
          {
            id: SOURCE_TOPIC_ID,
            title: SOURCE_TOPIC_TITLE,
            order: 1,
            // Opcional a propósito: un tema sin cuestionario nunca se puede
            // superar, y siendo obligatorio bloquearía el examen final para
            // siempre.
            mandatory: false,
          },
        ],
      },
    },
    deps.draft,
  );

  const uploaded = await uploadPdfDocument(
    {
      actor: admin,
      courseId: course.courseId,
      version: draft.version,
      topicId: SOURCE_TOPIC_ID,
      title: input.title,
      pageCount: input.pageCount,
      bytes: input.pdfBytes,
    },
    deps.upload,
  );

  const attached = await attachDocumentToDraft(
    { actor: admin, documentId: uploaded.documentId, expectedRevision: saved.revision },
    { documents: deps.documents, catalog: deps.catalog, now: deps.now },
  );

  return {
    courseId: course.courseId,
    version: draft.version,
    revision: attached.revision,
    documentId: uploaded.documentId,
    bytes: uploaded.bytes,
    pageCount: input.pageCount,
  };
}

// ---------------------------------------------------------------------------
// Lectura del PDF del borrador
// ---------------------------------------------------------------------------

interface LoadedSource {
  pdf: PdfSource;
  documentId: string;
  /** Título del documento del PDF. */
  title: string;
  /** Título y descripción del curso tal y como están en el borrador. */
  courseTitle: string;
  courseDescription: string | null;
  revision: number;
  topics: TopicDefinition[];
}

/** Documentos del borrador, en orden de tema: el primero es el temario. */
async function loadDraft(input: {
  actor: Actor;
  courseId: string;
  version: number;
  deps: AiFlowDependencies;
}): Promise<LoadedSource> {
  const admin = assertAdmin(input.actor);

  const version = await input.deps.catalog.getVersion(input.courseId, input.version);
  if (!version) {
    throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
  }
  if (version.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Solo se genera contenido en un borrador. Una versión publicada es inmutable.",
      409,
    );
  }

  const keys = await input.deps.catalog.getAnswerKeys(input.courseId, input.version);
  const definition = definitionFromDocuments(version, keys);
  const topics = [...definition.topics].sort((a, b) => a.order - b.order);

  const topicsWithDocuments = topics.filter((topic) => topic.documents.length > 0);
  if (topicsWithDocuments.length === 0) {
    throw new DomainError(
      "SOURCE_PDF_MISSING",
      "Este borrador no tiene ningún PDF asociado. Sube el temario en el paso 1 (o desde el editor) para poder generar contenido.",
      409,
    );
  }

  const sourceTopic =
    topicsWithDocuments.find((topic) => topic.id === SOURCE_TOPIC_ID) ?? topicsWithDocuments[0];
  const sourceDocument = sourceTopic.documents[0];

  const file = await readDraftDocumentFile(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      documentId: sourceDocument.id,
    },
    { documents: input.deps.documents, catalog: input.deps.catalog },
  );

  return {
    pdf: { bytes: file.bytes, pageCount: file.pageCount || sourceDocument.pageCount || null },
    documentId: file.documentId,
    title: file.title,
    courseTitle: definition.title,
    courseDescription: definition.description ?? null,
    revision: version.revision ?? 0,
    topics,
  };
}

// ---------------------------------------------------------------------------
// Paso 2 · proponer temas
// ---------------------------------------------------------------------------

export interface TopicProposalResult {
  courseId: string;
  version: number;
  revision: number;
  topics: Array<{ id: string; title: string; pages: number[]; summary: string | null }>;
  notes: string | null;
  /** Aviso para la pantalla (por ejemplo, partes del PDF no asignadas). */
  warnings: string[];
}

/**
 * Propone el reparto en temas y lo **guarda como estructura del borrador**.
 *
 * Reemplaza los temas generados anteriormente, pero nunca el tema del PDF ni
 * los temas… que el administrador haya creado a mano después: para eso está el
 * editor. Es decir, esta operación es idempotente al reintentar: el mismo PDF
 * produce el mismo esqueleto, no una lista que dobla.
 */
export async function proposeDraftTopics(
  input: { actor: Actor; courseId: string; version: number; expectedRevision: number },
  deps: AiFlowDependencies,
): Promise<TopicProposalResult> {
  const admin = assertAdmin(input.actor);
  const loaded = await loadDraft({ actor: admin, courseId: input.courseId, version: input.version, deps });

  const plan = await proposeTopics(
    {
      title: loaded.courseTitle,
      description: loaded.courseDescription,
      pdf: loaded.pdf,
    },
    {
      existingIds: loaded.topics.map((topic) => topic.id).filter((id) => id === SOURCE_TOPIC_ID),
    },
    deps.gemini ?? {},
  );

  // El tema del PDF se conserva tal cual (con su documento).
  const sourceTopic = loaded.topics.find((topic) => topic.id === SOURCE_TOPIC_ID);

  const generated: TopicDefinition[] = plan.topics.map((topic, index) => ({
    id: topic.id,
    title: topic.title,
    order: (sourceTopic ? 1 : 0) + index + 1,
    mandatory: true,
    documents: [],
    quiz: [],
  }));

  const saved = await saveDraftStructure(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      expectedRevision: input.expectedRevision,
      structure: {
        title: loaded.courseTitle,
        description: loaded.courseDescription ?? undefined,
        topics: [
          ...(sourceTopic
            ? [{ id: sourceTopic.id, title: sourceTopic.title, order: 1, mandatory: false }]
            : []),
          ...generated.map((topic) => ({
            id: topic.id,
            title: topic.title,
            order: topic.order,
            mandatory: true,
          })),
        ],
      },
    },
    deps.draft,
  );

  const warnings: string[] = [];
  if (plan.notes) warnings.push(`Nota de la IA sobre el documento: ${plan.notes}`);

  return {
    courseId: input.courseId,
    version: input.version,
    revision: saved.revision,
    topics: plan.topics,
    notes: plan.notes,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Paso 3 · pantallas de estudio
// ---------------------------------------------------------------------------

export interface ScreensGenerationResult {
  courseId: string;
  version: number;
  revision: number;
  topicId: string;
  screens: StudyScreen[];
  total: number;
}

/**
 * Genera las pantallas de **un** tema y las guarda.
 *
 * Regenerar el mismo tema sustituye sus pantallas (no las duplica) y no toca
 * ningún otro tema ni los cuestionarios ya revisados.
 */
export async function generateTopicScreens(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    topicId: string;
    requestedScreens?: number;
  },
  deps: AiFlowDependencies,
): Promise<ScreensGenerationResult> {
  const admin = assertAdmin(input.actor);
  const loaded = await loadDraft({ actor: admin, courseId: input.courseId, version: input.version, deps });

  const topic = loaded.topics.find((item) => item.id === input.topicId);
  if (!topic) {
    throw new DomainError("TOPIC_NOT_FOUND", "El tema no existe en este borrador.", 404);
  }

  const screens = await proposeScreens(
    {
      courseTitle: loaded.courseTitle,
      topicTitle: topic.title,
      pages: [],
      summary: null,
    },
    loaded.pdf,
    { ...(deps.gemini ?? {}), requestedScreens: input.requestedScreens },
  );

  const saved = await saveDraftScreens(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      expectedRevision: input.expectedRevision,
      topicScreens: { [topic.id]: screens },
      pageCount: loaded.pdf.pageCount,
    },
    deps.draft,
  );

  return {
    courseId: input.courseId,
    version: input.version,
    revision: saved.revision,
    topicId: topic.id,
    screens,
    total: screens.length,
  };
}

// ---------------------------------------------------------------------------
// Paso 4 · cuestionarios y examen final
// ---------------------------------------------------------------------------

export interface QuizGenerationResult {
  courseId: string;
  version: number;
  revision: number;
  /** `null` = examen final. */
  topicId: string | null;
  questions: QuizQuestionDefinition[];
}

function ensureScreens(topic: TopicDefinition): StudyScreen[] {
  const screens = topic.screens ?? [];
  if (screens.length === 0) {
    throw new DomainError(
      "SCREENS_REQUIRED",
      `El tema «${topic.title}» todavía no tiene pantallas de estudio. Genera antes las pantallas: el cuestionario se apoya en ellas.`,
      409,
    );
  }
  return screens;
}

/** Genera el cuestionario de un tema a partir de sus pantallas y del PDF. */
export async function generateTopicQuiz(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    topicId: string;
    questionCount: number;
    allowMultiple: boolean;
  },
  deps: AiFlowDependencies,
): Promise<QuizGenerationResult> {
  const admin = assertAdmin(input.actor);
  const loaded = await loadDraft({ actor: admin, courseId: input.courseId, version: input.version, deps });

  const topic = loaded.topics.find((item) => item.id === input.topicId);
  if (!topic) {
    throw new DomainError("TOPIC_NOT_FOUND", "El tema no existe en este borrador.", 404);
  }

  const screens = ensureScreens(topic);
  const questions = await proposeQuiz(
    {
      subject: topic.title,
      questionCount: input.questionCount,
      allowMultiple: input.allowMultiple,
      material: screensDigest(screens),
      pages: [...new Set(screens.flatMap((screen) => screen.pages))],
    },
    loaded.pdf,
    deps.gemini ?? {},
  );

  const saved = await saveDraftAssessments(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      expectedRevision: input.expectedRevision,
      topicQuizzes: { [topic.id]: questions },
    },
    deps.draft,
  );

  return {
    courseId: input.courseId,
    version: input.version,
    revision: saved.revision,
    topicId: topic.id,
    questions,
  };
}

/**
 * Genera el examen final con el material de todos los temas.
 *
 * Si un tema no tiene pantallas, se queda fuera del enunciado (y se dice en la
 * pantalla) en vez de inventar contenido por su cuenta.
 */
export async function generateFinalExam(
  input: {
    actor: Actor;
    courseId: string;
    version: number;
    expectedRevision: number;
    questionCount: number;
    allowMultiple: boolean;
  },
  deps: AiFlowDependencies,
): Promise<QuizGenerationResult> {
  const admin = assertAdmin(input.actor);
  const loaded = await loadDraft({ actor: admin, courseId: input.courseId, version: input.version, deps });

  const topicsWithScreens = loaded.topics.filter((topic) => (topic.screens?.length ?? 0) > 0);
  if (topicsWithScreens.length === 0) {
    throw new DomainError(
      "SCREENS_REQUIRED",
      "Ningún tema tiene pantallas todavía. Genera el material de estudio antes del examen final.",
      409,
    );
  }

  const material = topicsWithScreens
    .map((topic) => `Tema «${topic.title}»\n${screensDigest(topic.screens ?? [])}`)
    .join("\n\n");

  const questions = await proposeQuiz(
    {
      subject: `${loaded.courseTitle} — examen final`,
      questionCount: input.questionCount,
      allowMultiple: input.allowMultiple,
      material,
      pages: [],
    },
    loaded.pdf,
    deps.gemini ?? {},
  );

  const saved = await saveDraftAssessments(
    {
      actor: admin,
      courseId: input.courseId,
      version: input.version,
      expectedRevision: input.expectedRevision,
      finalExam: questions,
    },
    deps.draft,
  );

  return {
    courseId: input.courseId,
    version: input.version,
    revision: saved.revision,
    topicId: null,
    questions,
  };
}
