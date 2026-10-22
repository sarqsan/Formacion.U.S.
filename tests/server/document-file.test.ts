import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  documentFileSummary,
  isDocumentFileAvailable,
  isDocumentInVersion,
  readDocumentFile,
} from "@/server/documents/file";
import {
  CHUNK_BYTES,
  chunkCount,
} from "@/domain/storage/pdf-chunks";
import { SlidingWindowLimiter } from "@/server/ratelimit/limiter";
import type { PdfDocumentMeta } from "@/server/documents/store";
import { MemoryPdfDocumentStore, createPdfMemoryState } from "@/demo/pdf-store";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  PENDING,
  makeDefinition,
  makeTopic,
} from "../helpers/db-doubles";
import { InMemoryPdfDocumentStore } from "../helpers/document-double";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * VISOR PDF PRIVADO: AUTORIZACIÓN E INTEGRIDAD (bloque 07)
 * =======================================================
 *
 * La descarga del PDF completo tiene que denegar por defecto. Esta batería fija
 * cada caso de denegación de la orden, uno por uno:
 *
 *   1.  matrícula activa + documento referenciado en la versión publicada → 200
 *   2.  matrícula revocada → 403
 *   3.  sin matrícula → 403
 *   4.  documento que solo está en un borrador → 404
 *   5.  documento de una versión anterior no referenciado en la publicada → 404
 *   6.  pendiente, abortado, archivado o incompleto → 404 / 409
 *   7.  identificador manipulado o inexistente → 404
 *   8.  usuario de otro curso → 403
 *   9.  huella incorrecta, fragmento ausente o tamaño incoherente → 409
 *   10. cuenta no activa → 403
 *   11. fallo del almacén → error seguro, nunca bytes
 *   12. la interfaz deja de ofrecer el visor cuando el servidor deniega
 *
 * Lo que **no** demuestra: que Firestore real aplique lo mismo. Los dobles y la
 * demostración son memoria; el emulador sigue bloqueado (sin JVM).
 */

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakePdf(size: number, marker = "A"): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(marker.charCodeAt(0));
  const header = "%PDF-1.7\n";
  for (let index = 0; index < header.length; index += 1) {
    bytes[index] = header.charCodeAt(index);
  }
  return bytes;
}

const DOC = "doc-tema-1";

function setup(
  options: {
    enrolled?: boolean;
    revoked?: boolean;
    /** Curso publicado con el documento referenciado en el tema 1. */
    referenced?: boolean;
    limiter?: SlidingWindowLimiter;
    store?: InMemoryPdfDocumentStore;
  } = {},
) {
  const catalog = new InMemoryCatalogStore();
  const topics = options.referenced === false
    ? [makeTopic({ id: "tema-1", documents: [] })]
    : [makeTopic({ id: "tema-1", documents: [{ id: DOC, title: "PDF tema-1", pageCount: 3 }] })];
  catalog.seedPublished(makeDefinition({ topics }));

  const documents = options.store ?? new InMemoryPdfDocumentStore();
  const enrollments = new InMemoryEnrollmentStore();
  if (options.enrolled !== false) {
    enrollments.seed(LEARNER.uid, "curso-a");
    if (options.revoked) {
      enrollments.revoke({
        uid: LEARNER.uid,
        courseId: "curso-a",
        revokedAt: FIXED_NOW.toISOString(),
        revokedBy: ADMIN.uid,
      });
    }
  }

  const deps = {
    documents,
    catalog,
    enrollments,
    limiter: options.limiter,
  };
  return { catalog, documents, enrollments, deps };
}

/** Siembra un documento activo completo (una o varias partes). */
async function seedActive(
  context: ReturnType<typeof setup>,
  options: {
    documentId?: string;
    bytes?: Uint8Array;
    courseId?: string;
    version?: number;
    topicId?: string;
    pageCount?: number;
  } = {},
) {
  const bytes = options.bytes ?? fakePdf(CHUNK_BYTES + 512);
  const documentId = options.documentId ?? DOC;
  const chunkLengths = Array.from({ length: chunkCount(bytes.length) }, (_, index) =>
    Math.min(CHUNK_BYTES, bytes.length - index * CHUNK_BYTES),
  );

  const meta: PdfDocumentMeta = {
    documentId,
    courseId: options.courseId ?? "curso-a",
    version: options.version ?? 1,
    topicId: options.topicId ?? "tema-1",
    title: "PDF tema-1",
    pageCount: options.pageCount ?? 3,
    bytes: bytes.length,
    sha256: sha256(bytes),
    chunkLengths,
    uploadedBy: ADMIN.uid,
    uploadedAt: FIXED_NOW.toISOString(),
    state: "pending",
    partsReceived: 0,
    finalizedAt: null,
    abortedAt: null,
  };

  await context.documents.createUpload({ meta, budgetBytes: 64 * 1024 * 1024 });
  for (let index = 0; index < chunkLengths.length; index += 1) {
    await context.documents.putPart({
      documentId,
      index,
      data: bytes.subarray(
        index * CHUNK_BYTES,
        Math.min((index + 1) * CHUNK_BYTES, bytes.length),
      ),
      ownerUid: ADMIN.uid,
    });
  }
  await context.documents.finalizeUpload({
    documentId,
    bytes: bytes.length,
    sha256: sha256(bytes),
    ownerUid: ADMIN.uid,
    at: FIXED_NOW.toISOString(),
  });

  return { bytes, documentId };
}

