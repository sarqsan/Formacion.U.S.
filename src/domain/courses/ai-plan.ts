import { DomainError } from "@/domain/text";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { QUIZ_DRAFT_LIMITS, checkDraftQuizzes } from "@/domain/courses/quiz-draft";
import { SCREEN_LIMITS, normalizeScreens, type StudyScreen } from "@/domain/courses/screens";
import type { GeminiSchema } from "@/server/ai/gemini";

/**
 * DEL TEXTO DEL MODELO AL CONTENIDO DEL CURSO
 * ===========================================
 *
 * Gemini no escribe en la base de datos: propone JSON y **aquí** se comprueba
 * que tenga la forma del contenido real del curso. Es la frontera que impide
 * que una respuesta plausible pero inválida (una pregunta sin respuesta
 * correcta, una pantalla de 9.000 caracteres, una cita a la página 400 de un
 * PDF de 12) llegue al borrador.
 *
 * Tres reglas, en este orden:
 *
 *   1. la forma (tipos, campos obligatorios) → `AI_INVALID_OUTPUT`;
 *   2. los límites del contenido (los mismos que al escribir a mano);
 *   3. la coherencia con el PDF (páginas que existen).
 *
 * Este módulo es puro: no llama a la red ni toca el almacén, así que se prueba
 * con JSON escrito a mano.
 */

export const AI_LIMITS = {
  maxTopics: 30,
  minTopics: 1,
  titleChars: 120,
  summaryChars: 800,
  minQuestions: 3,
  maxQuestions: 25,
} as const;

// ---------------------------------------------------------------------------
// Utilidades de lectura
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("AI_INVALID_OUTPUT", message, 502, details);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`La respuesta de la IA no trae «${field}» como objeto.`);
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(`La respuesta de la IA no trae «${field}» como lista.`);
  return value;
}

function asText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw invalid(`Falta el texto de «${field}».`);
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean === "") throw invalid(`El campo «${field}» viene vacío.`);
  if (clean.length > max) {
    throw invalid(`El campo «${field}» pasa de ${max} caracteres (${clean.length}).`);
  }
  return clean;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function asPageList(value: unknown, field: string, pageCount: number | null): number[] {
  if (value === undefined || value === null) return [];
  const list = asArray(value, field);
  const pages: number[] = [];
  for (const item of list) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1) {
      throw invalid(`«${field}» debe contener números de página enteros y positivos.`);
    }
    if (pageCount !== null && item > pageCount) {
      throw invalid(
        `«${field}» cita la página ${item}, pero el PDF solo tiene ${pageCount}.`,
      );
    }
    if (!pages.includes(item)) pages.push(item);
  }
  return pages.sort((a, b) => a - b);
}

/** Identificador estable a partir del título; sin acentos ni símbolos. */
export function slugFromTitle(title: string, fallback: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base === "" ? fallback : base;
}

// ---------------------------------------------------------------------------
// Paso 2: temas propuestos a partir del PDF
// ---------------------------------------------------------------------------

export interface AiTopicProposal {
  /** Identificador propuesto (`tema-1`, `tema-2`…), único dentro del curso. */
  id: string;
  title: string;
  summary: string | null;
  /** Páginas del PDF en las que se apoya el tema. */
  pages: number[];
}

export interface AiTopicPlan {
  topics: AiTopicProposal[];
  /** Nota del modelo sobre partes del PDF que no ha podido situar. */
  notes: string | null;
}

export const TOPICS_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    topics: {
      type: "ARRAY",
      description: "Temas del curso, en el orden del documento.",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Título breve del tema, tomado del documento." },
          summary: { type: "STRING", description: "Una o dos frases sobre lo que cubre el tema." },
          pages: {
            type: "ARRAY",
            description: "Páginas del PDF donde está el contenido de este tema (1-based).",
            items: { type: "INTEGER" },
          },
        },
        required: ["title", "pages"],
      },
    },
    notes: {
      type: "STRING",
      description:
        "Si hay secciones del documento que no has podido asignar a ningún tema, dilo aquí. Cadena vacía si no hay nada.",
    },
  },
  required: ["topics"],
};

/**
 * Valida la propuesta de temas.
 *
 * `existingIds` son los identificadores ya usados en el curso (por ejemplo el
 * del tema donde vive el PDF): la propuesta nunca los reutiliza, para no
 * pisar contenido.
 */
