import { describe, expect, it } from "vitest";
import { validateQuizDefinition, type QuizQuestionDefinition } from "@/domain/assessments/scoring";
import {
  QUIZ_DRAFT_LIMITS,
  checkDraftQuizzes,
  checkQuestionStructure,
  checkQuizStructure,
  quizSummary,
  reviewDraftQuizzes,
} from "@/domain/courses/quiz-draft";
import { validateCourseVersion } from "@/domain/courses/content";
import { makeDefinition, makeTopic } from "../helpers/db-doubles";

/**
 * CUESTIONARIOS DEL BORRADOR: ESTRUCTURA, NO CONTENIDO
 * ===================================================
 *
 * Lo que se exige aquí es lo mínimo para que un cuestionario guardado se pueda
 * mostrar y corregir: enunciado, opciones con texto, una respuesta correcta que
 * exista. **No** se exige que haya cuestionario: un borrador sin preguntas es
 * válido y se guarda; publicarlo sigue prohibido por `validateCourseVersion`.
 */

function question(overrides: Partial<QuizQuestionDefinition> = {}): QuizQuestionDefinition {
  return {
    id: "pregunta-1",
    type: "single_choice",
    optionIds: ["a", "b", "c"],
    correctOptionIds: ["b"],
    prompt: "¿Cuál es la respuesta correcta?",
    optionLabels: { a: "Primera", b: "Segunda", c: "Tercera" },
    ...overrides,
  };
}

const codes = (issues: ReadonlyArray<{ code: string }>) => issues.map((issue) => issue.code);