/** Código de error de una promesa que debe fallar. */
async function failureCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? "SIN_CODIGO";
  }
}

// ---------------------------------------------------------------------------
// 1. Camino permitido
// ---------------------------------------------------------------------------

describe("acceso permitido", () => {
  it("con matrícula activa y documento referenciado devuelve el PDF completo", async () => {
    const context = setup();
    const { bytes } = await seedActive(context);

    const file = await readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps);

    expect(file.documentId).toBe(DOC);
    expect(file.bytes.length).toBe(bytes.length);
    expect(Buffer.from(file.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(file.pageCount).toBe(3);
    expect(file.filename).toBe("PDF-tema-1.pdf");
  });

  it("no devuelve huellas, rutas ni metadatos internos al cliente", async () => {
    const context = setup();
    const { bytes } = await seedActive(context);
    const file = await readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps);

    expect(Object.keys(file).sort()).toEqual(["bytes", "documentId", "filename", "pageCount"]);
    expect(JSON.stringify(file)).not.toContain(sha256(bytes));
    expect(JSON.stringify(file)).not.toContain("pdfChunks");
  });

  it("la interfaz recibe un resumen sin huella ni rutas", async () => {
    const context = setup();
    await seedActive(context);

    const summary = await documentFileSummary({ actor: LEARNER, documentId: DOC }, context.deps);
    expect(summary).toEqual({
      documentId: DOC,
      title: "PDF tema-1",
      pageCount: 3,
      bytes: CHUNK_BYTES + 512,
    });
  });

  it("la huella entregada corresponde al fichero que se subió", async () => {
    const context = setup();
    const { bytes } = await seedActive(context);
    const file = await readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps);
    expect(sha256(file.bytes)).toBe(sha256(bytes));
  });
});

// ---------------------------------------------------------------------------
// 2 y 3. Matrícula
// ---------------------------------------------------------------------------

