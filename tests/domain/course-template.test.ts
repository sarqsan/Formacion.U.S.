import { describe, expect, it } from "vitest";
import {
  cloneVersionAsDraft,
  draftMetadata,
  emptyCourseDefinition,
} from "@/domain/courses/template";
import { validateCourseVersion } from "@/domain/courses/content";
import { makeDefinition, makeTopic } from "../helpers/db-doubles";

/**
 * PLANTILLAS DE CURSO
 * ===================
 *
 * Dos propiedades sostienen todo el ciclo de vida y son las que se prueban
 * aquí: la definición vacía **no** es publicable (y eso es correcto) y la copia
 * para un borrador es **profunda** (editar la copia no puede tocar lo
 * publicado).
 */

describe("definición inicial vacía", () => {
  it("no tiene temas ni examen final", () => {
    const definition = emptyCourseDefinition({ courseId: "curso-a", title: "Curso A" });

    expect(definition.topics).toEqual([]);
    expect(definition.finalExam).toEqual([]);
    expect(definition.version).toBe(1);
  });

  it("recorta espacios y omite la descripción vacía", () => {
    const definition = emptyCourseDefinition({
      courseId: "  curso-a  ",
      title: "  Curso A  ",
      description: "   ",
    });

    expect(definition.courseId).toBe("curso-a");
    expect(definition.title).toBe("Curso A");
    expect(definition).not.toHaveProperty("description");
  });

  it("conserva la descripción cuando la hay", () => {
    const definition = emptyCourseDefinition({
      courseId: "curso-a",
      title: "Curso A",
      description: " Para el personal de seguridad ",
    });

    expect(definition.description).toBe("Para el personal de seguridad");
  });

  it("no valida para publicar: una definición vacía no es publicable", () => {
    // Se guarda como borrador sin problema; lo que no puede es publicarse. La
    // validación de publicación no se ha relajado para conseguirlo.
    const issues = validateCourseVersion(
      emptyCourseDefinition({ courseId: "curso-a", title: "Curso A" }),
    );

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((issue) => issue.code)).toContain("COURSE_NO_TOPICS");
  });

  it("rechaza identificadores que la validación de contenido rechazaría", () => {
    for (const courseId of ["Curso-A", "curso_a", "-curso", "", "a".repeat(65)]) {
      expect(() => emptyCourseDefinition({ courseId, title: "Curso A" })).toThrowError(
        /identificador/i,
      );
    }
  });

  it("exige título", () => {
    expect(() => emptyCourseDefinition({ courseId: "curso-a", title: "   " })).toThrowError(
      /título/i,
    );
  });
});

