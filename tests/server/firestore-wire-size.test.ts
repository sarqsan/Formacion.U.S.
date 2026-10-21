import { describe, expect, it } from "vitest";
import {
  FIRESTORE_MAX_DOCUMENT_BYTES,
  FIRESTORE_MAX_REQUEST_BYTES,
  measureUpload,
  referenceMeasurements,
} from "@/server/firestore/wire-size";
import { CHUNK_BYTES, MAX_CHUNKS, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";

/**
 * MEDIDA DEL PAYLOAD REAL (no aritmética)
 * =======================================
 *
 * Estas pruebas codifican el mismo mensaje que enviaría el SDK oficial y
 * comprueban los límites de Firestore sobre el resultado. Es una medida del
 * payload; **no** es una prueba contra Firestore ni contra su emulador.
 *
 * Lo que sí aporta: si alguien sube el tope de PDF, cambia el tamaño de
 * fragmento o añade campos a los metadatos, estas pruebas detectan que el
 * commit deja de caber antes de que falle en producción.
 */

const MB = 1024 * 1024;

describe("payload de una subida", () => {
  it("el documento más grande (un fragmento lleno) cabe en 1 MiB con margen", () => {
    const measured = measureUpload(MAX_PDF_BYTES);

    expect(measured.chunks).toBe(MAX_CHUNKS);
    expect(measured.largestChunkBytes).toBeGreaterThan(CHUNK_BYTES);
    expect(measured.largestChunkBytes).toBeLessThan(FIRESTORE_MAX_DOCUMENT_BYTES);
    // Margen real: más de 200 KiB por documento.
    expect(FIRESTORE_MAX_DOCUMENT_BYTES - measured.largestChunkBytes).toBeGreaterThan(200 * 1024);
    expect(measured.documentFits).toBe(true);
  });

  it("el commit completo del tope actual (8 MiB) cabe en 10 MiB con ~2 MiB de margen", () => {
    const measured = measureUpload(MAX_PDF_BYTES);

    expect(measured.requestFits).toBe(true);
    expect(measured.commitTotalBytes).toBeLessThan(FIRESTORE_MAX_REQUEST_BYTES);
    expect(measured.requestMarginBytes).toBeGreaterThan(2 * MB - 64 * 1024);
  });

  it("el diseño anterior (20 MiB, 27 fragmentos) NO cabía: el defecto era real", () => {
    const { previous } = referenceMeasurements();

    expect(previous.chunks).toBe(27);
    expect(previous.requestFits).toBe(false);
    expect(previous.commitTotalBytes).toBeGreaterThan(FIRESTORE_MAX_REQUEST_BYTES);
    // Medido: ~20 MiB, es decir, el doble del límite por petición.
    expect(previous.commitTotalBytes).toBeGreaterThan(20 * MB - 64 * 1024);
  });

  it("el límite de 9 MiB (12 fragmentos) también cabría, pero con menos margen", () => {
    const nine = measureUpload(9 * MB);

    expect(nine.chunks).toBe(12);
    expect(nine.requestFits).toBe(true);
    // Por eso el tope se fijó en 8 MiB: deja 2 MiB de holgura en vez de 1.
    expect(nine.requestMarginBytes).toBeLessThan(measureUpload(MAX_PDF_BYTES).requestMarginBytes);
  });

  it("el tamaño medido crece con el PDF y nunca se dispara por los metadatos", () => {
    const small = measureUpload(1024);
    const medium = measureUpload(5 * MB);

    expect(small.chunks).toBe(1);
    expect(medium.chunks).toBe(7);
    expect(medium.commitTotalBytes).toBeGreaterThan(small.commitTotalBytes);
    // Metadatos y contador son ruido frente al binario: < 4 KiB juntos.
    expect(medium.metaBytes + medium.counterBytes).toBeLessThan(4096);
  });

  it("un PDF vacío se rechaza antes de llegar aquí (0 fragmentos, 0 bytes)", () => {
    const empty = measureUpload(0);

    expect(empty.chunks).toBe(0);
    expect(empty.pdfBytes).toBe(0);
  });
});
