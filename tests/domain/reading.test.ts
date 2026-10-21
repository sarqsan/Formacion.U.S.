import { describe, expect, it } from "vitest";
import {
  assertCanViewPage,
  initDocumentProgress,
  isDocumentRead,
  isTopicFullyRead,
  nextAllowedPage,
  recordPageViewed,
} from "@/domain/progress/reading";
import { DomainError } from "@/domain/text";

const T0 = "2026-01-01T10:00:00.000Z";

describe("visualización secuencial", () => {
  it("empieza permitiendo solo la página 1", () => {
    const progress = initDocumentProgress("doc-1", 3);
    expect(nextAllowedPage(progress)).toBe(1);
    expect(() => assertCanViewPage(progress, 1)).not.toThrow();
    expect(() => assertCanViewPage(progress, 2)).toThrowError(
      expect.objectContaining({ code: "PAGE_OUT_OF_ORDER" }),
    );
  });

  it("avanza página a página y permite releer sin saltar", () => {
    let progress = initDocumentProgress("doc-1", 3);
    progress = recordPageViewed(progress, 1, T0);
    expect(progress.lastPageViewed).toBe(1);
    expect(nextAllowedPage(progress)).toBe(2);

    progress = recordPageViewed(progress, 1, T0); // releer es idempotente
    expect(progress.lastPageViewed).toBe(1);

    progress = recordPageViewed(progress, 2, T0);
    expect(progress.lastPageViewed).toBe(2);

    expect(() => recordPageViewed(progress, 4, T0)).toThrowError(
      expect.objectContaining({ code: "PAGE_OUT_OF_RANGE" }),
    );
  });

  it("marca el documento como leído al llegar a la última página", () => {
    let progress = initDocumentProgress("doc-1", 2);
    progress = recordPageViewed(progress, 1, T0);
    expect(isDocumentRead(progress)).toBe(false);
    expect(progress.completedAt).toBeNull();

    progress = recordPageViewed(progress, 2, T0);
    expect(isDocumentRead(progress)).toBe(true);
    expect(progress.completedAt).toBe(T0);

    const later = recordPageViewed(progress, 2, "2026-02-01T00:00:00.000Z");
    expect(later.completedAt).toBe(T0);
  });

  it("rechaza páginas no válidas", () => {
    const progress = initDocumentProgress("doc-1", 3);
    expect(() => assertCanViewPage(progress, 0)).toThrow(DomainError);
    expect(() => assertCanViewPage(progress, -1)).toThrow(DomainError);
    expect(() => assertCanViewPage(progress, 1.5)).toThrow(DomainError);
    expect(() => assertCanViewPage(progress, 4)).toThrowError(
      expect.objectContaining({ code: "PAGE_OUT_OF_RANGE" }),
    );
  });

  it("valida el número total de páginas", () => {
    expect(() => initDocumentProgress("doc-1", 0)).toThrow(DomainError);
    expect(() => initDocumentProgress("doc-1", 5001)).toThrow(DomainError);
  });
});

describe("isTopicFullyRead", () => {
  it("exige todos los documentos obligatorios completos", () => {
    const doc1 = recordPageViewed(initDocumentProgress("doc-1", 1), 1, T0);
    const doc2 = initDocumentProgress("doc-2", 2);

    expect(isTopicFullyRead(["doc-1"], { "doc-1": doc1 })).toBe(true);
    expect(isTopicFullyRead(["doc-1", "doc-2"], { "doc-1": doc1, "doc-2": doc2 })).toBe(false);
    expect(isTopicFullyRead(["doc-3"], { "doc-1": doc1 })).toBe(false);
  });

  it("un tema sin documentos no exige lectura", () => {
    expect(isTopicFullyRead([], {})).toBe(true);
  });
});