describe("checkQuestionStructure", () => {
  it("acepta una pregunta completa de respuesta única", () => {
    expect(checkQuestionStructure(question(), "finalExam[0]")).toEqual([]);
  });

  it("acepta varias correctas si es de respuesta múltiple", () => {
    const multiple = question({
      type: "multi_choice",
      correctOptionIds: ["a", "c"],
    });
    expect(checkQuestionStructure(multiple, "finalExam[0]")).toEqual([]);
  });

  it("rechaza un enunciado vacío: es lo único que ve el alumnado", () => {
    expect(codes(checkQuestionStructure(question({ prompt: "   " }), "p"))).toContain(
      "QUESTION_PROMPT_REQUIRED",
    );
  });

  it("rechaza enunciados y textos de opción por encima del límite", () => {
    expect(
      codes(
        checkQuestionStructure(
          question({ prompt: "x".repeat(QUIZ_DRAFT_LIMITS.prompt + 1) }),
          "p",
        ),
      ),
    ).toContain("QUESTION_PROMPT_TOO_LONG");

    expect(
      codes(
        checkQuestionStructure(
          question({ optionLabels: { a: "x".repeat(QUIZ_DRAFT_LIMITS.optionLabel + 1), b: "B", c: "C" } }),
          "p",
        ),
      ),
    ).toContain("OPTION_LABEL_TOO_LONG");
  });

  it("rechaza menos de dos opciones y más del máximo", () => {
    expect(
      codes(checkQuestionStructure(question({ optionIds: ["a"], correctOptionIds: ["a"] }), "p")),
    ).toContain("QUESTION_TOO_FEW_OPTIONS");

    const many = Array.from({ length: QUIZ_DRAFT_LIMITS.maxOptions + 1 }, (_, index) => `o${index}`);
    expect(
      codes(
        checkQuestionStructure(
          question({
            optionIds: many,
            correctOptionIds: ["o0"],
            optionLabels: Object.fromEntries(many.map((id) => [id, `Opción ${id}`])),
          }),
          "p",
        ),
      ),
    ).toContain("QUESTION_TOO_MANY_OPTIONS");
  });

  it("rechaza opciones repetidas o con identificador inválido", () => {
    expect(
      codes(
        checkQuestionStructure(
          question({ optionIds: ["a", "a", "b"], correctOptionIds: ["a"] }),
          "p",
        ),
      ),
    ).toContain("OPTION_ID_DUPLICATED");

    expect(
      codes(
        checkQuestionStructure(
          question({
            optionIds: ["a", "Opción Rara"],
            correctOptionIds: ["a"],
            optionLabels: { a: "A", "Opción Rara": "Rara" },
          }),
          "p",
        ),
      ),
    ).toContain("OPTION_ID_INVALID");
  });

  it("una opción sin texto no bloquea el guardado, pero se avisa", () => {
    const sinEtiqueta = question({ optionLabels: { a: "A", b: "B" } });

    expect(checkQuestionStructure(sinEtiqueta, "finalExam[0]")).toEqual([]);
    const warnings = reviewDraftQuizzes([], [sinEtiqueta]);
    expect(warnings.map((issue) => issue.code)).toContain("OPTION_LABEL_MISSING");
    expect(warnings.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("exige al menos una respuesta correcta que exista de verdad", () => {
    expect(
      codes(checkQuestionStructure(question({ correctOptionIds: [] }), "p")),
    ).toContain("QUESTION_WITHOUT_CORRECT_ANSWER");

    expect(
      codes(checkQuestionStructure(question({ correctOptionIds: ["z"] }), "p")),
    ).toContain("QUESTION_CORRECT_UNKNOWN_OPTION");
  });

  it("no admite dos correctas en una pregunta de respuesta única", () => {
    expect(
      codes(checkQuestionStructure(question({ correctOptionIds: ["a", "b"] }), "p")),
    ).toContain("QUESTION_SINGLE_CHOICE_MULTIPLE_CORRECT");
  });

  it("rechaza etiquetas de opciones que ya no existen", () => {
    expect(
      codes(
        checkQuestionStructure(
          question({ optionLabels: { a: "A", b: "B", c: "C", z: "Fantasma" } }),
          "p",
        ),
      ),
    ).toContain("QUESTION_LABEL_UNKNOWN_OPTION");
  });

  it("valida identificadores y tipo", () => {
    expect(codes(checkQuestionStructure(question({ id: "Pregunta Uno" }), "p"))).toContain(
      "QUESTION_ID_INVALID",
    );
    expect(
      codes(
        checkQuestionStructure(
          question({ type: "abierta" as unknown as QuizQuestionDefinition["type"] }),
          "p",
        ),
      ),
    ).toContain("QUESTION_TYPE_INVALID");
  });
});

describe("checkQuizStructure", () => {
  it("un cuestionario vacío es válido: se está escribiendo", () => {
    expect(checkQuizStructure([], "topics[0].quiz")).toEqual([]);
  });

  it("rechaza identificadores de pregunta repetidos, con la ruta exacta", () => {
    const issues = checkQuizStructure([question(), question()], "finalExam");
    const duplicated = issues.find((issue) => issue.code === "QUESTION_ID_DUPLICATED");

    expect(duplicated?.path).toBe("finalExam[1].id");
  });

  it("acumula los problemas de todas las preguntas, no solo del primero", () => {
    const issues = checkQuizStructure(
      [question({ id: "p-1", prompt: "" }), question({ id: "p-2", correctOptionIds: [] })],
      "finalExam",
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining(["QUESTION_PROMPT_REQUIRED", "QUESTION_WITHOUT_CORRECT_ANSWER"]),
    );
  });

  it("limita el número de preguntas por cuestionario", () => {
    const questions = Array.from({ length: QUIZ_DRAFT_LIMITS.maxQuestions + 1 }, (_, index) =>
      question({ id: `p-${index + 1}` }),
    );
    expect(codes(checkQuizStructure(questions, "finalExam"))).toContain(
      "QUIZ_TOO_MANY_QUESTIONS",
    );
  });

  it("el borrador completo (temas + examen) no tiene errores con preguntas bien formadas", () => {
    const topics = [makeTopic({ id: "tema-1" })];
    expect(checkDraftQuizzes(topics, [question()])).toEqual([]);
  });
});

describe("coherencia con la publicación", () => {
  it("un borrador con cuestionarios válidos es publicable; uno sin preguntas no", () => {
    const conPreguntas = makeDefinition({
      topics: [makeTopic({ id: "tema-1" })],
      finalExam: [question()],
    });
    expect(validateCourseVersion(conPreguntas)).toEqual([]);

    const sinPreguntas = makeDefinition({
      topics: [makeTopic({ id: "tema-1", quiz: [] })],
      finalExam: [],
    });
    expect(codes(validateCourseVersion(sinPreguntas))).toEqual(
      expect.arrayContaining(["TOPIC_QUIZ_REQUIRED", "FINAL_EXAM_REQUIRED"]),
    );
    // Y no se puede guardar con una pregunta rota:
    expect(codes(checkDraftQuizzes(sinPreguntas.topics, sinPreguntas.finalExam))).toEqual([]);
  });

  it("la puerta de corrección sigue rechazando lo que ya rechazaba", () => {
    expect(() => validateQuizDefinition([])).toThrowError(/no tiene preguntas/);
    expect(() =>
      validateQuizDefinition([question({ correctOptionIds: [] })]),
    ).toThrowError(/no tiene respuesta correcta/);
  });

  it("el resumen cuenta preguntas y opciones", () => {
    expect(quizSummary([question(), question({ id: "p-2", optionIds: ["a", "b"] })])).toEqual({
      questions: 2,
      options: 5,
    });
  });
});
