import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import {
  AI_LIMITS,
  QUIZ_SCHEMA,
  SCREENS_SCHEMA,
  TOPICS_SCHEMA,
  parseGeneratedQuiz,
  parseScreens,
  parseTopicPlan,
  type AiTopicPlan,
} from "@/domain/courses/ai-plan";
import type { StudyScreen } from "@/domain/courses/screens";
import { DomainError } from "@/domain/text";
import type { GeminiPart, GeminiRequest } from "@/server/ai/gemini";
import { createPacer } from "@/server/ai/pacing";
import {
  activeProvider,
  generateJson,
  type AiDeps,
} from "@/server/ai/provider";
import { groqSettings } from "@/server/ai/config";
import {
  approximateTokens,
  chunkPages,
  renderPages,
  selectPages,
  type PdfTextPage,
} from "@/server/ai/text";

/**
 * GENERACIÓN DE CONTENIDO CON GEMINI
 * =================================
 *
 * Tres tareas, tres funciones, ningún efecto secundario: reciben el PDF del
 * temario (los bytes ya verificados) y devuelven contenido **validado** por el
 * dominio. No escriben en la base de datos; de eso se encarga el editor
 * (`saveDraftStructure`, `saveDraftScreens`, `saveDraftAssessments`), que aplica
 * las mismas reglas que al contenido escrito a mano.
 *
 * Las reglas del encargo están en el texto que se envía al modelo, no en la
 * confianza: localizar cada tema en el documento, no inventar, no rellenar
 * lagunas, citar páginas. Y, cuando no puede cumplirlo, devolver menos —lo que
 * luego se ve como aviso en la revisión— en lugar de contenido inventado.
 */

export interface PdfSource {
  bytes: Uint8Array;
  /** Páginas declaradas del documento; `null` si no se conocen. */
  pageCount: number | null;
  /**
   * Texto del PDF por páginas, ya extraído.
   *
   * Solo se rellena cuando el proveedor activo **no** sabe leer un PDF (Groq):
   * Gemini recibe los bytes y hace su propia lectura. Si falta con Groq, el
   * flujo falla con un mensaje claro en vez de enviar un documento que el otro
   * extremo no entiende.
   */
  textPages?: readonly PdfTextPage[];
}

/**
 * Los `parts` que se envían al modelo, según quién responda.
 *
 *   · Gemini: el PDF entero, tal cual (lo lee él).
 *   · Groq: el **texto** de las páginas que hagan falta a esta tarea, con su
 *     número delante. Mandar solo las páginas del tema no es un ahorro menor:
 *     gasta menos cuota y centra la respuesta.
 */
function sourceParts(
  pdf: PdfSource,
  pages: readonly number[] | null,
  deps: AiDeps,
): GeminiPart[] {
  if (activeProvider(deps.env ?? process.env) === "gemini") {
    return [{ pdf: { bytes: pdf.bytes } }];
  }

  const textPages = pdf.textPages;
  if (!textPages || textPages.length === 0) {
    throw new DomainError(
      "AI_TEXT_NOT_EXTRACTED",
      "No hay texto extraído del PDF y el proveedor configurado no puede leer el documento directamente. Vuelve a intentarlo; si se repite, avisa a quien mantiene la aplicación.",
      500,
    );
  }

  const selected = pages && pages.length > 0 ? selectPages(textPages, pages) : textPages;
  if (selected.every((page) => page.text === "")) {
    throw new DomainError(
      "PDF_WITHOUT_TEXT",
      "Las páginas de este tema no tienen texto (puede que sean imágenes o un escaneo). El proveedor de IA configurado solo lee texto.",
      422,
    );
  }

  return [{ text: renderPages(selected) }];
}

export interface AiCourseContext {
  title: string;
  description: string | null;
  pdf: PdfSource;
}