describe("clonación profunda de una versión", () => {
  function source() {
    return makeDefinition({
      topics: [
        makeTopic({
          id: "tema-1",
          order: 1,
          quiz: [
            {
              id: "q-1",
              type: "single_choice",
              optionIds: ["a", "b", "c"],
              correctOptionIds: ["a"],
              prompt: "Pregunta 1",
              optionLabels: { a: "Sí", b: "No", c: "Tal vez" },
            },
          ],
        }),
        makeTopic({ id: "tema-2", order: 2 }),
      ],
      finalExam: [
        {
          id: "q-final",
          type: "single_choice",
          optionIds: ["x", "y"],
          correctOptionIds: ["y"],
        },
      ],
    });
  }

  it("cambia el número de versión y conserva el contenido", () => {
    const original = source();
    const clone = cloneVersionAsDraft(original, { version: 7 });

    expect(clone.version).toBe(7);
    expect(original.version).toBe(1);
    expect(clone.courseId).toBe(original.courseId);
    expect(clone.title).toBe(original.title);
    expect(clone.topics.map((topic) => topic.id)).toEqual(["tema-1", "tema-2"]);
    expect(clone.finalExam[0].correctOptionIds).toEqual(["y"]);
  });

  it("no comparte ninguna referencia mutable con el original", () => {
    const original = source();
    const clone = cloneVersionAsDraft(original, { version: 2 });

    expect(clone).not.toBe(original);
    expect(clone.topics).not.toBe(original.topics);
    expect(clone.finalExam).not.toBe(original.finalExam);
    expect(clone.topics[0]).not.toBe(original.topics[0]);
    expect(clone.topics[0].documents).not.toBe(original.topics[0].documents);
    expect(clone.topics[0].documents[0]).not.toBe(original.topics[0].documents[0]);
    expect(clone.topics[0].quiz).not.toBe(original.topics[0].quiz);
    expect(clone.topics[0].quiz[0]).not.toBe(original.topics[0].quiz[0]);
    expect(clone.topics[0].quiz[0].optionIds).not.toBe(original.topics[0].quiz[0].optionIds);
    expect(clone.topics[0].quiz[0].correctOptionIds).not.toBe(
      original.topics[0].quiz[0].correctOptionIds,
    );
    expect(clone.topics[0].quiz[0].optionLabels).not.toBe(
      original.topics[0].quiz[0].optionLabels,
    );
  });

  it("editar la copia no cambia el original", () => {
    const original = source();
    const clone = cloneVersionAsDraft(original, { version: 2 });

    clone.title = "Curso cambiado";
    clone.topics[0].title = "Tema cambiado";
    clone.topics[0].order = 9;
    clone.topics[0].mandatory = false;
    clone.topics[0].documents[0].title = "PDF cambiado";
    clone.topics[0].documents[0].pageCount = 99;
    clone.topics[0].quiz[0].prompt = "Otra pregunta";
    clone.topics[0].quiz[0].optionIds.push("d");
    clone.topics[0].quiz[0].correctOptionIds[0] = "b";
    clone.topics[0].quiz[0].optionLabels!.a = "Cambiada";
    clone.topics.push(makeTopic({ id: "tema-3", order: 3 }));
    clone.finalExam[0].correctOptionIds[0] = "x";

    expect(original.title).toBe("Curso A");
    expect(original.topics).toHaveLength(2);
    expect(original.topics[0].title).toBe("Tema tema-1");
    expect(original.topics[0].order).toBe(1);
    expect(original.topics[0].mandatory).toBe(true);
    expect(original.topics[0].documents[0].title).toBe("PDF tema-1");
    expect(original.topics[0].documents[0].pageCount).toBe(3);
    expect(original.topics[0].quiz[0].prompt).toBe("Pregunta 1");
    expect(original.topics[0].quiz[0].optionIds).toEqual(["a", "b", "c"]);
    expect(original.topics[0].quiz[0].correctOptionIds).toEqual(["a"]);
    expect(original.topics[0].quiz[0].optionLabels).toEqual({
      a: "Sí",
      b: "No",
      c: "Tal vez",
    });
    expect(original.finalExam[0].correctOptionIds).toEqual(["y"]);
  });

  it("editar el original tampoco cambia la copia", () => {
    const original = source();
    const clone = cloneVersionAsDraft(original, { version: 2 });

    original.topics[0].documents[0].pageCount = 42;
    original.topics[0].quiz[0].correctOptionIds.push("c");
    original.topics.pop();

    expect(clone.topics).toHaveLength(2);
    expect(clone.topics[0].documents[0].pageCount).toBe(3);
    expect(clone.topics[0].quiz[0].correctOptionIds).toEqual(["a"]);
  });

  it("permite clonar hacia otro curso y con otro título", () => {
    const clone = cloneVersionAsDraft(source(), {
      version: 3,
      courseId: "curso-b",
      title: "Copia para B",
    });

    expect(clone.courseId).toBe("curso-b");
    expect(clone.title).toBe("Copia para B");
  });

  it("rechaza versiones que no son enteros positivos", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => cloneVersionAsDraft(source(), { version })).toThrowError(/versión/i);
    }
  });

  it("rechaza un identificador de curso inválido", () => {
    expect(() =>
      cloneVersionAsDraft(source(), { version: 2, courseId: "Curso B" }),
    ).toThrowError(/identificador/i);
  });
});

describe("metadatos del borrador", () => {
  const now = new Date("2026-10-21T08:00:00.000Z");

  it("nace sin publicación y con la autoría de la operación actual", () => {
    const meta = draftMetadata(now, "admin-uid-1");

    expect(meta).toEqual({
      status: "draft",
      createdAt: "2026-10-21T08:00:00.000Z",
      createdBy: "admin-uid-1",
      publishedAt: null,
      publishedBy: null,
    });
  });

  it("no acepta un actor vacío", () => {
    expect(() => draftMetadata(now, "")).toThrowError(/sesión/i);
  });
});
