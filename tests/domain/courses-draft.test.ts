import { describe, expect, it } from "vitest";
import { validateCourseVersion } from "@/domain/courses/content";
import {
  DRAFT_LIMITS,
  checkDraftStructure,
  jsonByteLength,
  normalizeTopicOrder,
  reviewDraft,
} from "@/domain/courses/draft";
import { makeDefinition, makeTopic } from "../helpers/db-doubles";

/**
 * ESTRUCTURA DEL BORRADOR: GUARDAR NO ES PUBLICAR
 * ===============================================
 *
 * Tres niveles, tres pruebas distintas:
 *
 *   1. `checkDraftStructure` bloquea el guardado, y **solo** por forma
 *      (identificadores, longitudes, coherencia interna);
 *   2. `reviewDraft` señala lo que impide publicar, sin bloquear;
 *   3. `validateCourseVersion` sigue siendo la puerta dura y no se ha tocado.
 *
 * El caso que más importa: un borrador **vacío o incompleto** no genera ningún
 * error de estructura, así que se puede guardar. Si alguien «arreglase» eso
 * metiendo requisitos de contenido en el nivel 1, estas pruebas fallan.
 */

const codes = (issues: ReadonlyArray<{ code: string }>) => issues.map((issue) => issue.code);

describe("checkDraftStructure: qué impide guardar", () => {
  it("un borrador vacío (sin temas ni examen) es estructuralmente válido", () => {
    const empty = makeDefinition({ topics: [], finalExam: [], description: undefined });

    expect(checkDraftStructure(empty)).toEqual([]);
  });

  it("acepta un borrador incompleto: temas sin documento ni cuestionario", () => {
    const partial = makeDefinition({
      topics: [makeTopic({ id: "tema-1", documents: [], quiz: [] })],
      finalExam: [],
    });

    expect(checkDraftStructure(partial)).toEqual([]);
    // Pero sí hay avisos: se ve que falta, sin impedir guardar.
    expect(reviewDraft(partial, validateCourseVersion(partial)).length).toBeGreaterThan(0);
  });

  it("exige título de curso y lo acota a 200 caracteres", () => {
    expect(codes(checkDraftStructure(makeDefinition({ title: "   " })))).toContain(
      "COURSE_TITLE_REQUIRED",
    );
    expect(
      codes(checkDraftStructure(makeDefinition({ title: "x".repeat(DRAFT_LIMITS.courseTitle + 1) }))),
    ).toContain("COURSE_TITLE_TOO_LONG");
    expect(
      checkDraftStructure(makeDefinition({ title: "x".repeat(DRAFT_LIMITS.courseTitle) })),
    ).toEqual([]);
  });

  it("acota la descripción a 500 caracteres", () => {
    expect(
      codes(
        checkDraftStructure(
          makeDefinition({ description: "d".repeat(DRAFT_LIMITS.courseDescription + 1) }),
        ),
      ),
    ).toContain("COURSE_DESCRIPTION_TOO_LONG");
  });

  it("rechaza identificadores de tema repetidos, vacíos o con formato inválido", () => {
    const duplicated = makeDefinition({
      topics: [makeTopic({ id: "tema-1", order: 1 }), makeTopic({ id: "tema-1", order: 2 })],
    });
    expect(codes(checkDraftStructure(duplicated))).toContain("TOPIC_ID_DUPLICATED");

    const invalid = makeDefinition({ topics: [makeTopic({ id: "Tema Con Espacios" })] });
    expect(codes(checkDraftStructure(invalid))).toContain("TOPIC_ID_INVALID");
  });

  it("rechaza órdenes no enteros, repetidos o menores que 1", () => {
    const repeated = makeDefinition({
      topics: [makeTopic({ id: "tema-1", order: 1 }), makeTopic({ id: "tema-2", order: 1 })],
    });
    expect(codes(checkDraftStructure(repeated))).toContain("TOPIC_ORDER_DUPLICATED");

    const zero = makeDefinition({ topics: [makeTopic({ id: "tema-1", order: 0 })] });
    expect(codes(checkDraftStructure(zero))).toContain("TOPIC_ORDER_INVALID");
  });

  it("exige título de tema y valida que `mandatory` sea booleano", () => {
    const noTitle = makeDefinition({ topics: [makeTopic({ id: "tema-1", title: "  " })] });
    expect(codes(checkDraftStructure(noTitle))).toContain("TOPIC_TITLE_REQUIRED");

    const notBoolean = makeDefinition({
      topics: [makeTopic({ id: "tema-1", mandatory: "sí" as unknown as boolean })],
    });
    expect(codes(checkDraftStructure(notBoolean))).toContain("TOPIC_MANDATORY_INVALID");
  });

  it("limita el número de temas a 50", () => {
    const topics = Array.from({ length: DRAFT_LIMITS.topics + 1 }, (_, index) =>
      makeTopic({ id: `tema-${index + 1}`, order: index + 1 }),
    );
    expect(codes(checkDraftStructure(makeDefinition({ topics })))).toContain(
      "COURSE_TOO_MANY_TOPICS",
    );
  });

  it("no valida contenido: no exige cuestionario, documento ni examen final", () => {
    const partial = makeDefinition({
      topics: [makeTopic({ id: "tema-1", documents: [], quiz: [], mandatory: true })],
      finalExam: [],
    });

    const structureCodes = codes(checkDraftStructure(partial));
    expect(structureCodes).not.toContain("TOPIC_QUIZ_REQUIRED");
    expect(structureCodes).not.toContain("FINAL_EXAM_REQUIRED");
    // Y la puerta de publicación sí los exige (no se ha relajado).
    expect(codes(validateCourseVersion(partial))).toEqual(
      expect.arrayContaining(["TOPIC_QUIZ_REQUIRED", "FINAL_EXAM_REQUIRED"]),
    );
  });
});