const BASE_RULES = [
  "Eres un asistente que prepara material de formación interna a partir del documento que se adjunta.",
  "Trabajas SIEMPRE sobre el contenido real del PDF adjunto: no inventes datos, no completes lagunas con conocimiento general y no supongas nada que el documento no diga.",
  "Escribe en español de España, con tono neutro y profesional, en segunda persona del plural o impersonal.",
  "No incluyas datos personales, nombres de alumnado, correos ni teléfonos.",
  "No copies párrafos literales largos: explica con tus palabras lo que el documento dice.",
  "Si el documento no contiene lo que se te pide, devuelve menos elementos (o una lista vacía en los campos opcionales) y dilo en el campo de notas cuando exista.",
  "Las páginas se cuentan desde 1 y se refieren al PDF adjunto.",
].join(" ");

function courseLine(context: AiCourseContext): string {
  const description = context.description ? ` Descripción dada por administración: ${context.description}` : "";
  return `Curso: «${context.title}».${description}`;
}

function pageLine(pdf: PdfSource): string {
  return pdf.pageCount ? `El PDF adjunto tiene ${pdf.pageCount} páginas.` : "El PDF adjunto tiene un número de páginas desconocido.";
}

// ---------------------------------------------------------------------------
// Paso 2 · temas localizados en el PDF
// ---------------------------------------------------------------------------

/**
 * Propone el reparto del PDF en temas.
 *
 * `existingIds` evita que la propuesta reutilice un identificador ya usado en
 * el curso (por ejemplo, el tema que guarda el propio PDF).
 */
