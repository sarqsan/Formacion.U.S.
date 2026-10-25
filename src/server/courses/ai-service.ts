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
import { generateJson, type GeminiDeps, type GeminiRequest } from "@/server/ai/gemini";

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
export async function proposeTopics(
  context: AiCourseContext,
  options: { existingIds?: readonly string[] } = {},
  deps: GeminiDeps = {},
): Promise<AiTopicPlan> {
  const request: GeminiRequest = {
    instruction: BASE_RULES,
    prompt: [
      courseLine(context),
      pageLine(context.pdf),
      "",
      "Tarea: divide el documento en temas de estudio.",
      `- Entre ${AI_LIMITS.minTopics} y ${AI_LIMITS.maxTopics} temas, en el orden en que aparecen en el documento.`,
      "- Cada tema debe existir de verdad en el documento: usa los títulos y secciones que aparecen.",
      "- Indica en «pages» las páginas del PDF en las que está ese tema. Si un tema ocupa un rango, incluye las páginas del rango.",
      "- «summary»: una o dos frases sobre lo que cubre el tema.",
      "- Si hay partes del documento que no encajan en ningún tema (índice, anexos, portada), no las conviertas en tema: menciónalas en «notes».",
      "- No repitas títulos ni inventes temas que el documento no tenga.",
    ].join("\n"),
    parts: [{ pdf: { bytes: context.pdf.bytes } }],
    schema: TOPICS_SCHEMA,
    temperature: 0.1,
    maxOutputTokens: 4096,
  };

  const result = await generateJson(request, deps);
  return parseTopicPlan(result.data, {
    pageCount: context.pdf.pageCount,
    existingIds: options.existingIds ?? [],
  });
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
    parts: [{ pdf: { bytes: pdf.bytes } }],
    schema: SCREENS_SCHEMA,
    temperature: 0.25,
    maxOutputTokens: 8192,
  };
}

export async function proposeScreens(
  input: TopicMaterialInput,
  pdf: PdfSource,
  deps: GeminiDeps & { requestedScreens?: number } = {},
): Promise<StudyScreen[]> {
  const result = await generateJson(screensRequest(input, pdf, deps.requestedScreens), deps);
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

export function quizRequest(input: QuizMaterialInput, pdf: PdfSource): GeminiRequest {
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
    parts: [{ pdf: { bytes: pdf.bytes } }],
    schema: QUIZ_SCHEMA,
    temperature: 0.3,
    maxOutputTokens: 8192,
  };
}

export async function proposeQuiz(
  input: QuizMaterialInput,
  pdf: PdfSource,
  deps: GeminiDeps = {},
): Promise<QuizQuestionDefinition[]> {
  const result = await generateJson(quizRequest(input, pdf), deps);
  return parseGeneratedQuiz(result.data, { questionCount: input.questionCount }).questions;
}

/** Texto plano de las pantallas, para el enunciado del examen final. */
export function screensDigest(screens: readonly StudyScreen[]): string {
  return screens.map((screen) => `· ${screen.title}: ${screen.paragraphs.join(" ")}`).join("\n");
}
