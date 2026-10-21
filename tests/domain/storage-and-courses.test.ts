import { describe, expect, it } from "vitest";
import {
  assertPublishable,
  isVersionCompletable,
  nextVersionNumber,
  requiresNewCompletion,
  type CourseVersionSummary,
} from "@/domain/courses/versioning";
import {
  mandatoryTopicIds,
  validateCourseVersion,
  type CourseVersionDefinition,
} from "@/domain/courses/content";

describe("versionado", () => {
  const versions = (input: Array<[number, CourseVersionSummary["status"]]>): CourseVersionSummary[] =>
    input.map(([version, status]) => ({ version, status }));

  it("calcula la siguiente versión", () => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber(versions([[1, "published"]]))).toBe(2);
    expect(nextVersionNumber(versions([[1, "archived"], [3, "published"]]))).toBe(4);
  });

  it("la primera publicación debe ser la v1", () => {
    expect(() => assertPublishable(versions([[1, "draft"]]), 1)).not.toThrow();
    expect(() => assertPublishable(versions([[2, "draft"]]), 2)).toThrowError(
      expect.objectContaining({ code: "VERSION_MUST_START_AT_ONE" }),
    );
  });

  it("solo publica la versión inmediatamente siguiente", () => {
    const state = versions([[1, "published"], [2, "draft"], [3, "draft"]]);
    expect(() => assertPublishable(state, 2)).not.toThrow();
    expect(() => assertPublishable(state, 3)).toThrowError(
      expect.objectContaining({ code: "VERSION_OUT_OF_ORDER" }),
    );
  });

  it("no republica ni archiva versiones", () => {
    expect(() => assertPublishable(versions([[1, "published"]]), 1)).toThrowError(
      expect.objectContaining({ code: "VERSION_ALREADY_PUBLISHED" }),
    );
    expect(() => assertPublishable(versions([[1, "archived"], [2, "draft"]]), 1)).toThrowError(
      expect.objectContaining({ code: "VERSION_ARCHIVED" }),
    );
  });

  it("obliga a repetir el curso cuando hay versión nueva", () => {
    expect(requiresNewCompletion(null, 1)).toBe(true);
    expect(requiresNewCompletion(1, 1)).toBe(false);
    expect(requiresNewCompletion(1, 2)).toBe(true);
    expect(requiresNewCompletion(2, 1)).toBe(false);
  });

  it("solo se completa la versión publicada", () => {
    const state = versions([[1, "published"], [2, "draft"]]);
    expect(isVersionCompletable(state, 1)).toBe(true);
    expect(isVersionCompletable(state, 2)).toBe(false);
  });
});

describe("validación de contenido", () => {
  const base: CourseVersionDefinition = {
    courseId: "curso-a",
    version: 1,
    title: "Curso A",
    topics: [
      {
        id: "tema-1",
        title: "Tema 1",
        order: 1,
        mandatory: true,
        documents: [{ id: "doc-1", title: "Doc 1", pageCount: 10 }],
        quiz: [
          { id: "q1", type: "single_choice", optionIds: ["a", "b"], correctOptionIds: ["a"] },
        ],
      },
    ],
    finalExam: [
      { id: "f1", type: "single_choice", optionIds: ["a", "b"], correctOptionIds: ["b"] },
    ],
  };

  it("acepta un curso coherente", () => {
    expect(validateCourseVersion(base)).toEqual([]);
    expect(mandatoryTopicIds(base)).toEqual(["tema-1"]);
  });

  it("exige cuestionario en temas obligatorios", () => {
    const invalid = {
      ...base,
      topics: [{ ...base.topics[0], quiz: [] }],
    };
    expect(validateCourseVersion(invalid).map((i) => i.code)).toContain("TOPIC_QUIZ_REQUIRED");
  });

  it("exige examen final", () => {
    expect(validateCourseVersion({ ...base, finalExam: [] }).map((i) => i.code)).toContain(
      "FINAL_EXAM_REQUIRED",
    );
  });

  it("detecta órdenes repetidos y con huecos", () => {
    const duplicated = {
      ...base,
      topics: [
        base.topics[0],
        { ...base.topics[0], id: "tema-2", title: "Tema 2", documents: [] },
      ],
    };
    const codes = validateCourseVersion(duplicated).map((i) => i.code);
    expect(codes).toContain("TOPIC_ORDER_DUPLICATED");
    expect(codes).toContain("TOPIC_ORDER_GAP");
  });

  it("detecta documentos repetidos entre temas", () => {
    const withTwoTopics = {
      ...base,
      topics: [
        base.topics[0],
        {
          ...base.topics[0],
          id: "tema-2",
          title: "Tema 2",
          order: 2,
          documents: [{ id: "doc-1", title: "Doc 1 bis", pageCount: 5 }],
        },
      ],
    };
    expect(validateCourseVersion(withTwoTopics).map((i) => i.code)).toContain(
      "DOCUMENT_ID_DUPLICATED",
    );
  });

  it("exige al menos un tema obligatorio", () => {
    const optional = { ...base, topics: [{ ...base.topics[0], mandatory: false }] };
    expect(validateCourseVersion(optional).map((i) => i.code)).toContain(
      "COURSE_NO_MANDATORY_TOPICS",
    );
  });

  it("exige número de páginas válido", () => {
    const invalid = {
      ...base,
      topics: [{ ...base.topics[0], documents: [{ id: "doc-1", title: "Doc", pageCount: 0 }] }],
    };
    expect(validateCourseVersion(invalid).map((i) => i.code)).toContain(
      "DOCUMENT_PAGE_COUNT_INVALID",
    );
  });

  it("propaga errores del cuestionario", () => {
    const invalid = {
      ...base,
      topics: [
        { ...base.topics[0], quiz: [{ ...base.topics[0].quiz[0], correctOptionIds: ["zzz"] }] },
      ],
    };
    expect(validateCourseVersion(invalid).map((i) => i.code)).toContain("TOPIC_QUIZ_INVALID");
  });
});
