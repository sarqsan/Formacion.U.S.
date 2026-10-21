import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  DEFAULT_BUDGET_BYTES,
  FIRESTORE_MAX_DOCUMENT_BYTES,
  FREE_TIER_STORAGE_BYTES,
  HARD_MAX_BUDGET_BYTES,
  MAX_CHUNKS,
  MAX_PDF_BYTES,
  MAX_RANGE_BYTES,
  MAX_TRANSACTION_BYTES,
  STORAGE_RESERVE_BYTES,
  TRANSACTION_SAFETY_BYTES,
  assertFitsBudget,
  assertPageCount,
  assertPdfBytes,
  budgetBytesFromMiB,
  chunkCount,
  chunkLength,
  chunkRange,
  chunksForRange,
  formatBytes,
} from "@/domain/storage/pdf-chunks";
import { DomainError } from "@/domain/text";

/** PDF mínimo válido (solo la cabecera importa para la comprobación). */
function fakePdf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const header = "%PDF-1.7\n";
  for (let index = 0; index < header.length; index += 1) {
    bytes[index] = header.charCodeAt(index);
  }
  return bytes;
}

describe("límites del almacenamiento en Firestore", () => {
  it("cada fragmento contiene un documento de Firestore", () => {
    // En base64 un fragmento ocuparía justo 1 MiB: cero margen para el
    // envoltorio del documento, así que se guarda como Bytes.
    expect(Math.ceil(CHUNK_BYTES / 3) * 4).toBe(FIRESTORE_MAX_DOCUMENT_BYTES);
    expect(CHUNK_BYTES).toBeLessThan(FIRESTORE_MAX_DOCUMENT_BYTES);
  });

  it("el presupuesto por defecto y el máximo caben en la cuota gratuita", () => {
    expect(FREE_TIER_STORAGE_BYTES).toBe(1024 * 1024 * 1024);
    expect(DEFAULT_BUDGET_BYTES).toBeLessThan(HARD_MAX_BUDGET_BYTES);
    expect(HARD_MAX_BUDGET_BYTES + STORAGE_RESERVE_BYTES).toBe(FREE_TIER_STORAGE_BYTES);
    expect(DEFAULT_BUDGET_BYTES).toBe(512 * 1024 * 1024);
  });

  it("un PDF máximo cabe en una sola transacción de Firestore (10 MiB)", () => {
    // Fase 6: el tope bajó de 20 MiB a 8 MiB. Con 27 fragmentos el documento
    // (20,25 MiB) no cabía en la transacción y la subida fallaba siempre.
    expect(MAX_PDF_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CHUNKS).toBe(11);
    expect(MAX_CHUNKS * CHUNK_BYTES + TRANSACTION_SAFETY_BYTES).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    );
    // El límite de 500 escrituras por transacción se retiró; aun así, sobra margen.
    expect(MAX_CHUNKS + 3).toBeLessThan(500);
  });
});