export function parseTopicPlan(
  data: unknown,
  options: { pageCount?: number | null; existingIds?: readonly string[] } = {},
): AiTopicPlan {
  const root = asRecord(data, "topics");
  const rawTopics = asArray(root.topics, "topics");

  if (rawTopics.length < AI_LIMITS.minTopics) {
    throw invalid(
      "La IA no ha encontrado ningún tema en el PDF. Comprueba que el documento tiene texto seleccionable (no es un escaneo) y vuelve a intentarlo.",
    );
  }
  if (rawTopics.length > AI_LIMITS.maxTopics) {
    throw invalid(
      `La IA ha propuesto ${rawTopics.length} temas y el máximo son ${AI_LIMITS.maxTopics}. Divide el temario o agrupa temas a mano.`,
    );
  }

  const used = new Set<string>(options.existingIds ?? []);
  const topics: AiTopicProposal[] = rawTopics.map((item, index) => {
    const record = asRecord(item, `topics[${index}]`);
    const title = asText(record.title, `topics[${index}].title`, AI_LIMITS.titleChars);
    const pages = asPageList(record.pages, `topics[${index}].pages`, options.pageCount ?? null);

    const base = slugFromTitle(title, `tema-${index + 1}`);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);

    return { id, title, summary: optionalText(record.summary, AI_LIMITS.summaryChars), pages };
  });

  const seen = new Set<string>();
  for (const topic of topics) {
    const key = topic.title.toLowerCase();
    if (seen.has(key)) {
      throw invalid(`La IA ha propuesto el tema «${topic.title}» dos veces. Revisa el PDF.`);
    }
    seen.add(key);
  }

  return { topics, notes: optionalText(root.notes, AI_LIMITS.summaryChars) };
}

// ---------------------------------------------------------------------------
// Paso 3: pantallas de estudio de un tema
// ---------------------------------------------------------------------------

export const SCREENS_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    screens: {
      type: "ARRAY",
      description: "Pantallas del tema, en orden de estudio.",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Título corto de la pantalla." },
          paragraphs: {
            type: "ARRAY",
            description: "Explicación, un párrafo por elemento (2 a 6).",
            items: { type: "STRING" },
          },
          bullets: {
            type: "ARRAY",
            description:
              "Conceptos clave, pasos o ejemplos, uno por elemento. Lista vacía si no aporta.",
            items: { type: "STRING" },
          },
          pages: {
            type: "ARRAY",
            description: "Páginas del PDF en las que se apoya esta pantalla.",
            items: { type: "INTEGER" },
          },
        },
        required: ["title", "paragraphs", "pages"],
      },
    },
  },
  required: ["screens"],
};

/**
 * Valida y normaliza las pantallas.
 *
 * Los identificadores los pone el servidor (`pantalla-1`…), no el modelo: son
 * parte del progreso del alumnado y no pueden cambiar porque el modelo decida
 * llamarlas de otra forma en la siguiente generación.
 */
