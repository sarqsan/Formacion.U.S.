import { describe, expect, it } from "vitest";
import type { QuizQuestionDefinition } from "@/domain/assessments/scoring";
import { parseDraftQuizForm, quizSavedRedirect } from "@/server/courses/quiz-form";
import { saveDraftAssessments, startDraft } from "@/server/courses/editor";
import { definitionFromDocuments } from "@/server/courses/definition";
import { ADMIN, FIXED_NOW, InMemoryCatalogStore, makeDefinition, makeTopic } from "../helpers/db-doubles";

/**
 * FORMULARIO DE CUESTIONARIOS: DE `FormData` A PREGUNTAS
 * ====================================================
 *
 * El editor es HTML sin JavaScript, así que la traducción del formulario es
 * donde se pierden datos si se hace mal. Se comprueba:
 *
 *   · editar el enunciado, el tipo y el texto de las opciones;
 *   · cambiar cuál es la respuesta correcta (en única y en múltiple);
 *   · añadir y quitar opciones, y añadir y eliminar preguntas;
 *   · que los cuestionarios de un tema y el examen final no se mezclan aunque
 *     sus preguntas tengan el mismo identificador;
 *   · que un bloque a medias da un error claro, no una pregunta inventada.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function question(overrides: Partial<QuizQuestionDefinition> = {}): QuizQuestionDefinition {
  return {
    id: "pregunta-1",
    type: "single_choice",
    optionIds: ["a", "b"],
    correctOptionIds: ["a"],
    prompt: "Enunciado original",
    optionLabels: { a: "Opción A", b: "Opción B" },
    ...overrides,
  };
}

const view = {
  topics: [{ id: "tema-1", quiz: [question()] }],
  finalExam: [question({ id: "final-1", correctOptionIds: ["b"] })],
};

/** Campos mínimos para que una pregunta existente siga existiendo. */
function baseFields(): Record<string, string> {
  return {
    "quiz:tema-1:question:pregunta-1:prompt": "Enunciado original",
    "quiz:tema-1:question:pregunta-1:type": "single_choice",
    "quiz:tema-1:question:pregunta-1:option:a": "Opción A",
    "quiz:tema-1:question:pregunta-1:option:b": "Opción B",
    "quiz:tema-1:question:pregunta-1:correct:a": "on",
    "quiz:final:question:final-1:prompt": "Enunciado original",
    "quiz:final:question:final-1:type": "single_choice",
    "quiz:final:question:final-1:option:a": "Opción A",
    "quiz:final:question:final-1:option:b": "Opción B",
    "quiz:final:question:final-1:correct:b": "on",
  };
}

describe("parseDraftQuizForm", () => {
  it("lee los cuestionarios sin cambios tal y como están", () => {
    const parsed = parseDraftQuizForm(form(baseFields()), view);

    expect(parsed.topicQuizzes["tema-1"]).toEqual([
      {
        id: "pregunta-1",
        type: "single_choice",
        optionIds: ["a", "b"],
        correctOptionIds: ["a"],
        prompt: "Enunciado original",
        optionLabels: { a: "Opción A", b: "Opción B" },
      },
    ]);
    // El mismo identificador en el examen final no se confunde con el del tema.
    expect(parsed.finalExam).toEqual([
      {
        id: "final-1",
        type: "single_choice",
        optionIds: ["a", "b"],
        correctOptionIds: ["b"],
        prompt: "Enunciado original",
        optionLabels: { a: "Opción A", b: "Opción B" },
      },
    ]);
  });

  it("edita el enunciado, el tipo y las etiquetas", () => {
    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:tema-1:question:pregunta-1:prompt": "  Enunciado nuevo  ",
        "quiz:tema-1:question:pregunta-1:type": "multi_choice",
        "quiz:tema-1:question:pregunta-1:option:b": "Etiqueta nueva",
      }),
      view,
    );

    expect(parsed.topicQuizzes["tema-1"][0]).toMatchObject({
      prompt: "Enunciado nuevo",
      type: "multi_choice",
      optionLabels: { a: "Opción A", b: "Etiqueta nueva" },
    });
  });

  it("cambia la respuesta correcta y admite varias en respuesta múltiple", () => {
    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:tema-1:question:pregunta-1:type": "multi_choice",
        "quiz:tema-1:question:pregunta-1:correct:a": "",
        "quiz:tema-1:question:pregunta-1:correct:b": "on",
      }),
      view,
    );

    // Un checkbox sin marcar no llega en el FormData: no hay que borrarlo a mano.
    const single = parseDraftQuizForm(
      form({ ...baseFields(), "quiz:tema-1:question:pregunta-1:correct:a": "" }),
      view,
    );

    expect(parsed.topicQuizzes["tema-1"][0].correctOptionIds).toEqual(["b"]);
    expect(single.topicQuizzes["tema-1"][0].correctOptionIds).toEqual([]);
  });

  it("quita una opción marcada y su respuesta correcta con ella", () => {
    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:tema-1:question:pregunta-1:removeOption:a": "on",
      }),
      view,
    );

    expect(parsed.topicQuizzes["tema-1"][0].optionIds).toEqual(["b"]);
    expect(parsed.topicQuizzes["tema-1"][0].correctOptionIds).toEqual([]);
  });

  it("añade una opción nueva, con o sin marcar como correcta", () => {
    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:tema-1:question:pregunta-1:newOptionId": "c",
        "quiz:tema-1:question:pregunta-1:newOptionLabel": "Opción C",
        "quiz:tema-1:question:pregunta-1:newOptionCorrect": "on",
      }),
      view,
    );

    expect(parsed.topicQuizzes["tema-1"][0].optionIds).toEqual(["a", "b", "c"]);
    expect(parsed.topicQuizzes["tema-1"][0].correctOptionIds).toEqual(["a", "c"]);
    expect(parsed.topicQuizzes["tema-1"][0].optionLabels?.c).toBe("Opción C");
  });

  it("elimina la pregunta marcada, sin tocar las demás", () => {
    const parsed = parseDraftQuizForm(
      form({ ...baseFields(), "quiz:tema-1:question:pregunta-1:delete": "on" }),
      view,
    );

    expect(parsed.topicQuizzes["tema-1"]).toEqual([]);
    expect(parsed.finalExam).toHaveLength(1);
  });

  it("añade una pregunta completa con sus opciones", () => {
    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:final:newQuestionId": "final-2",
        "quiz:final:newQuestionPrompt": "Pregunta nueva",
        "quiz:final:newQuestionType": "multi_choice",
        "quiz:final:newOption1Id": "x",
        "quiz:final:newOption1Label": "Equis",
        "quiz:final:newOption2Id": "y",
        "quiz:final:newOption2Label": "Ye",
        "quiz:final:newOption2Correct": "on",
        "quiz:final:newOption3Id": "z",
        "quiz:final:newOption3Label": "Zeta",
        "quiz:final:newOption3Correct": "on",
      }),
      view,
    );

    const nueva = parsed.finalExam.find((item) => item.id === "final-2");
    expect(nueva).toMatchObject({
      type: "multi_choice",
      prompt: "Pregunta nueva",
      optionIds: ["x", "y", "z"],
      correctOptionIds: ["y", "z"],
      optionLabels: { x: "Equis", y: "Ye", z: "Zeta" },
    });
  });

  it("rechaza una pregunta nueva a medias en lugar de inventarla", () => {
    expect(() =>
      parseDraftQuizForm(form({ ...baseFields(), "quiz:final:newQuestionId": "solo-id" }), view),
    ).toThrowError(/identificador y enunciado/);
  });

  it("rechaza una opción nueva a medias", () => {
    expect(() =>
      parseDraftQuizForm(
        form({
          ...baseFields(),
          "quiz:final:newQuestionId": "final-3",
          "quiz:final:newQuestionPrompt": "Pregunta",
          "quiz:final:newOption1Id": "x",
        }),
        view,
      ),
    ).toThrowError(/identificador y texto/);
  });

  it("una pregunta sin campos en el formulario se elimina", () => {
    const parsed = parseDraftQuizForm(form({ "quiz:final:newQuestionId": "" }), view);
    expect(parsed.topicQuizzes["tema-1"]).toEqual([]);
    expect(parsed.finalExam).toEqual([]);
  });
});

