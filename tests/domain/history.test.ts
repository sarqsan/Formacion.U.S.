import { describe, expect, it } from "vitest";
import {
  sortHistory,
  summarizeArchived,
  type ArchivedProgressView,
} from "@/domain/progress/history";

/**
 * HISTÓRICO: RESUMEN Y ORDEN (modelo puro)
 * =======================================
 *
 * Lo que se prueba aquí es la parte que no depende de Firestore ni de la
 * demostración: qué cifras se enseñan de una versión archivada y en qué orden.
 * Si esto está bien, ambos portales enseñan lo mismo.
 */

function archived(overrides: Partial<ArchivedProgressView> = {}): ArchivedProgressView {
  return {
    courseId: "curso-a",
    version: 1,
    mandatoryTopicIds: ["tema-1", "tema-2"],
    topics: {
      "tema-1": { passed: true, bestScore: 100 },
      "tema-2": { passed: false, bestScore: 60 },
    },
    finalExam: { passed: false, bestScore: 50 },
    completedAt: null,
    archivedAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeArchived", () => {
  it("cuenta solo los temas obligatorios superados", () => {
    const summary = summarizeArchived(archived());

    expect(summary.topicsPassed).toBe(1);
    expect(summary.topicsTotal).toBe(2);
    expect(summary.finalScore).toBe(50);
    expect(summary.finalExamPassed).toBe(false);
  });

  it("no cuenta dos veces un tema repetido en la lista obligatoria", () => {
    const summary = summarizeArchived(archived({ mandatoryTopicIds: ["tema-1", "tema-1"] }));

    expect(summary.topicsTotal).toBe(1);
    expect(summary.topicsPassed).toBe(1);
  });

  it("marca completado por la fecha de finalización, no recalculando", () => {
    // Aunque hoy falte algo, si la versión archivada se cerró, se cerró.
    const summary = summarizeArchived(
      archived({
        completedAt: "2026-01-15T09:00:00.000Z",
        topics: { "tema-1": { passed: false, bestScore: 0 } },
      }),
    );

    expect(summary.completed).toBe(true);
    expect(summary.completedAt).toBe("2026-01-15T09:00:00.000Z");
  });

  it("un curso archivado a medias se resume como incompleto y se dice", () => {
    const summary = summarizeArchived(archived());

    expect(summary.completed).toBe(false);
    expect(summary.completedAt).toBeNull();
    expect(summary.archivedAt).toBe("2026-02-01T10:00:00.000Z");
  });
});

describe("sortHistory", () => {
  it("ordena por fecha de finalización o archivo, lo más reciente primero", () => {
    const ordered = sortHistory([
      { courseId: "curso-a", version: 1, completedAt: "2026-01-01T00:00:00.000Z", archivedAt: null },
      { courseId: "curso-b", version: 1, completedAt: null, archivedAt: "2026-03-01T00:00:00.000Z" },
      { courseId: "curso-c", version: 1, completedAt: "2026-02-01T00:00:00.000Z", archivedAt: null },
    ]);

    expect(ordered.map((entry) => entry.courseId)).toEqual(["curso-b", "curso-c", "curso-a"]);
  });

  it("con la misma fecha desempata por versión descendente y luego por curso", () => {
    const ordered = sortHistory([
      { courseId: "curso-b", version: 1, completedAt: null, archivedAt: null },
      { courseId: "curso-a", version: 1, completedAt: null, archivedAt: null },
      { courseId: "curso-a", version: 2, completedAt: null, archivedAt: null },
    ]);

    expect(ordered.map((entry) => `${entry.courseId}@v${entry.version}`)).toEqual([
      "curso-a@v2",
      "curso-a@v1",
      "curso-b@v1",
    ]);
  });

  it("no muta la colección recibida", () => {
    const input = [
      { courseId: "curso-a", version: 1, completedAt: null, archivedAt: "2026-01-01T00:00:00.000Z" },
      { courseId: "curso-b", version: 1, completedAt: null, archivedAt: "2026-02-01T00:00:00.000Z" },
    ];

    const ordered = sortHistory(input);

    expect(input.map((entry) => entry.courseId)).toEqual(["curso-a", "curso-b"]);
    expect(ordered.map((entry) => entry.courseId)).toEqual(["curso-b", "curso-a"]);
  });

  it("tolera fechas ilegibles sin romper el orden", () => {
    const ordered = sortHistory([
      { courseId: "curso-a", version: 1, completedAt: "no-es-una-fecha", archivedAt: null },
      { courseId: "curso-b", version: 1, completedAt: "2026-02-01T00:00:00.000Z", archivedAt: null },
    ]);

    expect(ordered.map((entry) => entry.courseId)).toEqual(["curso-b", "curso-a"]);
  });
});
