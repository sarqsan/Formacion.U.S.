import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import { buildSamplePdf, seedDemoPdfs } from "@/demo/pdf-sample";
import { createPdfMemoryState } from "@/demo/pdf-store";
import {
  adminEnroll,
  adminRevokeEnrollment,
  documentFile,
  documentFileAvailable,
} from "@/demo/service";
import { DEMO_COURSES } from "@/demo/content";
import { demoState, resetDemoState } from "@/demo/store";

/**
 * PDF DE EJEMPLO Y APERTURA EN LA DEMOSTRACIÓN (bloque 07)
 * ======================================================
 *
 * La demostración no tiene ficheros del repositorio, así que genera un PDF
 * mínimo al arrancar. Estas pruebas comprueban dos cosas distintas:
 *
 *   1. que el PDF generado es **estructuralmente válido** (cabecera, tabla
 *      `xref` con desplazamientos reales, `startxref` y `%%EOF`), porque un
 *      fichero mal formado no se abriría con el visor del navegador;
 *   2. que el alumnado de la demostración puede abrirlo por la ruta autorizada
 *      y que quien no tiene matrícula no puede.
 */

const ALUMNO = "demo-alumno-1";
const ALUMNA_2 = "demo-alumno-2";
const COURSE = "curso-prevencion-riesgos";

function actor(uid: string): Actor {
  return { uid, role: "learner", status: "active" };
}

describe("PDF de ejemplo", () => {
  it("es un PDF 1.4 con tabla xref correcta", () => {
    const sample = buildSamplePdf({ title: "Guía de riesgos", pages: 3 });
    const text = Buffer.from(sample.bytes).toString("latin1");

    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Count 3");

    // `startxref` apunta al comienzo de la tabla y cada entrada apunta a su
    // objeto: si esto falla, el navegador no puede abrir el fichero.
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const entries = text.slice(startxref).match(/^(\d{10}) 00000 n $/gm) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(4);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it("respeta el número de páginas pedido y escapa el texto", () => {
    const sample = buildSamplePdf({ title: "Datos (personales) \\ prueba", pages: 2 });
    const text = Buffer.from(sample.bytes).toString("latin1");

    expect(sample.pages).toBe(2);
    expect(text).toContain("/Count 2");
    // Los paréntesis del título van escapados: si no, el PDF se rompe.
    expect(text).toContain("Datos \\(personales\\)");
  });

  it("acepta acentos sin romper el ASCII del fichero", () => {
    const sample = buildSamplePdf({ title: "Protección de datos", pages: 1 });
    const text = Buffer.from(sample.bytes).toString("latin1");
    expect(text).toContain("Proteccion de datos");
    expect(sample.bytes.every((byte) => byte < 0x100)).toBe(true);
  });
});

describe("siembra en la demostración", () => {
  it("todo documento del contenido demo queda activo y con su huella", () => {
    const state = createPdfMemoryState();
    seedDemoPdfs(
      state,
      DEMO_COURSES.map((course) => course.definition),
    );

    expect(state.metas.size).toBeGreaterThanOrEqual(3);
    for (const [documentId, meta] of state.metas) {
      expect(meta.state).toBe("active");
      expect(meta.partsReceived).toBe(meta.chunkLengths.length);
      const chunk = state.chunks.get(`${documentId}_0`);
      expect(chunk).toBeTruthy();
      expect(createHash("sha256").update(chunk!).digest("hex")).toBe(meta.sha256);
      expect(meta.bytes).toBe(chunk!.length);
    }
  });
});

describe("apertura del PDF en la demostración", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("el alumno matriculado recibe el PDF completo del curso publicado", async () => {
    const documentId = demoState().courses
      .get(COURSE)!
      .versions.get(demoState().courses.get(COURSE)!.summary.publishedVersion!)!
      .version.topics.flatMap((topic) => topic.documents)[0].id;

    const file = await documentFile(actor(ALUMNO), documentId);

    expect(file.documentId).toBe(documentId);
    expect(file.bytes.length).toBeGreaterThan(100);
    expect(Buffer.from(file.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(file.filename.endsWith(".pdf")).toBe(true);
  });

  it("quien no tiene matrícula en el curso no recibe nada", async () => {
    const documentId = demoState().courses
      .get(COURSE)!
      .versions.get(demoState().courses.get(COURSE)!.summary.publishedVersion!)!
      .version.topics.flatMap((topic) => topic.documents)[0].id;

    // La segunda alumna está matriculada en el curso de riesgos; se revoca.
    const admin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    await adminRevokeEnrollment(admin, ALUMNA_2, COURSE);

    await expect(documentFile(actor(ALUMNA_2), documentId)).rejects.toMatchObject({
      code: "COURSE_NOT_AUTHORIZED",
    });
    expect(await documentFileAvailable(actor(ALUMNA_2), documentId)).toBe(false);
  });

  it("un documento que solo está en el borrador no se sirve al alumnado", async () => {
    const summary = demoState().courses.get("curso-proteccion-datos")!;
    const published = summary.versions.get(summary.summary.publishedVersion!)!;
    const draft = summary.versions.get(summary.summary.lastDraftVersion!)!;

    const publishedIds = new Set(
      published.version.topics.flatMap((topic) => topic.documents.map((document) => document.id)),
    );
    const draftOnly = draft.version.topics
      .flatMap((topic) => topic.documents)
      .find((document) => !publishedIds.has(document.id));

    expect(draftOnly).toBeDefined();

    // Para que la denegación sea por la versión y no por la matrícula, se
    // matricula al alumno en este curso antes de comprobarlo.
    await adminEnroll(
      { uid: "demo-admin", role: "admin", status: "active" },
      ALUMNO,
      "curso-proteccion-datos",
    );

    // El PDF existe en el almacén de la demostración, pero la versión que lo
    // referencia no está publicada: no se entrega.
    expect(await documentFileAvailable(actor(ALUMNO), draftOnly!.id)).toBe(false);
    await expect(documentFile(actor(ALUMNO), draftOnly!.id)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_FOUND",
    });
  });
});
