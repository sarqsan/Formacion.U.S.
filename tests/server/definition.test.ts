import { describe, expect, it } from "vitest";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import { definitionFromDocuments } from "@/server/courses/definition";
import { toAnswerKeys, toPublicVersion } from "@/server/courses/catalog";

/**
 * IDA Y VUELTA DEL CONTENIDO
 * ==========================
 *
 * El contenido publicado se guarda en dos documentos: la versión (sin
 * respuestas) y las claves (solo servidor). Para editar un borrador hay que
 * recomponer la definición original. Esta prueba comprueba que recomponer no
 * pierde ni inventa nada: si se perdiera una clave, publicar un borrador
 * corregido dejaría preguntas sin respuesta correcta.
 */

const DEFINITION: CourseVersionDefinition = {
  courseId: "curso-prueba",
  version: 2,
  title: "Curso de prueba",
  description: "Contenido sintético",
  topics: [
    {
      id: "tema-1",
      title: "Primer tema",
      order: 1,
      mandatory: true,
      documents: [
        { id: "doc-1", title: "Documento uno", pageCount: 3 },
        { id: "doc-2", title: "Documento dos", pageCount: 1 },
      ],
      quiz: [
        { id: "q-1", type: "single_choice", optionIds: ["a", "b"], correctOptionIds: ["b"] },
        { id: "q-2", type: "multi_choice", optionIds: ["a", "b", "c"], correctOptionIds: ["a", "c"] },
      ],
    },
  ],
  finalExam: [{ id: "qf-1", type: "single_choice", optionIds: ["a", "b"], correctOptionIds: ["a"] }],
};

const META = { createdAt: "2026-01-01T00:00:00.000Z", createdBy: "admin-1", status: "draft" as const };

describe("definitionFromDocuments", () => {
  it("reconstruye la definición exacta desde versión + claves", () => {
    const version = toPublicVersion(DEFINITION, META);
    const keys = toAnswerKeys(DEFINITION, { createdAt: META.createdAt });

    const rebuilt = definitionFromDocuments(version, keys);

    expect(rebuilt.courseId).toBe(DEFINITION.courseId);
    expect(rebuilt.version).toBe(DEFINITION.version);
    expect(rebuilt.title).toBe(DEFINITION.title);
    expect(rebuilt.topics.map((topic) => topic.id)).toEqual(["tema-1"]);
    expect(rebuilt.topics[0].documents).toEqual(DEFINITION.topics[0].documents);
    expect(rebuilt.topics[0].quiz.map((question) => question.correctOptionIds)).toEqual([
      ["b"],
      ["a", "c"],
    ]);
    expect(rebuilt.finalExam[0].correctOptionIds).toEqual(["a"]);
  });

  it("no deja claves en el documento público", () => {
    const version = toPublicVersion(DEFINITION, META);
    expect(JSON.stringify(version)).not.toContain("correctOptionIds");
  });

  it("si faltan claves, devuelve listas vacías en lugar de inventarlas", () => {
    const version = toPublicVersion(DEFINITION, META);
    const rebuilt = definitionFromDocuments(version, {
      courseId: DEFINITION.courseId,
      version: DEFINITION.version,
      quizByTopic: {},
      finalExam: [],
      createdAt: META.createdAt,
    });

    expect(rebuilt.topics[0].quiz[0].correctOptionIds).toEqual([]);
    expect(rebuilt.finalExam[0].correctOptionIds).toEqual([]);
  });
});