describe("del formulario al almacén", () => {
  it("guarda lo que el formulario describía y se recupera igual", async () => {
    const store = new InMemoryCatalogStore();
    store.seedPublished(
      makeDefinition({
        topics: [makeTopic({ id: "tema-1", quiz: [question()] })],
        finalExam: [question({ id: "final-1" })],
      }),
    );
    const deps = { store, now: () => FIXED_NOW };
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);

    const current = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      await store.getAnswerKeys("curso-a", opened.version),
    );

    const parsed = parseDraftQuizForm(
      form({
        ...baseFields(),
        "quiz:tema-1:question:pregunta-1:prompt": "Enunciado editado",
        "quiz:tema-1:question:pregunta-1:correct:a": "",
        "quiz:tema-1:question:pregunta-1:correct:b": "on",
        "quiz:final:question:final-1:delete": "on",
        "quiz:final:newQuestionId": "final-2",
        "quiz:final:newQuestionPrompt": "Nueva del examen",
        "quiz:final:newOption1Id": "si",
        "quiz:final:newOption1Label": "Sí",
        "quiz:final:newOption2Id": "no",
        "quiz:final:newOption2Label": "No",
        "quiz:final:newOption2Correct": "on",
      }),
      {
        topics: current.topics.map((topic) => ({ id: topic.id, quiz: topic.quiz })),
        finalExam: current.finalExam,
      },
    );

    await saveDraftAssessments(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        topicQuizzes: parsed.topicQuizzes,
        finalExam: parsed.finalExam,
      },
      deps,
    );

    const stored = definitionFromDocuments(
      (await store.getVersion("curso-a", opened.version))!,
      await store.getAnswerKeys("curso-a", opened.version),
    );

    expect(stored.topics[0].quiz[0]).toMatchObject({
      id: "pregunta-1",
      prompt: "Enunciado editado",
      correctOptionIds: ["b"],
    });
    expect(stored.finalExam.map((item) => item.id)).toEqual(["final-2"]);
    expect(stored.finalExam[0].correctOptionIds).toEqual(["no"]);
    // Y la versión guardada sigue sin respuestas.
    expect(JSON.stringify(await store.getVersion("curso-a", opened.version))).not.toContain(
      "correctOptionIds",
    );
  });
});

describe("ruta de vuelta al editor", () => {
  it("distingue éxito de error y nunca mezcla los dos", () => {
    expect(quizSavedRedirect({ courseId: "c", version: 2 })).toBe(
      "/admin/cursos/c/editar?v=2&ok=cuestionarios",
    );
    const failed = quizSavedRedirect({ courseId: "c", version: 2, failure: "DRAFT_STALE" });
    expect(failed).toContain("error=DRAFT_STALE");
    expect(failed).not.toContain("ok=");
  });
});