describe("matrícula", () => {
  it("deniega a quien no tiene matrícula en el curso", async () => {
    const context = setup({ enrolled: false });
    await seedActive(context);

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("COURSE_NOT_AUTHORIZED");
    expect(await isDocumentFileAvailable({ actor: LEARNER, documentId: DOC }, context.deps)).toBe(
      false,
    );
    expect(await documentFileSummary({ actor: LEARNER, documentId: DOC }, context.deps)).toBeNull();
  });

  it("deniega una matrícula revocada sin borrar el progreso", async () => {
    const context = setup({ revoked: true });
    await seedActive(context);

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("COURSE_NOT_AUTHORIZED");
  });

  it("un administrador tampoco salta la matrícula por esta puerta", async () => {
    const context = setup({ enrolled: false });
    await seedActive(context);

    expect(await failureCode(() => readDocumentFile({ actor: ADMIN, documentId: DOC }, context.deps)))
      .toBe("COURSE_NOT_AUTHORIZED");
  });

  it("deniega una cuenta no activa aunque tenga matrícula", async () => {
    const context = setup();
    await seedActive(context);

    expect(await failureCode(() => readDocumentFile({ actor: PENDING, documentId: DOC }, context.deps)))
      .toBe("ACCOUNT_NOT_ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// 4, 5 y 8. Qué versión y qué curso
// ---------------------------------------------------------------------------

describe("versión publicada vigente", () => {
  it("deniega un documento que solo está en un borrador", async () => {
    // Versión 1 publicada SIN el documento; versión 2 en borrador CON él.
    const catalog = new InMemoryCatalogStore();
    catalog.seedPublished(
      makeDefinition({ topics: [makeTopic({ id: "tema-1", documents: [] })] }),
    );
    catalog.seedDraft({
      ...makeDefinition({
        version: 2,
        topics: [makeTopic({ id: "tema-2", documents: [{ id: DOC, title: "Borrador", pageCount: 2 }] })],
      }),
    });
    // El curso sigue publicado en la v1 y el borrador es la v2.
    catalog.courses.set("curso-a", {
      courseId: "curso-a",
      title: "Curso A",
      publishedVersion: 1,
      lastDraftVersion: 2,
    });

    const documents = new InMemoryPdfDocumentStore();
    const enrollments = new InMemoryEnrollmentStore();
    enrollments.seed(LEARNER.uid, "curso-a");
    const deps = { documents, catalog, enrollments, limiter: undefined };
    const context = { catalog, documents, enrollments, deps };
    await seedActive(context, { version: 2, topicId: "tema-2" });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, deps))).toBe(
      "DOCUMENT_NOT_FOUND",
    );
  });

  it("deniega un documento de una versión anterior que ya no está publicada", async () => {
    const context = setup();
    await seedActive(context);

    // Nueva versión publicada que ya no referencia el documento.
    context.catalog.seedPublished(
      makeDefinition({
        version: 2,
        topics: [makeTopic({ id: "tema-2", documents: [{ id: "doc-nuevo", title: "Nuevo", pageCount: 2 }] })],
      }),
    );

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
  });

  it("deniega si el curso no tiene ninguna versión publicada", async () => {
    const context = setup();
    await seedActive(context);
    context.catalog.courses.set("curso-a", {
      ...context.catalog.courses.get("curso-a")!,
      publishedVersion: null,
    });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
  });

  it("no hay acceso cruzado entre cursos", async () => {
    const context = setup();
    // Documento activo de otro curso, publicado y referenciado allí.
    context.catalog.seedPublished(
      makeDefinition({
        courseId: "curso-b",
        topics: [makeTopic({ id: "tema-1", documents: [{ id: DOC, title: "PDF tema-1", pageCount: 3 }] })],
      }),
    );
    await seedActive(context, { courseId: "curso-b" });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("COURSE_NOT_AUTHORIZED");
  });

  it("la referencia se comprueba en la definición, no por parecido del id", async () => {
    const context = setup();
    await seedActive(context, { documentId: "doc-tema-10" });
    context.catalog.seedPublished(
      makeDefinition({
        topics: [makeTopic({ id: "tema-1", documents: [{ id: DOC, title: "PDF tema-1", pageCount: 3 }] })],
      }),
    );

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: "doc-tema-10" }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
    const published = context.catalog.versions.get("curso-a@1");
    expect(published).toBeTruthy();
    expect(isDocumentInVersion(published!, "doc-tema-1")).toBe(true);
    expect(isDocumentInVersion(published!, "doc-tema-10")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6 y 7. Estado del documento e identificador
// ---------------------------------------------------------------------------

describe("estado del documento", () => {
  it("un pendiente no se entrega", async () => {
    const context = setup();
    const bytes = fakePdf(4096);
    await context.documents.createUpload({
      meta: {
        documentId: DOC,
        courseId: "curso-a",
        version: 1,
        topicId: "tema-1",
        title: "PDF tema-1",
        pageCount: 3,
        bytes: bytes.length,
        sha256: sha256(bytes),
        chunkLengths: [bytes.length],
        uploadedBy: ADMIN.uid,
        uploadedAt: FIXED_NOW.toISOString(),
        state: "pending",
        partsReceived: 0,
        finalizedAt: null,
        abortedAt: null,
      },
      budgetBytes: 64 * 1024 * 1024,
    });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
    expect(await isDocumentFileAvailable({ actor: LEARNER, documentId: DOC }, context.deps)).toBe(
      false,
    );
  });

  it("un abortado y un archivado no se entregan", async () => {
    const context = setup();
    const bytes = fakePdf(5000);

    await context.documents.createUpload({
      meta: {
        documentId: "doc-abortado",
        courseId: "curso-a",
        version: 1,
        topicId: "tema-1",
        title: "Abortado",
        pageCount: 2,
        bytes: bytes.length,
        sha256: sha256(bytes),
        chunkLengths: [bytes.length],
        uploadedBy: ADMIN.uid,
        uploadedAt: FIXED_NOW.toISOString(),
        state: "pending",
        partsReceived: 0,
        finalizedAt: null,
        abortedAt: null,
      },
      budgetBytes: 64 * 1024 * 1024,
    });
    await context.documents.abortUpload({
      documentId: "doc-abortado",
      ownerUid: ADMIN.uid,
      at: FIXED_NOW.toISOString(),
    });

    await seedActive(context);
    await context.documents.archiveDocument(DOC, FIXED_NOW.toISOString());

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: "doc-abortado" }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_NOT_FOUND");
  });

  it("un documento con partes incompletas no se entrega", async () => {
    const context = setup();
    await seedActive(context);
    context.documents.mutateMeta(DOC, (meta) => {
      meta.partsReceived = meta.chunkLengths.length - 1;
    });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_CORRUPTED");
  });

  it("un tamaño declarado incoherente no se entrega", async () => {
    const context = setup();
    await seedActive(context);
    context.documents.mutateMeta(DOC, (meta) => {
      meta.bytes = meta.bytes + 1;
    });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_CORRUPTED");
  });
});

describe("identificador", () => {
  it("rechaza identificadores manipulados con la misma respuesta que «no existe»", async () => {
    const context = setup();
    await seedActive(context);

    for (const documentId of [
      "../../etc/passwd",
      "doc-tema-1/../doc-tema-1",
      "doc tema 1",
      "",
      "doc_00000000000000000000000000000000",
    ]) {
      expect(
        await failureCode(() => readDocumentFile({ actor: LEARNER, documentId }, context.deps)),
      ).toBe("DOCUMENT_NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// 9 y 11. Integridad y fallos del almacén
// ---------------------------------------------------------------------------

describe("integridad", () => {
  it("no entrega nada si un fragmento falta", async () => {
    const context = setup();
    await seedActive(context);
    context.documents.dropChunk(DOC, 0);

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_CORRUPTED");
  });

  it("no entrega nada si un fragmento está alterado (SHA-256)", async () => {
    const context = setup();
    await seedActive(context);
    context.documents.corruptChunk(DOC, 1, (data) => {
      data[0] = 0x00;
    });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_CORRUPTED");
  });

  it("no entrega nada si los bytes no empiezan por %PDF-", async () => {
    const context = setup();
    // Un documento «activo» cuyos bytes no son un PDF: se activó con una huella
    // coherente, así que la comprobación que lo rechaza es la firma.
    const bytes = fakePdf(2048);
    bytes.fill(0x41, 0);
    await seedActive(context, { bytes });

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("DOCUMENT_CORRUPTED");
  });

  it("un fallo del almacén no devuelve bytes ni detalles internos", async () => {
    const context = setup();
    await seedActive(context);
    context.documents.failNextRead();

    let caught: unknown;
    try {
      await readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain("pdfChunks");
    expect(serialized).not.toContain(sha256(fakePdf(CHUNK_BYTES + 512)));
    // El error de almacén llega como error de servicio, no como un PDF vacío.
    expect((caught as { code?: string }).code).toBe("FIRESTORE_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Cuota de peticiones y paridad demo ↔ dobles
// ---------------------------------------------------------------------------

describe("límite de descargas", () => {
  it("cobra un coste por fragmento leído y corta al agotarse", async () => {
    // El documento ocupa 2 fragmentos y el límite por usuario es 1: la descarga
    // completa no cabe, así que se rechaza antes de leer nada.
    const limiter = new SlidingWindowLimiter({ perUser: 1, global: 100, windowMs: 60_000 });
    const context = setup({ limiter });
    await seedActive(context);

    expect(await failureCode(() => readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps)))
      .toBe("RATE_LIMITED");
  });
});

describe("paridad demo ↔ dobles", () => {
  it("el almacén de la demostración y el doble dan el mismo resultado", async () => {
    const run = async (store: MemoryPdfDocumentStore) => {
      const context = setup({ store: store as InMemoryPdfDocumentStore });
      await seedActive(context);

      const allowed = await readDocumentFile({ actor: LEARNER, documentId: DOC }, context.deps);
      const deniedNoEnrollment = await isDocumentFileAvailable(
        { actor: LEARNER, documentId: "doc-no-existe" },
        context.deps,
      );

      return {
        allowedBytes: allowed.bytes.length,
        sha: sha256(allowed.bytes),
        filename: allowed.filename,
        deniedNoEnrollment,
      };
    };

    const demo = await run(new MemoryPdfDocumentStore(createPdfMemoryState()));
    const double = await run(new InMemoryPdfDocumentStore());
    expect(demo).toEqual(double);
  });
});

// ---------------------------------------------------------------------------
// La página del alumno no recibe contenido de borradores
// ---------------------------------------------------------------------------

describe("portal del alumnado", () => {
  it("el resumen no se ofrece para documentos no publicados", async () => {
    const context = setup({ referenced: false });
    await seedActive(context);

    expect(await documentFileSummary({ actor: LEARNER, documentId: DOC }, context.deps)).toBeNull();
    expect(await isDocumentFileAvailable({ actor: LEARNER, documentId: DOC }, context.deps)).toBe(
      false,
    );
  });
});
