import { describe, expect, it } from "vitest";
import {
  UPLOAD_PART_BYTES,
  assertDeclaredBytes,
  assertPageCountDeclared,
  assertPartIndex,
  assertPartLength,
  assertPdfHeader,
  assertSha256Hex,
  assertUploadComplete,
  assertUploadId,
  hasPdfHeader,
  partOrderAction,
  uploadIdentityMaterial,
  uploadPartCount,
  uploadPartLength,
  uploadProgress,
} from "@/domain/storage/pdf-upload";
import { CHUNK_BYTES, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";

/**
 * SUBIDA POR PARTES: REGLAS DE DOMINIO
 * ====================================
 *
 * Lo que se fija aquí no depende de Firestore ni del navegador: tamaño de cada
 * parte, orden, progreso, firma del PDF, forma de la huella y del identificador.
 */

function codes(run: () => unknown): string {
  try {
    run();
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? "SIN_CODIGO";
  }
}

function pdf(size: number, headerOffset = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(0x41);
  const header = "%PDF-1.7";
  for (let index = 0; index < header.length; index += 1) {
    bytes[headerOffset + index] = header.charCodeAt(index);
  }
  return bytes;
}

describe("límites declarados", () => {
  it("rechaza tamaño cero y acepta el máximo exacto", () => {
    expect(codes(() => assertDeclaredBytes(0))).toBe("PDF_EMPTY");
    expect(codes(() => assertDeclaredBytes(-1))).toBe("PDF_EMPTY");
    expect(codes(() => assertDeclaredBytes(1.5))).toBe("PDF_EMPTY");
    expect(assertDeclaredBytes(MAX_PDF_BYTES)).toBe(MAX_PDF_BYTES);
    expect(codes(() => assertDeclaredBytes(MAX_PDF_BYTES + 1))).toBe("PDF_TOO_LARGE");
  });

  it("exige una huella SHA-256 hexadecimal de 64 caracteres", () => {
    const valid = "a".repeat(64);
    expect(assertSha256Hex(valid)).toBe(valid);
    expect(codes(() => assertSha256Hex("A".repeat(64)))).toBe("PDF_SHA256_INVALID");
    expect(codes(() => assertSha256Hex("a".repeat(63)))).toBe("PDF_SHA256_INVALID");
    expect(codes(() => assertSha256Hex(undefined))).toBe("PDF_SHA256_INVALID");
  });

  it("el número de páginas es declarado, positivo y no supera los bytes", () => {
    expect(assertPageCountDeclared(3, 1000)).toBe(3);
    expect(codes(() => assertPageCountDeclared(0, 1000))).toBe("DOCUMENT_PAGE_COUNT_INVALID");
    expect(codes(() => assertPageCountDeclared(5001, 100_000))).toBe(
      "DOCUMENT_PAGE_COUNT_INVALID",
    );
    // Más páginas que bytes dejaría rebanadas vacías: la secuencia sería trivial.
    expect(codes(() => assertPageCountDeclared(1000, 10))).toBe("PDF_PAGES_EXCEED_BYTES");
  });

  it("los identificadores son los que emite el servidor", () => {
    const id = `doc_${"a".repeat(32)}`;
    expect(assertUploadId(id)).toBe(id);
    expect(codes(() => assertUploadId("doc-tema-1"))).toBe("UPLOAD_ID_INVALID");
    expect(codes(() => assertUploadId("doc_" + "z".repeat(32)))).toBe("UPLOAD_ID_INVALID");
    expect(codes(() => assertUploadId(undefined))).toBe("UPLOAD_ID_INVALID");
  });

  it("el material de identidad une destino y contenido", () => {
    const base = { courseId: "curso-a", version: 1, topicId: "tema-1", sha256: "a".repeat(64), bytes: 10 };
    expect(uploadIdentityMaterial(base)).toBe(`curso-a|1|tema-1|10|${"a".repeat(64)}`);
    expect(uploadIdentityMaterial({ ...base, bytes: 11 })).not.toBe(uploadIdentityMaterial(base));
  });
});

describe("partes: tamaño y orden", () => {
  it("la parte mide un fragmento de almacenamiento y la última puede ser corta", () => {
    expect(UPLOAD_PART_BYTES).toBe(CHUNK_BYTES);

    const exact = UPLOAD_PART_BYTES * 3;
    expect(uploadPartCount(exact)).toBe(3);
    expect(uploadPartLength(exact, 2)).toBe(UPLOAD_PART_BYTES);

    const withTail = UPLOAD_PART_BYTES * 2 + 10;
    expect(uploadPartCount(withTail)).toBe(3);
    expect(uploadPartLength(withTail, 2)).toBe(10);
    expect(uploadPartLength(withTail, 1)).toBe(UPLOAD_PART_BYTES);
  });

  it("rechaza índices fuera de rango y tamaños que no son los suyos", () => {
    const bytes = UPLOAD_PART_BYTES + 5;
    expect(codes(() => assertPartIndex(bytes, 2))).toBe("PDF_CHUNK_INDEX_INVALID");
    expect(codes(() => assertPartIndex(bytes, -1))).toBe("PDF_CHUNK_INDEX_INVALID");
    expect(codes(() => assertPartIndex(bytes, 1.5))).toBe("PDF_CHUNK_INDEX_INVALID");
    expect(assertPartIndex(bytes, 1)).toBe(1);

    expect(codes(() => assertPartLength(bytes, 0, 5))).toBe("PDF_CHUNK_SIZE_INVALID");
    expect(codes(() => assertPartLength(bytes, 1, UPLOAD_PART_BYTES))).toBe(
      "PDF_CHUNK_SIZE_INVALID",
    );
    expect(codes(() => assertPartLength(bytes, 0, 0))).toBe("PDF_CHUNK_SIZE_INVALID");
    expect(() => assertPartLength(bytes, 0, UPLOAD_PART_BYTES)).not.toThrow();
    expect(() => assertPartLength(bytes, 1, 5)).not.toThrow();
  });

  it("las partes se aceptan en orden y el reenvío es un reintento", () => {
    expect(partOrderAction(0, 0, 3)).toBe("write");
    expect(partOrderAction(1, 1, 3)).toBe("write");
    // Reenviar una ya guardada no es error: el servicio comprobará el contenido.
    expect(partOrderAction(2, 0, 3)).toBe("retry");
    expect(partOrderAction(2, 1, 3)).toBe("retry");
    // Adelantarse sí lo es.
    expect(codes(() => partOrderAction(0, 1, 3))).toBe("PDF_CHUNK_OUT_OF_ORDER");
    expect(codes(() => partOrderAction(1, 3, 3))).toBe("PDF_CHUNK_OUT_OF_ORDER");
  });

  it("el progreso cuenta partes y bytes sin redondear a la ligera", () => {
    const bytes = UPLOAD_PART_BYTES * 2 + 10;
    expect(uploadProgress(bytes, 0)).toEqual({
      partsTotal: 3,
      partsReceived: 0,
      bytesReceived: 0,
      percent: 0,
    });
    expect(uploadProgress(bytes, 2)).toMatchObject({
      partsReceived: 2,
      bytesReceived: UPLOAD_PART_BYTES * 2,
      percent: 99,
    });
    expect(uploadProgress(bytes, 3)).toMatchObject({ percent: 100, bytesReceived: bytes });
    // Nunca por encima de lo declarado, aunque llegue un valor absurdo.
    expect(uploadProgress(bytes, 99)).toMatchObject({ partsReceived: 3, percent: 100 });
  });

  it("no se finaliza con partes ausentes", () => {
    const bytes = UPLOAD_PART_BYTES * 2 + 10;
    expect(codes(() => assertUploadComplete(bytes, 2))).toBe("PDF_UPLOAD_INCOMPLETE");
    expect(() => assertUploadComplete(bytes, 3)).not.toThrow();
  });
});

describe("firma del PDF", () => {
  it("acepta la cabecera al principio y tras bytes de relleno", () => {
    expect(hasPdfHeader(pdf(100))).toBe(true);
    expect(hasPdfHeader(pdf(100, 8))).toBe(true);
    expect(() => assertPdfHeader(pdf(100))).not.toThrow();
  });

  it("rechaza HTML, vacío y basura: el nombre y el MIME no cuentan", () => {
    expect(hasPdfHeader(new TextEncoder().encode("<html>no soy un pdf</html>"))).toBe(false);
    expect(codes(() => assertPdfHeader(new TextEncoder().encode("<html>")))).toBe(
      "PDF_SIGNATURE_INVALID",
    );
    expect(codes(() => assertPdfHeader(new Uint8Array(0)))).toBe("PDF_EMPTY");
    // Con la cabecera más allá del primer KiB tampoco se acepta.
    expect(hasPdfHeader(pdf(2000, 1200))).toBe(false);
  });
});