export function parseScreens(
  data: unknown,
  options: { pageCount?: number | null } = {},
): StudyScreen[] {
  const root = asRecord(data, "screens");
  const rawScreens = asArray(root.screens, "screens");

  if (rawScreens.length === 0) {
    throw invalid(
      "La IA no ha devuelto ninguna pantalla para este tema. Vuelve a intentarlo o escríbelas a mano.",
    );
  }
  if (rawScreens.length > SCREEN_LIMITS.maxPerTopic) {
    throw invalid(
      `La IA ha devuelto ${rawScreens.length} pantallas y el máximo por tema son ${SCREEN_LIMITS.maxPerTopic}.`,
    );
  }

  const candidate = rawScreens.map((item, index) => {
    const record = asRecord(item, `screens[${index}]`);
    return {
      id: `pantalla-${index + 1}`,
      title: asText(record.title, `screens[${index}].title`, SCREEN_LIMITS.maxTitleChars),
      paragraphs: asArray(record.paragraphs ?? [], `screens[${index}].paragraphs`),
      bullets: record.bullets === undefined || record.bullets === null ? [] : asArray(record.bullets, `screens[${index}].bullets`),
      pages: asPageList(record.pages, `screens[${index}].pages`, options.pageCount ?? null),
    };
  });

  try {
    // La misma normalización que usa el editor y el guardado del borrador: los
    // topes de longitud y las páginas se comprueban una sola vez, en un sitio.
    return normalizeScreens(candidate, { pageCount: options.pageCount ?? null });
  } catch (error) {
    const message = error instanceof DomainError ? error.message : "pantallas inválidas";
    throw invalid(`La IA ha devuelto pantallas que no se pueden usar: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Paso 4: cuestionarios
// ---------------------------------------------------------------------------

export const QUIZ_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          prompt: { type: "STRING", description: "Enunciado de la pregunta." },
          type: {
            type: "STRING",
            enum: ["single_choice", "multi_choice"],
            description: "Respuesta única o múltiple.",
          },
          options: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                text: { type: "STRING" },
                correct: { type: "BOOLEAN" },
              },
              required: ["text", "correct"],
            },
          },
          explanation: {
            type: "STRING",
            description: "Por qué esa respuesta es la correcta, según el documento.",
          },
        },
        required: ["prompt", "type", "options", "explanation"],
      },
    },
  },
  required: ["questions"],
};

export interface GeneratedQuiz {
  questions: QuizQuestionDefinition[];
}

const OPTION_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * Valida un cuestionario generado.
 *
 * Comprobaciones que evitan los problemas que se ven en clase: enunciado
 * repetido, opción repetida, ninguna correcta, más de una en pregunta de
 * respuesta única y tipo múltiple con una sola correcta. Además pasa el
 * cuestionario por `checkDraftQuizzes`, que es la puerta que ya usa el editor.
 */
export function parseGeneratedQuiz(
  data: unknown,
  options: { questionCount: number },
): GeneratedQuiz {
  const root = asRecord(data, "questions");
  const rawQuestions = asArray(root.questions, "questions");

  if (rawQuestions.length === 0) {
    throw invalid(
      "La IA no ha devuelto preguntas. Revisa que el tema tenga pantallas o contenido suficiente y vuelve a intentarlo.",
    );
  }
  if (rawQuestions.length > Math.min(options.questionCount, AI_LIMITS.maxQuestions)) {
    throw invalid(
      `La IA ha devuelto ${rawQuestions.length} preguntas y se pidieron ${options.questionCount}. Reinténtalo.`,
    );
  }

  const usedIds = new Set<string>();
  const usedPrompts = new Set<string>();

  const questions: QuizQuestionDefinition[] = rawQuestions.map((item, index) => {
    const record = asRecord(item, `questions[${index}]`);
    const prompt = asText(record.prompt, `questions[${index}].prompt`, QUIZ_DRAFT_LIMITS.prompt);
    const key = prompt.toLowerCase();
    if (usedPrompts.has(key)) {
      throw invalid(`La IA ha repetido el enunciado «${prompt}». Vuelve a generar el cuestionario.`);
    }
    usedPrompts.add(key);

    const type = record.type === "multi_choice" ? "multi_choice" : "single_choice";
    const rawOptions = asArray(record.options, `questions[${index}].options`);

    if (rawOptions.length < QUIZ_DRAFT_LIMITS.minOptions) {
      throw invalid(`La pregunta «${prompt}» trae menos de ${QUIZ_DRAFT_LIMITS.minOptions} opciones.`);
    }
    if (rawOptions.length > QUIZ_DRAFT_LIMITS.maxOptions) {
      throw invalid(`La pregunta «${prompt}» trae más de ${QUIZ_DRAFT_LIMITS.maxOptions} opciones.`);
    }

    const optionIds: string[] = [];
    const optionLabels: Record<string, string> = {};
    const correctOptionIds: string[] = [];
    const seenLabels = new Set<string>();

    rawOptions.forEach((rawOption, optionIndex) => {
      const option = asRecord(rawOption, `questions[${index}].options[${optionIndex}]`);
      const label = asText(
        option.text,
        `questions[${index}].options[${optionIndex}].text`,
        QUIZ_DRAFT_LIMITS.optionLabel,
      );
      const labelKey = label.toLowerCase();
      if (seenLabels.has(labelKey)) {
        throw invalid(`La pregunta «${prompt}» repite la opción «${label}».`);
      }
      seenLabels.add(labelKey);

      const optionId = OPTION_IDS[optionIndex];
      optionIds.push(optionId);
      optionLabels[optionId] = label;
      if (option.correct === true) correctOptionIds.push(optionId);
    });

    if (correctOptionIds.length === 0) {
      throw invalid(`La pregunta «${prompt}» no tiene ninguna opción marcada como correcta.`);
    }
    if (type === "single_choice" && correctOptionIds.length !== 1) {
      throw invalid(
        `La pregunta «${prompt}» es de respuesta única pero tiene ${correctOptionIds.length} correctas.`,
      );
    }
    if (type === "multi_choice" && correctOptionIds.length < 2) {
      throw invalid(
        `La pregunta «${prompt}» es de respuesta múltiple y necesita al menos dos correctas.`,
      );
    }

    let id = `q${index + 1}`;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `q${index + 1}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    return {
      id,
      type,
      optionIds,
      correctOptionIds,
      prompt,
      optionLabels,
      explanation: asText(
        record.explanation,
        `questions[${index}].explanation`,
        QUIZ_DRAFT_LIMITS.explanation,
      ),
    };
  });

  const issues = checkDraftQuizzes([{ id: "generado", quiz: questions }], []);
  const blocking = issues.filter((issue) => issue.severity === "error");
  if (blocking.length > 0) {
    throw invalid(blocking[0].message);
  }

  return { questions };
}
