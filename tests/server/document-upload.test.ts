import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  abortPdfUpload,
  archivePdfDocument,
  createPdfUpload,
  documentIdFor,
  finalizePdfUpload,
  putPdfUploadPart,
  readDocumentPages,
  storageUsage,
} from "@/server/documents/service";
import { attachDocumentToDraft } from "@/server/documents/attach";
import { CHUNK_BYTES, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";
import { UPLOAD_PART_BYTES } from "@/domain/storage/pdf-upload";
import {
  MemoryPdfDocumentStore,
  createPdfMemoryState,
} from "@/demo/pdf-store";
import type { CourseVersionDocument } from "@/server/courses/catalog";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  InMemoryLearningStore,
  LEARNER,
  makeDefinition,
} from "../helpers/db-doubles";
import { InMemoryPdfDocumentStore } from "../helpers/document-double";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * SUBIDA POR PARTES: CICLO DE VIDA COMPLETO
 * ========================================
 *
 * Cada prueba corresponde a una promesa del bloque 06:
 *
 *   1. un PDF se abre pendiente, se envía por partes y solo se activa cuando el
 *      servidor comprueba todas las partes, el tamaño y el SHA-256;
 *   2. nada que no sea un PDF se acepta, aunque se llame `.pdf`;
 *   3. las partes se aceptan en orden, con su tamaño exacto, y un reenvío es
 *      idempotente (o un conflicto si el contenido cambió);
 *   4. interrumpir y reanudar es seguro; repetir operaciones también;
 *   5. cancelar libera la reserva y borra los fragmentos, una sola vez;
 *   6. la cuota reserva al abrir y no deja pasar dos subidas que no caben;
 *   7. un documento pendiente no se sirve, no se asocia y no se publica;
 *   8. solo se asocia a un borrador, con su revisión, y el activo es inmutable;
 *   9. la demostración y los dobles se comportan igual.
 *
 * **Lo que no demuestra**: que la transacción real de Firestore sea atómica ni
 * que dos transacciones se serialicen. Los dobles y la memoria no tienen
 * concurrencia real; el emulador sigue bloqueado (sin JVM).
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

function part(bytes: Uint8Array, index: number): Uint8Array {
  return bytes.subarray(
    index * UPLOAD_PART_BYTES,
    Math.min((index + 1) * UPLOAD_PART_BYTES, bytes.length),
  );
}

function setup(
  options: { budgetBytes?: number; published?: boolean; documents?: InMemoryPdfDocumentStore } = {},
) {
  const catalog = new InMemoryCatalogStore();
  if (options.published) catalog.seedPublished(makeDefinition());
  else catalog.seedDraft(makeDefinition());

  const documents = options.documents ?? new InMemoryPdfDocumentStore();
  const enrollments = new InMemoryEnrollmentStore();
  const learning = new InMemoryLearningStore();
  enrollments.seed(LEARNER.uid, "curso-a");

  const deps = {
    catalog,
    documents,
    enrollments,
    learning,
    budgetBytes: options.budgetBytes ?? 64 * 1024 * 1024,
    now: () => FIXED_NOW,
  };
  return { catalog, documents, enrollments, learning, deps };
}

async function start(
  context: ReturnType<typeof setup>,
  bytes: Uint8Array,
  overrides: Partial<{
    actor: typeof ADMIN;
    topicId: string;
    title: string;
    pageCount: number;
    version: number;
    sha256: string;
  }> = {},
) {
  return createPdfUpload(
    {
      actor: overrides.actor ?? ADMIN,
      courseId: "curso-a",
      version: overrides.version ?? 1,
      topicId: overrides.topicId ?? "tema-1",
      title: overrides.title ?? "Apuntes del tema",
      pageCount: overrides.pageCount ?? 3,
      bytes: bytes.length,
      sha256: overrides.sha256 ?? sha256(bytes),
    },
    context.deps,
  );
}