export function topicsPrompt(context: AiCourseContext, range?: { from: number; to: number }): string {
  return [
    courseLine(context),
    pageLine(context.pdf),
    range
      ? `Estas páginas son SOLO el tramo ${range.from}–${range.to} del documento: propone únicamente los temas que aparecen en este tramo.`
      : "",
    "",
    "Tarea: divide el documento en temas de estudio.",
    `- Entre ${AI_LIMITS.minTopics} y ${range ? 5 : AI_LIMITS.maxTopics} temas, en el orden en que aparecen en el documento.`,
    "- Cada tema debe existir de verdad en el documento: usa los títulos y secciones que aparecen.",
    "- Indica en «pages» las páginas del PDF en las que está ese tema. Si un tema ocupa un rango, incluye las páginas del rango.",
    "- «summary»: una o dos frases sobre lo que cubre el tema.",
    "- Si hay partes del documento que no encajan en ningún tema (índice, anexos, portada), no las conviertas en tema: menciónalas en «notes».",
    "- No repitas títulos ni inventes temas que el documento no tenga.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

interface RawTopic {
  title: string;
  pages: number[];
  summary: string | null;
}

/** Lee los temas de una respuesta sin fiarse: lo inválido se descarta aquí. */
function readTopics(data: unknown): RawTopic[] {
  const root = (data ?? {}) as { topics?: unknown };
  if (!Array.isArray(root.topics)) return [];
  const out: RawTopic[] = [];
  for (const item of root.topics) {
    if (!item || typeof item !== "object") continue;
    const record = item as { title?: unknown; pages?: unknown; summary?: unknown };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title === "") continue;
    const pages = Array.isArray(record.pages)
      ? record.pages.filter((page): page is number => typeof page === "number" && Number.isFinite(page))
      : [];
    out.push({
      title,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      summary: typeof record.summary === "string" ? record.summary : null,
    });
  }
  return out;
}

function topicKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^[0-9]+[.)]\s*/, "")
    .replace(/[^a-z0-9áéíóúñü ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Une los temas de varios tramos.
 *
 * El mismo tema puede aparecer en dos tandas si ocupa el final de una y el
 * principio de la siguiente: se queda uno, con las páginas sumadas. El orden es
 * el del documento (primera página citada), no el de llegada.
 */
function mergeTopics(all: readonly RawTopic[]): RawTopic[] {
  const byTitle = new Map<string, RawTopic>();
  for (const topic of all) {
    const key = topicKey(topic.title);
    const existing = byTitle.get(key);
    if (existing) {
      existing.pages = [...new Set([...existing.pages, ...topic.pages])].sort((a, b) => a - b);
      existing.summary = existing.summary ?? topic.summary;
    } else {
      byTitle.set(key, { ...topic, pages: [...topic.pages] });
    }
  }
  return [...byTitle.values()].sort((a, b) => (a.pages[0] ?? 99_999) - (b.pages[0] ?? 99_999));
}

/**
 * Reparto en temas cuando hay que mandar **texto troceado** (Groq).
 *
 * Cada tramo se pregunta por separado y se unen al final. No se puede mandar el
 * documento entero porque el tramo gratuito limita los tokens por minuto; el
 * espaciado lo lleva `pacer`, que espera lo justo entre llamada y llamada.
 */
async function proposeTopicsChunked(
  context: AiCourseContext,
  deps: AiDeps,
): Promise<{ topics: RawTopic[]; notes?: string }> {
  const textPages = context.pdf.textPages;
  if (!textPages || textPages.length === 0) {
    throw new DomainError(
      "AI_TEXT_NOT_EXTRACTED",
      "No hay texto extraído del PDF y el proveedor configurado no puede leer el documento. Vuelve a intentarlo.",
      500,
    );
  }

  const env = deps.env ?? process.env;
  const tokensPerMinute = (deps.groqSettings ?? groqSettings(env)).tokensPerMinute;

  /*
   * Presupuesto de una tanda.
   *
   * La lista de temas de un temario real ocupa bastante menos de lo que se
   * reservaba antes (2 048 tokens de salida y 900 de margen por tanda): eso
   * inflaba la estimación, y con ella el tiempo calculado, hasta rechazar
   * documentos de 30 páginas que sí cabían. Ahora se reserva lo que de verdad
   * ocupa un JSON de temas (1 024) y un margen más ajustado (400), y se usa el
   * 95 % del minuto en lugar del 85 %.
   */
  const outputBudget = 1_024;
  const overhead = 400;
  const inputBudget = Math.max(600, Math.floor(tokensPerMinute * 0.95) - outputBudget - overhead);
  const chunks = chunkPages(textPages, inputBudget * 4);

  /*
   * Tope de tiempo. Una función de Vercel corta a los 300 s, así que se deja un
   * margen de 40 s para la subida, la extracción del texto y la escritura del
   * borrador. Si el cálculo se pasa, es mejor decirlo antes de empezar que
   * dejar al administrador mirando una pantalla que se cae.
   */
  const totalTokens = chunks.reduce(
    (total, chunk) => total + approximateTokens(renderPages(chunk)) + outputBudget + overhead,
    0,
  );
  const estimatedSeconds = (totalTokens / tokensPerMinute) * 60;
  const BUDGET_SECONDS = 260;
  if (estimatedSeconds > BUDGET_SECONDS) {
    const minutes = Math.max(1, Math.round(estimatedSeconds / 60));
    throw new DomainError(
      "AI_DOCUMENT_TOO_LONG",
      `Este temario no cabe en una sola pasada con el plan gratuito del proveedor actual: calcula unos ${minutes} minutos solo para proponer los temas, y la plataforma corta a los 5. Divide el PDF en dos o tres partes (por bloques de temas) y genera cada parte como un curso; o cambia a un plan con más cuota (GROQ_TPM) si no quieres partirlo.`,
      413,
    );
  }

  const pacer = createPacer({
    tokensPerMinute,
    ...(deps.nowMs ? { now: deps.nowMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const collected: RawTopic[] = [];
  const notes: string[] = [];

  for (const chunk of chunks) {
    const from = chunk[0].page;
    const to = chunk[chunk.length - 1].page;
    const prompt = topicsPrompt(
      context,
      chunks.length > 1 ? { from, to } : undefined,
    );
    const text = renderPages(chunk);

    const estimate =
      approximateTokens(prompt) + approximateTokens(BASE_RULES) + approximateTokens(text) + outputBudget;

    await pacer.wait(estimate);

    const result = await generateJson(
      {
        instruction: BASE_RULES,
        prompt,
        parts: [{ text }],
        schema: TOPICS_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: outputBudget,
      },
      deps,
    );

    const used = (result.usage.promptTokens ?? 0) + (result.usage.outputTokens ?? 0);
    pacer.record(used > 0 ? used : estimate);

    collected.push(...readTopics(result.data));
    const data = result.data as { notes?: unknown };
    if (typeof data.notes === "string" && data.notes.trim() !== "") notes.push(data.notes.trim());
  }

  const merged = mergeTopics(collected);
  if (merged.length === 0) {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      "La IA no ha encontrado ningún tema en el documento. Comprueba que el PDF tiene texto seleccionable y vuelve a intentarlo.",
      422,
    );
  }
  if (merged.length > AI_LIMITS.maxTopics) {
    throw new DomainError(
      "AI_INVALID_OUTPUT",
      `La IA ha propuesto ${merged.length} temas y el máximo son ${AI_LIMITS.maxTopics}. Divide el temario en documentos más pequeños o agrupa temas a mano en el editor.`,
      422,
    );
  }

  return {
    topics: merged,
    ...(notes.length > 0 ? { notes: notes.join(" ").slice(0, AI_LIMITS.summaryChars) } : {}),
  };
}

export async function proposeTopics(
  context: AiCourseContext,
  options: { existingIds?: readonly string[] } = {},
  deps: AiDeps = {},
): Promise<AiTopicPlan> {
  const parseOptions = {
    pageCount: context.pdf.pageCount,
    existingIds: options.existingIds ?? [],
  };

  if (activeProvider(deps.env ?? process.env) === "groq") {
    const plan = await proposeTopicsChunked(context, deps);
    return parseTopicPlan(plan, parseOptions);
  }

  const request: GeminiRequest = {
    instruction: BASE_RULES,
    prompt: topicsPrompt(context),
    parts: sourceParts(context.pdf, null, deps),
    schema: TOPICS_SCHEMA,
    temperature: 0.1,
    maxOutputTokens: 4096,
  };

  const result = await generateJson(request, deps);
  return parseTopicPlan(result.data, parseOptions);
}

// ---------------------------------------------------------------------------
// Paso 3 · pantallas de estudio de un tema
// ---------------------------------------------------------------------------

export interface TopicMaterialInput {
  courseTitle: string;
  topicTitle: string;
  /** Páginas del PDF que cubre el tema (vacío si no se conocen). */
  pages: readonly number[];
  /** Resumen del tema, si lo hay. */
  summary?: string | null;
}

export function screensRequest(
  input: TopicMaterialInput,
  pdf: PdfSource,
  requested?: number,
  deps: AiDeps = {},
): GeminiRequest {
  const focus =
    input.pages.length > 0
      ? `Céntrate en las páginas ${input.pages.join(", ")} del PDF: es ahí donde está este tema.`
      : "Localiza en el PDF el contenido de este tema por su título.";

  const count = requested && requested > 0 ? `Divide el tema en unas ${requested} pantallas. ` : "";

  return {
    instruction: BASE_RULES,
    prompt: [
      `Curso: «${input.courseTitle}». Tema: «${input.topicTitle}».`,
      input.summary ? `Resumen del tema: ${input.summary}` : "",
      pageLine(pdf),
      focus,
      "",
      "Tarea: escribe el material de estudio de este tema como una secuencia de pantallas.",
      `${count}Reglas:`,
      "- Cada pantalla cubre una idea y se entiende sola, sin depender de la anterior.",
      "- «paragraphs»: 2 a 6 párrafos de explicación, cada uno de una idea, sin repetir el título.",
      "- «bullets»: conceptos clave, pasos o ejemplos concretos del documento (0 a 8). Si no aportan, deja la lista vacía.",
      "- «pages»: las páginas del PDF en las que se apoya la pantalla. Obligatorio si lo has sacado de una página concreta.",
      "- No inventes cifras, plazos, artículos ni procedimientos que no estén en el documento.",
      "- Nada de preguntas de examen dentro de las pantallas: eso es otra tarea.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    parts: sourceParts(pdf, input.pages, deps),
    schema: SCREENS_SCHEMA,
    temperature: 0.25,
    maxOutputTokens: 8192,
  };
}

export async function proposeScreens(
  input: TopicMaterialInput,
  pdf: PdfSource,
  deps: AiDeps & { requestedScreens?: number } = {},
): Promise<StudyScreen[]> {
  const result = await generateJson(
    screensRequest(input, pdf, deps.requestedScreens, deps),
    deps,
  );
  return parseScreens(result.data, { pageCount: pdf.pageCount });
}

// ---------------------------------------------------------------------------
// Paso 4 · cuestionarios y examen final
// ---------------------------------------------------------------------------

export interface QuizMaterialInput {
  /** Qué se evalúa: un tema o el curso completo. */
  subject: string;
  questionCount: number;
  /** `true` si se permiten preguntas de respuesta múltiple. */
  allowMultiple: boolean;
  /** Pantallas del tema (o un resumen de todos los temas, en el examen final). */
  material: string;
  /** Páginas concretas del tema, si se conocen. */
  pages?: readonly number[];
}

export function quizRequest(
  input: QuizMaterialInput,
  pdf: PdfSource,
  deps: AiDeps = {},
): GeminiRequest {
  const count = Math.min(Math.max(Math.round(input.questionCount), 1), AI_LIMITS.maxQuestions);
  const typeRule = input.allowMultiple
    ? "Mezcla preguntas de respuesta única («single_choice», exactamente una correcta) y de respuesta múltiple («multi_choice», dos o más correctas) cuando tenga sentido."
    : "Usa solo preguntas de respuesta única («single_choice», exactamente una correcta).";

  return {
    instruction: BASE_RULES,
    prompt: [
      `Curso: «${input.subject}».`,
      pageLine(pdf),
      input.pages && input.pages.length > 0 ? `Páginas del documento que cubre: ${input.pages.join(", ")}.` : "",
      "",
      "Material de estudio ya preparado:",
      input.material,
      "",
      "Tarea: escribe exactamente " + count + " preguntas de examen sobre este material.",
      "Reglas:",
      "- Cada pregunta se responde solo con lo que dice el documento: nada de conocimiento externo ni de interpretaciones.",
      "- Enunciado claro y sin ambigüedad, de una sola idea, sin negaciones dobles ni «todas las anteriores».",
      "- Entre 3 y 5 opciones por pregunta, todas plausibles y del mismo estilo; las incorrectas no deben ser absurdas.",
      "- " + typeRule,
      "- «explanation»: por qué la opción correcta lo es, citando la idea del documento. Máximo 600 caracteres.",
      "- No repitas preguntas ni opciones dentro del mismo cuestionario, ni preguntes lo mismo con otras palabras.",
      "- No numeres las opciones en el texto: la numeración la pone la aplicación.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    // Examen final: el material ya va en el enunciado, así que con texto no
    // hace falta repetir el documento entero (y en el tramo gratuito no cabría).
    parts:
      activeProvider(deps.env ?? process.env) === "groq" && (!input.pages || input.pages.length === 0)
        ? []
        : sourceParts(pdf, input.pages ?? null, deps),
    schema: QUIZ_SCHEMA,
    temperature: 0.3,
    maxOutputTokens: 8192,
  };
}

export async function proposeQuiz(
  input: QuizMaterialInput,
  pdf: PdfSource,
  deps: AiDeps = {},
): Promise<QuizQuestionDefinition[]> {
  const result = await generateJson(quizRequest(input, pdf, deps), deps);
  return parseGeneratedQuiz(result.data, { questionCount: input.questionCount }).questions;
}

/** Texto plano de las pantallas, para el enunciado del examen final. */
export function screensDigest(screens: readonly StudyScreen[]): string {
  return screens.map((screen) => `· ${screen.title}: ${screen.paragraphs.join(" ")}`).join("\n");
}
