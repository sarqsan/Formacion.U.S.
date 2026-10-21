import { describe, expect, it } from "vitest";
import {
  gradeAttempt,
  toClientQuiz,
  validateQuizDefinition,
  type QuizQuestionDefinition,
} from "@/domain/assessments/scoring";
import { DomainError } from "@/domain/text";

const q = (
  id: string,
  correct: string[],
  type: QuizQuestionDefinition["type"] = "single_choice",
): QuizQuestionDefinition => ({
  id,
  type,
  optionIds: ["a", "b", "c"],
  correctOptionIds: correct,
});

const quiz = [q("q1", ["a"]), q("q2", ["b"])];

describe("gradeAttempt", () => {
  it("aprueba solo con todas las respuestas correctas en el mismo intento", () => {
    const result = gradeAttempt(quiz, [
      { questionId: "q1", selectedOptionIds: ["a"] },
      { questionId: "q2", selectedOptionIds: ["b"] },
    ]);

    expect(result.passed).toBe(true);
    expect(result.correctCount).toBe(2);
    expect(result.score).toBe(100);
  });

  it("no aprueba con 80 % de aciertos", () => {
    const five = [
      q("q1", ["a"]),
      q("q2", ["b"]),
      q("q3", ["c"]),
      q("q4", ["a"]),
      q("q5", ["b"]),
    ];
    const answers = [
      { questionId: "q1", selectedOptionIds: ["a"] },
      { questionId: "q2", selectedOptionIds: ["b"] },
      { questionId: "q3", selectedOptionIds: ["c"] },
      { questionId: "q4", selectedOptionIds: ["a"] },
      { questionId: "q5", selectedOptionIds: ["a"] },
    ];

    const result = gradeAttempt(five, answers);
    expect(result.correctCount).toBe(4);
    expect(result.score).toBe(80);
    expect(result.passed).toBe(false);
    expect(result.incorrectQuestionIds).toEqual(["q5"]);
  });

  it("una pregunta en blanco impide aprobar", () => {
    const result = gradeAttempt(quiz, [{ questionId: "q1", selectedOptionIds: ["a"] }]);
    expect(result.passed).toBe(false);
    expect(result.unansweredQuestionIds).toEqual(["q2"]);
  });

  it("en multiopción exige el conjunto exacto", () => {
    const multi = [q("m1", ["a", "c"], "multi_choice")];

    expect(
      gradeAttempt(multi, [{ questionId: "m1", selectedOptionIds: ["a", "c"] }]).passed,
    ).toBe(true);
    expect(gradeAttempt(multi, [{ questionId: "m1", selectedOptionIds: ["c", "a"] }]).passed).toBe(
      true,
    );
    expect(gradeAttempt(multi, [{ questionId: "m1", selectedOptionIds: ["a"] }]).passed).toBe(false);
    expect(
      gradeAttempt(multi, [{ questionId: "m1", selectedOptionIds: ["a", "b", "c"] }]).passed,
    ).toBe(false);
    expect(
      gradeAttempt(multi, [{ questionId: "m1", selectedOptionIds: ["a", "a", "c"] }]).passed,
    ).toBe(false);
  });

  it("no aprueba por repetir la opción correcta", () => {
    const single = [q("s1", ["a"])];
    expect(
      gradeAttempt(single, [{ questionId: "s1", selectedOptionIds: ["a", "a"] }]).passed,
    ).toBe(false);
  });

  it("rechaza respuestas a preguntas inexistentes", () => {
    expect(() =>
      gradeAttempt(quiz, [
        { questionId: "q1", selectedOptionIds: ["a"] },
        { questionId: "q2", selectedOptionIds: ["b"] },
        { questionId: "fantasma", selectedOptionIds: ["a"] },
      ]),
    ).toThrowError(expect.objectContaining({ code: "ANSWER_UNKNOWN_QUESTION" }));
  });

  it("rechaza opciones inexistentes", () => {
    expect(() =>
      gradeAttempt(quiz, [
        { questionId: "q1", selectedOptionIds: ["z"] },
        { questionId: "q2", selectedOptionIds: ["b"] },
      ]),
    ).toThrowError(expect.objectContaining({ code: "ANSWER_UNKNOWN_OPTION" }));
  });

  it("rechaza respuestas duplicadas para la misma pregunta", () => {
    expect(() =>
      gradeAttempt(quiz, [
        { questionId: "q1", selectedOptionIds: ["a"] },
        { questionId: "q1", selectedOptionIds: ["b"] },
        { questionId: "q2", selectedOptionIds: ["b"] },
      ]),
    ).toThrowError(expect.objectContaining({ code: "ANSWER_DUPLICATED" }));
  });

  it("ignora el orden de las preguntas al corregir", () => {
    const reversed = [...quiz].reverse();
    expect(
      gradeAttempt(reversed, [
        { questionId: "q2", selectedOptionIds: ["b"] },
        { questionId: "q1", selectedOptionIds: ["a"] },
      ]).passed,
    ).toBe(true);
  });
});

describe("validateQuizDefinition", () => {
  it("acepta una definición correcta", () => {
    expect(() => validateQuizDefinition(quiz)).not.toThrow();
  });

  it.each([
    [[], "QUIZ_EMPTY"],
    [[q("q1", ["a"]), q("q1", ["b"])], "QUIZ_DUPLICATE_QUESTION"],
    [[{ ...q("q1", ["a"]), optionIds: ["a"] }], "QUIZ_TOO_FEW_OPTIONS"],
    [[{ ...q("q1", ["a"]), optionIds: ["a", "a"] }], "QUIZ_DUPLICATE_OPTION"],
    [[q("q1", [])], "QUIZ_NO_CORRECT_ANSWER"],
    [[q("q1", ["z"])], "QUIZ_CORRECT_ANSWER_UNKNOWN_OPTION"],
    [[q("q1", ["a", "b"])], "QUIZ_SINGLE_CHOICE_MULTIPLE_CORRECT"],
    [[q("q1", ["a", "a"])], "QUIZ_DUPLICATE_CORRECT_ANSWER"],
  ])("rechaza definiciones inválidas (%#)", (questions, code) => {
    try {
      validateQuizDefinition(questions as QuizQuestionDefinition[]);
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect((error as DomainError).code).toBe(code);
    }
  });
});

describe("toClientQuiz", () => {
  it("no expone las respuestas correctas al cliente", () => {
    const client = toClientQuiz(quiz);
    expect(JSON.stringify(client)).not.toContain("correctOptionIds");
    expect(client[0]).toEqual({ id: "q1", type: "single_choice", optionIds: ["a", "b", "c"] });
  });
});