async function sendParts(
  context: ReturnType<typeof setup>,
  documentId: string,
  bytes: Uint8Array,
  options: { actor?: typeof ADMIN } = {},
) {
  const total = Math.ceil(bytes.length / UPLOAD_PART_BYTES);
  for (let index = 0; index < total; index += 1) {
    await putPdfUploadPart(
      {
        actor: options.actor ?? ADMIN,
        documentId,
        index,
        bytes: part(bytes, index),
      },
      context.deps,
    );
  }
  return total;
}

let context: ReturnType<typeof setup>;

beforeEach(() => {
  context = setup();
});

// ---------------------------------------------------------------------------
// 1. Ciclo completo
// ---------------------------------------------------------------------------

describe("ciclo completo: pendiente, partes y activación", () => {
  it("abre pendiente, reserva cuota y solo activa tras verificar la huella", async () => {
    const pdf = fakePdf(CHUNK_BYTES * 2 + 500);

    const created = await start(context, pdf);
    expect(created.created).toBe(true);
    expect(created.upload.state).toBe("pending");
    expect(created.upload.partsTotal).toBe(3);
    expect(created.upload.partsReceived).toBe(0);
    expect(created.upload.documentId).toBe(
      documentIdFor({
        courseId: "curso-a",
        version: 1,
        topicId: "tema-1",
        sha256: sha256(pdf),
        bytes: pdf.length,
      }),
    );

    // La cuota está **reservada**, no en uso, y el documento no se sirve.
    let usage = await storageUsage(context.deps);
    expect(usage.usedBytes).toBe(0);
    expect(usage.reservedBytes).toBe(pdf.length);
    expect(usage.percent).toBeGreaterThan(0);
    await expect(
      readDocumentPages(
        { actor: LEARNER, documentId: created.upload.documentId, from: 1, to: 1 },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });

    await sendParts(context, created.upload.documentId, pdf);

    const finalized = await finalizePdfUpload(
      { actor: ADMIN, documentId: created.upload.documentId },
      context.deps,
    );
    expect(finalized.alreadyActive).toBe(false);
    expect(finalized.upload.state).toBe("active");
    expect(finalized.upload.sha256).toBe(sha256(pdf));
    expect(finalized.chunks).toBe(3);

    usage = await storageUsage(context.deps);
    expect(usage.usedBytes).toBe(pdf.length);
    expect(usage.reservedBytes).toBe(0);

    const meta = await context.documents.getMeta(created.upload.documentId);
    expect(meta?.state).toBe("active");
    expect(meta?.finalizedAt).toBe(FIXED_NOW.toISOString());
    expect(meta?.chunkLengths.reduce((sum, length) => sum + length, 0)).toBe(pdf.length);
  });

  it("acepta exactamente 8 MiB en 11 partes y rechaza uno más", async () => {
    const max = fakePdf(MAX_PDF_BYTES);
    const created = await start(context, max, { pageCount: 100 });
    expect(created.upload.partsTotal).toBe(11);
    await sendParts(context, created.upload.documentId, max);
    const done = await finalizePdfUpload(
      { actor: ADMIN, documentId: created.upload.documentId },
      context.deps,
    );
    expect(done.upload.bytes).toBe(MAX_PDF_BYTES);

    await expect(start(context, fakePdf(MAX_PDF_BYTES + 1), { pageCount: 100 })).rejects.toMatchObject(
      { code: "PDF_TOO_LARGE" },
    );
    await expect(start(context, new Uint8Array(0))).rejects.toMatchObject({ code: "PDF_EMPTY" });
  });
});

// ---------------------------------------------------------------------------
// 2. Validación del contenido
// ---------------------------------------------------------------------------