describe("troceado", () => {
  it("calcula cuántos fragmentos hacen falta", () => {
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(MAX_PDF_BYTES)).toBe(MAX_CHUNKS);
  });

  it("el último fragmento puede ser más corto", () => {
    const size = CHUNK_BYTES + 10;
    expect(chunkLength(size, 0)).toBe(CHUNK_BYTES);
    expect(chunkLength(size, 1)).toBe(10);
    expect(chunkRange(size, 1)).toEqual({ from: CHUNK_BYTES, to: CHUNK_BYTES + 10 });
  });

  it("la suma de fragmentos es exactamente el fichero", () => {
    for (const size of [1, 100, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES + 77]) {
      const total = Array.from({ length: chunkCount(size) }, (_, index) =>
        chunkLength(size, index),
      ).reduce((sum, value) => sum + value, 0);
      expect(total, `tamaño ${size}`).toBe(size);
    }
  });

  it("rechaza índices fuera de rango", () => {
    expect(() => chunkLength(100, 1)).toThrowError(
      expect.objectContaining({ code: "PDF_CHUNK_INDEX_INVALID" }),
    );
    expect(() => chunkLength(100, -1)).toThrow(DomainError);
  });

  it("rechaza ficheros vacíos o por encima del tope", () => {
    expect(() => chunkCount(0)).toThrowError(
      expect.objectContaining({ code: "PDF_EMPTY" }),
    );
    expect(() => chunkCount(MAX_PDF_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: "PDF_TOO_LARGE" }),
    );
  });

  it("rechaza rangos inválidos o demasiado grandes", () => {
    expect(() => chunksForRange(100, 10, 10)).toThrow(DomainError);
    expect(() => chunksForRange(100, -1, 10)).toThrow(DomainError);
    expect(() => chunksForRange(100, 0, 101)).toThrow(DomainError);
    expect(() => chunksForRange(MAX_PDF_BYTES, 0, MAX_RANGE_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: "PDF_RANGE_TOO_LARGE" }),
    );
  });

  it("un rango a caballo entre dos fragmentos pide los dos", () => {
    expect(chunksForRange(CHUNK_BYTES * 2, CHUNK_BYTES - 5, CHUNK_BYTES + 5)).toEqual([0, 1]);
    expect(chunksForRange(CHUNK_BYTES * 2, 0, 10)).toEqual([0]);
    expect(chunksForRange(CHUNK_BYTES * 2, CHUNK_BYTES * 2 - 1, CHUNK_BYTES * 2)).toEqual([1]);
  });
});

describe("validación del fichero subido", () => {
  it("acepta un PDF con cabecera correcta", () => {
    expect(() => assertPdfBytes(fakePdf(2048))).not.toThrow();
  });

  it("rechaza ficheros que no son PDF (aunque se llamen .pdf)", () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(() => assertPdfBytes(html)).toThrowError(
      expect.objectContaining({ code: "PDF_SIGNATURE_INVALID" }),
    );
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(() => assertPdfBytes(zip)).toThrow(DomainError);
  });

  it("rechaza ficheros vacíos y demasiado grandes", () => {
    expect(() => assertPdfBytes(new Uint8Array(0))).toThrow(DomainError);
    expect(() => assertPdfBytes(fakePdf(MAX_PDF_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: "PDF_TOO_LARGE" }),
    );
  });

  it("acepta un PDF con basura antes de la cabecera (permitido por la especificación)", () => {
    const bytes = new Uint8Array(100);
    bytes.set(new TextEncoder().encode("basura"), 0);
    bytes.set(new TextEncoder().encode("%PDF-1.4"), 20);
    expect(() => assertPdfBytes(bytes)).not.toThrow();
  });

  it("valida el número de páginas", () => {
    expect(() => assertPageCount(1)).not.toThrow();
    expect(() => assertPageCount(5000)).not.toThrow();
    expect(() => assertPageCount(0)).toThrow(DomainError);
    expect(() => assertPageCount(5001)).toThrow(DomainError);
    expect(() => assertPageCount(1.5)).toThrow(DomainError);
  });
});

describe("presupuesto", () => {
  it("convierte MiB a bytes y acota el máximo", () => {
    expect(budgetBytesFromMiB(100)).toBe(100 * 1024 * 1024);
    expect(budgetBytesFromMiB(undefined)).toBe(DEFAULT_BUDGET_BYTES);
    expect(budgetBytesFromMiB(0)).toBe(DEFAULT_BUDGET_BYTES);
    expect(budgetBytesFromMiB(100_000)).toBe(HARD_MAX_BUDGET_BYTES);
  });

  it("rechaza un documento que no cabe en el presupuesto", () => {
    expect(() =>
      assertFitsBudget({ usedBytes: 0, newBytes: 10, budgetBytes: 100 }),
    ).not.toThrow();
    expect(() =>
      assertFitsBudget({ usedBytes: 95, newBytes: 10, budgetBytes: 100 }),
    ).toThrowError(expect.objectContaining({ code: "STORAGE_BUDGET_EXCEEDED" }));
  });

  it("formatea tamaños para los mensajes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
