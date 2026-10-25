import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import {
  parseGeneratedQuiz,
  parseScreens,
  parseTopicPlan,
  slugFromTitle,
} from "@/domain/courses/ai-plan";

/**
 * FRONTERA ENTRE EL MODELO Y EL CONTENIDO DEL CURSO
 * =================================================
 *
 * Gemini propone JSON; esto es lo que decide si ese JSON puede convertirse en
 * contenido del curso. Cada prueba corresponde a un fallo que llegaría al
 * alumnado si no se comprobara: una pregunta sin respuesta correcta, una
 * pregunta de respuesta única con dos correctas, una cita a una página que el
 * PDF no tiene, dos temas con el mismo nombre.
 */

function code(fn: () => unknown): string {
  try {
    fn();
    return "SIN_ERROR";
  } catch (error) {
    return error instanceof DomainError ? error.code : "ERROR_INESPERADO";
  }
}

describe("parseTopicPlan", () => {
  const respuesta = {
    topics: [
      { title: "Introducción y marco legal", pages: [1, 2, 3], summary: "Qué es y qué norma lo regula." },
      { title: "Evaluación de riesgos", pages: [4, 5] },
    ],
    notes: "El índice de la página 1 no se ha asignado a ningún tema.",
  };

  it("convierte la propuesta en temas con identificador estable y páginas ordenadas", () => {
    const plan = parseTopicPlan(respuesta, { pageCount: 10 });
    expect(plan.topics).toEqual([
      {
        id: "introduccion-y-marco-legal",
        title: "Introducción y marco legal",
        pages: [1, 2, 3],
        summary: "Qué es y qué norma lo regula.",
      },
      { id: "evaluacion-de-riesgos", title: "Evaluación de riesgos", pages: [4, 5], summary: null },
    ]);
    expect(plan.notes).toContain("índice");
  });

  it("no reutiliza el identificador del tema que ya existe en el curso", () => {
    const plan = parseTopicPlan(
      { topics: [{ title: "Temario", pages: [1] }] },
      { pageCount: 5, existingIds: ["temario"] },
    );
    expect(plan.topics[0].id).toBe("temario-2");
  });

  it("rechaza una página que el PDF no tiene", () => {
    expect(
      code(() => parseTopicPlan({ topics: [{ title: "Tema", pages: [400] }] }, { pageCount: 12 })),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza títulos repetidos y propuestas vacías", () => {
    expect(
      code(() =>
        parseTopicPlan({
          topics: [
            { title: "Riesgos", pages: [1] },
            { title: "riesgos", pages: [2] },
          ],
        }),
      ),
    ).toBe("AI_INVALID_OUTPUT");

    expect(code(() => parseTopicPlan({ topics: [] }))).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza una respuesta que no tiene la forma pedida", () => {
    expect(code(() => parseTopicPlan({ topics: "dos temas" }))).toBe("AI_INVALID_OUTPUT");
    expect(code(() => parseTopicPlan(null))).toBe("AI_INVALID_OUTPUT");
  });

  it("genera identificadores sin acentos ni símbolos", () => {
    expect(slugFromTitle("Prevención de riesgos: ¡EPIs!", "tema-1")).toBe(
      "prevencion-de-riesgos-epis",
    );
    expect(slugFromTitle("¿¿¿", "tema-3")).toBe("tema-3");
  });
});

describe("parseScreens", () => {
  const respuesta = {
    screens: [
      {
        title: "Qué es un riesgo laboral",
        paragraphs: ["Un riesgo es la posibilidad de que se produzca un daño.", "Se mide en probabilidad y severidad."],
        bullets: ["Peligro no es lo mismo que riesgo", "La evaluación parte del puesto"],
        pages: [4, 3, 4],
      },
      {
        title: "Cómo se evalúa",
        paragraphs: ["Se identifican peligros y se valoran."],
        pages: [],
      },
    ],
  };

  it("pone identificadores del servidor y ordena las páginas sin repetirlas", () => {
    const screens = parseScreens(respuesta, { pageCount: 20 });
    expect(screens.map((screen) => screen.id)).toEqual(["pantalla-1", "pantalla-2"]);
    expect(screens[0].pages).toEqual([3, 4]);
    expect(screens[1].bullets).toEqual([]);
    expect(screens[0].paragraphs).toHaveLength(2);
  });

  it("rechaza una pantalla que cita una página inexistente", () => {
    expect(
      code(() =>
        parseScreens(
          { screens: [{ title: "Tema", paragraphs: ["Texto"], pages: [90] }] },
          { pageCount: 10 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza pantallas sin explicación o con texto desmedido", () => {
    expect(
      code(() => parseScreens({ screens: [{ title: "Tema", paragraphs: [], pages: [] }] })),
    ).toBe("AI_INVALID_OUTPUT");

    expect(
      code(() =>
        parseScreens({
          screens: [
            {
              title: "Tema",
              paragraphs: ["x".repeat(700)],
              pages: [],
            },
          ],
        }),
      ),
    ).toBe("AI_INVALID_OUTPUT");

    expect(code(() => parseScreens({ screens: [] }))).toBe("AI_INVALID_OUTPUT");
  });
});

describe("parseGeneratedQuiz", () => {
  const pregunta = {
    prompt: "¿Cuál es el primer paso de la evaluación de riesgos?",
    type: "single_choice",
    options: [
      { text: "Identificar los peligros", correct: true },
      { text: "Comprar equipos de protección", correct: false },
      { text: "Formar al personal", correct: false },
    ],
    explanation: "El documento sitúa la identificación de peligros como primer paso.",
  };

  it("asigna identificadores del servidor y conserva la explicación", () => {
    const quiz = parseGeneratedQuiz({ questions: [pregunta] }, { questionCount: 5 });
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0].id).toBe("q1");
    expect(quiz.questions[0].optionIds).toEqual(["a", "b", "c"]);
    expect(quiz.questions[0].correctOptionIds).toEqual(["a"]);
    expect(quiz.questions[0].optionLabels?.b).toBe("Comprar equipos de protección");
    expect(quiz.questions[0].explanation).toContain("primer paso");
  });

  it("acepta respuesta múltiple con dos correctas", () => {
    const quiz = parseGeneratedQuiz(
      {
        questions: [
          {
            ...pregunta,
            type: "multi_choice",
            options: [
              { text: "Identificar peligros", correct: true },
              { text: "Valorar el riesgo", correct: true },
              { text: "Ignorarlo", correct: false },
            ],
          },
        ],
      },
      { questionCount: 5 },
    );
    expect(quiz.questions[0].type).toBe("multi_choice");
    expect(quiz.questions[0].correctOptionIds).toEqual(["a", "b"]);
  });

  it("rechaza una pregunta sin respuesta correcta", () => {
    expect(
      code(() =>
        parseGeneratedQuiz(
          {
            questions: [
              {
                ...pregunta,
                options: pregunta.options.map((option) => ({ ...option, correct: false })),
              },
            ],
          },
          { questionCount: 5 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza dos correctas en una pregunta de respuesta única", () => {
    expect(
      code(() =>
        parseGeneratedQuiz(
          {
            questions: [
              {
                ...pregunta,
                options: [
                  { text: "Una", correct: true },
                  { text: "Otra", correct: true },
                  { text: "Ninguna", correct: false },
                ],
              },
            ],
          },
          { questionCount: 5 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza respuesta múltiple con una sola correcta", () => {
    expect(
      code(() =>
        parseGeneratedQuiz(
          { questions: [{ ...pregunta, type: "multi_choice" }] },
          { questionCount: 5 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza enunciados y opciones repetidas", () => {
    expect(
      code(() =>
        parseGeneratedQuiz({ questions: [pregunta, pregunta] }, { questionCount: 5 }),
      ),
    ).toBe("AI_INVALID_OUTPUT");

    expect(
      code(() =>
        parseGeneratedQuiz(
          {
            questions: [
              {
                ...pregunta,
                options: [
                  { text: "Lo mismo", correct: true },
                  { text: "lo mismo", correct: false },
                  { text: "Otra", correct: false },
                ],
              },
            ],
          },
          { questionCount: 5 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });

  it("rechaza más preguntas de las pedidas y preguntas sin explicación", () => {
    expect(
      code(() => parseGeneratedQuiz({ questions: [pregunta, { ...pregunta, prompt: "Otra" }] }, { questionCount: 1 })),
    ).toBe("AI_INVALID_OUTPUT");

    expect(
      code(() =>
        parseGeneratedQuiz(
          { questions: [{ ...pregunta, explanation: "" }] },
          { questionCount: 5 },
        ),
      ),
    ).toBe("AI_INVALID_OUTPUT");
  });
});