describe("validación: solo PDF de verdad", () => {
  it("rechaza la primera parte si no empieza por %PDF- y no avanza la subida", async () => {
    const html = new TextEncoder().encode("<html>no soy un pdf</html>");
    const created = await start(context, html);

    await expect(
      putPdfUploadPart(
        { actor: ADMIN, documentId: created.upload.documentId, index: 0, bytes: html },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "PDF_SIGNATURE_INVALID" });

    const meta = await context.documents.getMeta(created.upload.documentId);
    expect(meta?.partsReceived).toBe(0);
    expect(context.documents.chunkCount()).toBe(0);
  });

  it("no acepta una subida contra una versión publicada", async () => {
    const published = setup({ published: true });
    const pdf = fakePdf(1024);
    await expect(start(published, pdf)).rejects.toMatchObject({ code: "VERSION_NOT_EDITABLE" });
    expect(await published.documents.reservedBytes()).toBe(0);
  });

  it("rechaza temas que no son de la versión y páginas imposibles", async () => {
    const pdf = fakePdf(1024);
    await expect(start(context, pdf, { topicId: "tema-9" })).rejects.toMatchObject({
      code: "TOPIC_NOT_IN_COURSE",
    });
    await expect(start(context, pdf, { pageCount: 2000 })).rejects.toMatchObject({
      code: "PDF_PAGES_EXCEED_BYTES",
    });
  });

  it("solo el administrador activo que abrió la subida puede tocarla", async () => {
    const pdf = fakePdf(1024);
    const created = await start(context, pdf);
    const otherAdmin = { ...ADMIN, uid: "otro-admin-0001" };

    expect(
      (await context.documents.getMeta(created.upload.documentId))?.uploadedBy,
    ).toBe(ADMIN.uid);

    await expect(
      putPdfUploadPart(
        { actor: otherAdmin, documentId: created.upload.documentId, index: 0, bytes: part(pdf, 0) },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_OWNER" });
    await expect(
      finalizePdfUpload({ actor: otherAdmin, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_OWNER" });
    await expect(
      abortPdfUpload({ actor: otherAdmin, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_OWNER" });
    await expect(
      putPdfUploadPart(
        { actor: LEARNER, documentId: created.upload.documentId, index: 0, bytes: part(pdf, 0) },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// 3. Partes: orden, tamaño, duplicados y alteraciones
// ---------------------------------------------------------------------------

describe("partes: orden, tamaño y contenido", () => {
  it("no acepta una parte adelantada ni con el tamaño equivocado", async () => {
    const pdf = fakePdf(CHUNK_BYTES * 2 + 100);
    const created = await start(context, pdf);
    const id = created.upload.documentId;

    await expect(
      putPdfUploadPart({ actor: ADMIN, documentId: id, index: 1, bytes: part(pdf, 1) }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_CHUNK_OUT_OF_ORDER" });

    await expect(
      putPdfUploadPart({ actor: ADMIN, documentId: id, index: 0, bytes: part(pdf, 0).subarray(0, 100) }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_CHUNK_SIZE_INVALID" });

    await expect(
      putPdfUploadPart({ actor: ADMIN, documentId: id, index: 9, bytes: part(pdf, 0) }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_CHUNK_INDEX_INVALID" });

    expect((await context.documents.getMeta(id))?.partsReceived).toBe(0);
  });

  it("reenviar la misma parte es idempotente; con otro contenido es un conflicto", async () => {
    const pdf = fakePdf(CHUNK_BYTES * 2 + 100);
    const created = await start(context, pdf);
    const id = created.upload.documentId;

    const first = await putPdfUploadPart(
      { actor: ADMIN, documentId: id, index: 0, bytes: part(pdf, 0) },
      context.deps,
    );
    expect(first.stored).toBe(true);
    expect(first.upload.partsReceived).toBe(1);

    const again = await putPdfUploadPart(
      { actor: ADMIN, documentId: id, index: 0, bytes: part(pdf, 0) },
      context.deps,
    );
    expect(again.stored).toBe(false);
    expect(again.upload.partsReceived).toBe(1);
    expect(context.documents.partWrites).toBe(1);

    const altered = new Uint8Array(part(pdf, 0));
    altered[100] = 0x5a;
    await expect(
      putPdfUploadPart({ actor: ADMIN, documentId: id, index: 0, bytes: altered }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_CHUNK_CONFLICT" });
  });

  it("no finaliza con partes ausentes y lo dice con números", async () => {
    const pdf = fakePdf(CHUNK_BYTES * 2 + 100);
    const created = await start(context, pdf, { pageCount: 5 });
    await putPdfUploadPart(
      { actor: ADMIN, documentId: created.upload.documentId, index: 0, bytes: part(pdf, 0) },
      context.deps,
    );

    await expect(
      finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({
      code: "PDF_UPLOAD_INCOMPLETE",
      details: { partsTotal: 3, partsReceived: 1, missing: 2 },
    });
    // Sigue pendiente y con la reserva intacta.
    expect((await context.documents.getMeta(created.upload.documentId))?.state).toBe("pending");
    expect(await context.documents.reservedBytes()).toBe(pdf.length);
  });
});

// ---------------------------------------------------------------------------
// 4. SHA-256, interrupción y reanudación
// ---------------------------------------------------------------------------

describe("integridad y reanudación", () => {
  it("rechaza la finalización si la huella no es la del fichero", async () => {
    const pdf = fakePdf(2000);
    const lying = "b".repeat(64);
    const created = await start(context, pdf, { sha256: lying, pageCount: 3 });
    await sendParts(context, created.upload.documentId, pdf);

    await expect(
      finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_SHA256_MISMATCH" });

    const meta = await context.documents.getMeta(created.upload.documentId);
    expect(meta?.state).toBe("pending");
    expect(await context.documents.usageBytes()).toBe(0);
    expect(await context.documents.reservedBytes()).toBe(pdf.length);
  });

  it("detecta un fragmento alterado en el almacén antes de activar", async () => {
    const pdf = fakePdf(3000);
    const created = await start(context, pdf);
    await sendParts(context, created.upload.documentId, pdf);

    // Corrupción en el almacén: misma longitud, otro byte.
    context.documents.corruptChunk(created.upload.documentId, 0, (data) => {
      data[10] = 0x00;
    });

    await expect(
      finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({ code: "PDF_SHA256_MISMATCH" });
  });

  it("se puede interrumpir y reanudar sin reenviar lo que ya estaba", async () => {
    const pdf = fakePdf(CHUNK_BYTES * 2 + 4321);
    const created = await start(context, pdf);
    const id = created.upload.documentId;

    // Primera sesión: dos partes y «se cae» la conexión.
    await putPdfUploadPart({ actor: ADMIN, documentId: id, index: 0, bytes: part(pdf, 0) }, context.deps);
    await putPdfUploadPart({ actor: ADMIN, documentId: id, index: 1, bytes: part(pdf, 1) }, context.deps);

    // Otra sesión de servidor, mismo almacén.
    const resumedDeps = { ...context.deps, now: () => FIXED_NOW };
    const pending = await context.documents.listPending({ courseId: "curso-a", version: 1 });
    expect(pending).toHaveLength(1);
    expect(pending[0].partsReceived).toBe(2);

    await putPdfUploadPart(
      { actor: ADMIN, documentId: id, index: 2, bytes: part(pdf, 2) },
      resumedDeps,
    );
    const done = await finalizePdfUpload({ actor: ADMIN, documentId: id }, resumedDeps);
    expect(done.upload.sha256).toBe(sha256(pdf));
    // Solo se escribieron 3 partes.
    expect(context.documents.partWrites).toBe(3);
  });

  it("repetir creación y finalización no reserva ni cuenta dos veces", async () => {
    const pdf = fakePdf(4096);
    const first = await start(context, pdf);
    const second = await start(context, pdf);
    expect(second.created).toBe(false);
    expect(second.upload.documentId).toBe(first.upload.documentId);
    expect(await context.documents.reservedBytes()).toBe(pdf.length);

    await sendParts(context, first.upload.documentId, pdf);
    const done = await finalizePdfUpload(
      { actor: ADMIN, documentId: first.upload.documentId },
      context.deps,
    );
    const again = await finalizePdfUpload(
      { actor: ADMIN, documentId: first.upload.documentId },
      context.deps,
    );

    expect(done.alreadyActive).toBe(false);
    expect(again.alreadyActive).toBe(true);
    expect(context.documents.finalizations).toBe(1);
    expect(await context.documents.usageBytes()).toBe(pdf.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Cancelación y liberación
// ---------------------------------------------------------------------------

describe("cancelación", () => {
  it("libera la reserva, borra los fragmentos y no libera dos veces", async () => {
    const pdf = fakePdf(CHUNK_BYTES + 10);
    const created = await start(context, pdf, { pageCount: 4 });
    await putPdfUploadPart(
      { actor: ADMIN, documentId: created.upload.documentId, index: 0, bytes: part(pdf, 0) },
      context.deps,
    );
    expect(context.documents.chunkCount()).toBe(1);

    const aborted = await abortPdfUpload(
      { actor: ADMIN, documentId: created.upload.documentId },
      context.deps,
    );
    expect(aborted.releasedBytes).toBe(pdf.length);
    expect(aborted.chunksDeleted).toBeGreaterThan(0);
    expect(await context.documents.reservedBytes()).toBe(0);
    expect(await context.documents.usageBytes()).toBe(0);
    expect(await context.documents.getMeta(created.upload.documentId)).toBeNull();
    expect(context.documents.chunkCount()).toBe(0);

    const twice = await abortPdfUpload(
      { actor: ADMIN, documentId: created.upload.documentId },
      context.deps,
    );
    expect(twice.releasedBytes).toBe(0);
    expect(await context.documents.reservedBytes()).toBe(0);
  });

  it("un activo no se cancela: se archiva y deja de servirse", async () => {
    const pdf = fakePdf(5000);
    const created = await start(context, pdf);
    await sendParts(context, created.upload.documentId, pdf);
    await finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps);

    await expect(
      abortPdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps),
    ).rejects.toMatchObject({ code: "UPLOAD_ALREADY_ACTIVE" });

    const archived = await archivePdfDocument(
      { actor: ADMIN, documentId: created.upload.documentId },
      context.deps,
    );
    expect(archived.freedBytes).toBe(pdf.length);
    expect(archived.chunksDeleted).toBeGreaterThan(0);
    expect(await context.documents.usageBytes()).toBe(0);
    await expect(
      readDocumentPages(
        { actor: ADMIN, documentId: created.upload.documentId, from: 1, to: 1 },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });

  it("después de cancelar se puede volver a subir el mismo fichero", async () => {
    const pdf = fakePdf(2048);
    const created = await start(context, pdf);
    await abortPdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps);

    const retry = await start(context, pdf);
    expect(retry.created).toBe(true);
    await sendParts(context, retry.upload.documentId, pdf);
    const done = await finalizePdfUpload(
      { actor: ADMIN, documentId: retry.upload.documentId },
      context.deps,
    );
    expect(done.upload.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 6. Cuota y concurrencia
// ---------------------------------------------------------------------------

describe("cuota", () => {
  it("la reserva cuenta para el presupuesto antes de recibir un solo byte", async () => {
    const tight = setup({ budgetBytes: 3000 });
    const pdf = fakePdf(2000);

    const first = await start(tight, pdf, { pageCount: 2 });
    expect(first.upload.state).toBe("pending");
    // Otra subida de 2000 bytes no cabe: 2000 reservados + 2000 > 3000.
    await expect(start(tight, fakePdf(2000, "B"), { pageCount: 2 })).rejects.toMatchObject({
      code: "STORAGE_BUDGET_EXCEEDED",
    });
    // Un fichero distinto sí cabe si es más pequeño.
    await expect(start(tight, fakePdf(900, "C"), { pageCount: 2 })).resolves.toBeTruthy();
  });

  it("dos aperturas simultáneas no superan el presupuesto", async () => {
    const tight = setup({ budgetBytes: 1_500 });
    const one = fakePdf(1000, "A");
    const two = fakePdf(1000, "B");

    const results = await Promise.allSettled([start(tight, one), start(tight, two)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "STORAGE_BUDGET_EXCEEDED" });
    expect(await tight.documents.reservedBytes()).toBe(1000);
  });

  it("al activar, la reserva pasa a uso sin cambiar el total comprometido", async () => {
    const pdf = fakePdf(4096);
    const created = await start(context, pdf);
    const committed = (await storageUsage(context.deps)).usedBytes + (await storageUsage(context.deps)).reservedBytes;
    expect(committed).toBe(pdf.length);

    await sendParts(context, created.upload.documentId, pdf);
    await finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps);

    const usage = await storageUsage(context.deps);
    expect(usage.usedBytes + usage.reservedBytes).toBe(committed);
    expect(usage.reservedBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7 y 8. Asociación al borrador e inmutabilidad
// ---------------------------------------------------------------------------

async function uploadActive(pdf: Uint8Array, options: { pageCount?: number } = {}) {
  const created = await start(context, pdf, { pageCount: options.pageCount ?? 3 });
  await sendParts(context, created.upload.documentId, pdf);
  await finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, context.deps);
  return created.upload.documentId;
}

function draftVersion(context: ReturnType<typeof setup>): Promise<CourseVersionDocument | null> {
  return context.catalog.getVersion("curso-a", 1);
}

describe("asociación al borrador", () => {
  it("asocia un activo al tema, conserva páginas y título, y es idempotente", async () => {
    const pdf = fakePdf(5000);
    const documentId = await uploadActive(pdf, { pageCount: 7 });
    const before = await draftVersion(context);

    const attached = await attachDocumentToDraft(
      { actor: ADMIN, documentId, expectedRevision: before?.revision ?? 0 },
      { documents: context.documents, catalog: context.catalog },
    );
    expect(attached.attached).toBe(true);
    expect(attached.topicId).toBe("tema-1");
    expect(attached.revision).toBe((before?.revision ?? 0) + 1);

    // El tema ya tenía un documento de ejemplo: el nuevo se añade al final.
    const after = await draftVersion(context);
    const documents = after?.topics[0].documents ?? [];
    expect(documents).toHaveLength((before?.topics[0].documents.length ?? 0) + 1);
    expect(documents[documents.length - 1]).toEqual({
      id: documentId,
      title: "Apuntes del tema",
      pageCount: 7,
    });

    const again = await attachDocumentToDraft(
      { actor: ADMIN, documentId, expectedRevision: attached.revision },
      { documents: context.documents, catalog: context.catalog },
    );
    expect(again.attached).toBe(false);
    expect(again.revision).toBe(attached.revision);
    expect((await draftVersion(context))?.topics[0].documents).toHaveLength(documents.length);
  });

  it("no asocia un pendiente ni un documento de una versión publicada", async () => {
    const pdf = fakePdf(2000);
    const created = await start(context, pdf);

    await expect(
      attachDocumentToDraft(
        { actor: ADMIN, documentId: created.upload.documentId, expectedRevision: 0 },
        { documents: context.documents, catalog: context.catalog },
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY" });

    // Un documento activo de una versión publicada no se puede asociar.
    const published = setup({ published: true });
    const publishedDoc = await uploadActiveWith(published, fakePdf(3000));
    await expect(
      attachDocumentToDraft(
        { actor: ADMIN, documentId: publishedDoc, expectedRevision: 0 },
        { documents: published.documents, catalog: published.catalog },
      ),
    ).rejects.toMatchObject({ code: "VERSION_NOT_EDITABLE" });
  });

  it("exige la revisión vigente y no deja que la asociación se cuele por detrás", async () => {
    const documentId = await uploadActive(fakePdf(4000));
    const version = await draftVersion(context);

    // Otra pestaña guardó la estructura: la revisión ya no es la que teníamos.
    await context.catalog.replaceDraftContent({
      versionDoc: { ...(version as CourseVersionDocument), revision: (version?.revision ?? 0) + 1 },
      answerKeys: {
        courseId: "curso-a",
        version: 1,
        quizByTopic: { "tema-1": [] },
        finalExam: [],
        createdAt: FIXED_NOW.toISOString(),
      },
      expectedRevision: version?.revision ?? 0,
    });

    await expect(
      attachDocumentToDraft(
        { actor: ADMIN, documentId, expectedRevision: version?.revision ?? 0 },
        { documents: context.documents, catalog: context.catalog },
      ),
    ).rejects.toMatchObject({ code: "DRAFT_STALE" });
  });

  it("un documento activo es inmutable: no admite más bytes ni se puede sustituir in situ", async () => {
    const pdf = fakePdf(3000);
    const documentId = await uploadActive(pdf);

    await expect(
      putPdfUploadPart(
        { actor: ADMIN, documentId, index: 0, bytes: part(pdf, 0) },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_ALREADY_ACTIVE" });

    // Subir un fichero distinto crea otro activo; el primero no cambia.
    const other = fakePdf(3000, "B");
    const otherId = await uploadActive(other);
    expect(otherId).not.toBe(documentId);
    expect((await context.documents.getMeta(documentId))?.sha256).toBe(sha256(pdf));
    expect((await context.documents.getMeta(otherId))?.sha256).toBe(sha256(other));
  });
});

async function uploadActiveWith(target: ReturnType<typeof setup>, pdf: Uint8Array) {
  const created = await createPdfUpload(
    {
      actor: ADMIN,
      courseId: "curso-a",
      version: 1,
      topicId: "tema-1",
      title: "Publicado",
      pageCount: 2,
      bytes: pdf.length,
      sha256: sha256(pdf),
    },
    { ...target.deps, catalog: target.catalog },
  ).catch(() => null);

  // En un curso publicado la subida no se permite: se siembra directo en el
  // almacén, que es lo que simula un activo antiguo ya existente.
  if (created) return created.upload.documentId;

  const total = Math.ceil(pdf.length / UPLOAD_PART_BYTES);
  const meta = {
    documentId: "doc_publicado_000000000000000000",
    courseId: "curso-a",
    version: 1,
    topicId: "tema-1",
    title: "Publicado",
    pageCount: 2,
    bytes: pdf.length,
    sha256: sha256(pdf),
    chunkLengths: Array.from({ length: total }, (_, index) =>
      Math.min(UPLOAD_PART_BYTES, pdf.length - index * UPLOAD_PART_BYTES),
    ),
    uploadedBy: ADMIN.uid,
    uploadedAt: FIXED_NOW.toISOString(),
    state: "pending" as const,
    partsReceived: 0,
    finalizedAt: null,
    abortedAt: null,
  };
  await target.documents.createUpload({ meta, budgetBytes: target.deps.budgetBytes });
  for (let index = 0; index < total; index += 1) {
    await target.documents.putPart({
      documentId: meta.documentId,
      index,
      data: part(pdf, index),
      ownerUid: ADMIN.uid,
    });
  }
  await target.documents.finalizeUpload({
    documentId: meta.documentId,
    bytes: pdf.length,
    sha256: sha256(pdf),
    ownerUid: ADMIN.uid,
    at: FIXED_NOW.toISOString(),
  });
  return meta.documentId;
}

// ---------------------------------------------------------------------------
// 9. Paridad memoria (demo) ↔ doble de pruebas
// ---------------------------------------------------------------------------

describe("paridad demo ↔ dobles", () => {
  it("el almacén de la demostración y el doble dan el mismo resultado", async () => {
    const pdf = fakePdf(CHUNK_BYTES + 700);

    const run = async (store: MemoryPdfDocumentStore) => {
      const deps = {
        catalog: context.catalog,
        documents: store,
        budgetBytes: 64 * 1024 * 1024,
        now: () => FIXED_NOW,
      };
      const created = await createPdfUpload(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: 1,
          topicId: "tema-1",
          title: "Paridad",
          pageCount: 4,
          bytes: pdf.length,
          sha256: sha256(pdf),
        },
        deps,
      );
      for (let index = 0; index < created.upload.partsTotal; index += 1) {
        await putPdfUploadPart(
          { actor: ADMIN, documentId: created.upload.documentId, index, bytes: part(pdf, index) },
          deps,
        );
      }
      await finalizePdfUpload({ actor: ADMIN, documentId: created.upload.documentId }, deps);

      const meta = await store.getMeta(created.upload.documentId);
      return {
        documentId: created.upload.documentId,
        state: meta?.state,
        bytes: meta?.bytes,
        sha256: meta?.sha256,
        chunkLengths: meta?.chunkLengths,
        used: await store.usageBytes(),
        reserved: await store.reservedBytes(),
      };
    };

    const demo = await run(new MemoryPdfDocumentStore(createPdfMemoryState()));
    const double = await run(new InMemoryPdfDocumentStore());

    expect(demo).toEqual(double);
    expect(demo.state).toBe("active");
    expect(demo.reserved).toBe(0);
    expect(demo.used).toBe(pdf.length);
  });
});