describe("reviewDraft: avisos que no bloquean", () => {
  it("convierte los problemas de publicación en avisos", () => {
    const definition = makeDefinition({ topics: [], finalExam: [] });
    const warnings = reviewDraft(definition, validateCourseVersion(definition));

    expect(warnings.every((issue) => issue.severity === "warning")).toBe(true);
    expect(codes(warnings)).toContain("COURSE_NO_TOPICS");
    expect(codes(warnings)).toContain("FINAL_EXAM_EMPTY");
  });

  it("señala temas sin documento y sin cuestionario, con su ruta", () => {
    const definition = makeDefinition({
      topics: [makeTopic({ id: "tema-1", documents: [], quiz: [] })],
    });
    const warnings = reviewDraft(definition, validateCourseVersion(definition));

    const documents = warnings.find((issue) => issue.code === "TOPIC_WITHOUT_DOCUMENTS");
    const quiz = warnings.find((issue) => issue.code === "TOPIC_WITHOUT_QUIZ");

    expect(documents?.path).toBe("topics[0].documents");
    expect(quiz?.path).toBe("topics[0].quiz");
    expect(documents?.message).toContain("tema-1");
  });

  it("un curso completo no genera avisos", () => {
    const complete = makeDefinition();
    expect(reviewDraft(complete, validateCourseVersion(complete))).toEqual([]);
  });
});

describe("normalizeTopicOrder: orden determinista", () => {
  it("reindexa de 1 a n sin huecos, conservando el orden pedido", () => {
    const topics = [
      makeTopic({ id: "tercero", order: 30 }),
      makeTopic({ id: "primero", order: 10 }),
      makeTopic({ id: "segundo", order: 20 }),
    ];

    expect(normalizeTopicOrder(topics).map((topic) => [topic.id, topic.order])).toEqual([
      ["primero", 1],
      ["segundo", 2],
      ["tercero", 3],
    ]);
  });

  it("resuelve empates por identificador: dos guardados iguales dan el mismo resultado", () => {
    const a = makeTopic({ id: "b-tema", order: 1 });
    const b = makeTopic({ id: "a-tema", order: 1 });

    const forward = normalizeTopicOrder([a, b]).map((topic) => topic.id);
    const backward = normalizeTopicOrder([b, a]).map((topic) => topic.id);

    expect(forward).toEqual(["a-tema", "b-tema"]);
    expect(backward).toEqual(forward);
  });

  it("no muta la lista original", () => {
    const topics = [makeTopic({ id: "a", order: 5 }), makeTopic({ id: "b", order: 3 })];
    normalizeTopicOrder(topics);
    expect(topics.map((topic) => topic.order)).toEqual([5, 3]);
  });
});

describe("jsonByteLength", () => {
  it("mide UTF-8 real, no longitud de cadena", () => {
    expect(jsonByteLength("á")).toBe(4); // comillas + 2 bytes
    expect(jsonByteLength("a")).toBe(3);
  });

  it("el tope de definición deja margen bajo el 1 MiB por documento de Firestore", () => {
    expect(DRAFT_LIMITS.definitionBytes).toBeLessThan(1024 * 1024);
  });
});
