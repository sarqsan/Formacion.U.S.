import { describe, expect, it } from "vitest";
import {
  MAX_PAGES_PER_REQUEST,
  archivePdfDocument,
  readDocumentPages,
  storageUsage,
  uploadPdfDocument,
} from "@/server/documents/service";
import {
  CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_PDF_BYTES,
  MAX_TRANSACTION_BYTES,
} from "@/domain/storage/pdf-chunks";
import { SlidingWindowLimiter } from "@/server/ratelimit/limiter";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  InMemoryLearningStore,
  LEARNER,
  PENDING,
  makeDefinition,
} from "../helpers/db-doubles";
import { InMemoryPdfDocumentStore } from "../helpers/document-double";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

function fakePdf(size: number, marker = "A"): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(marker.charCodeAt(0));
  const header = "%PDF-1.7\n";
  for (let index = 0; index < header.length; index += 1) {
    bytes[index] = header.charCodeAt(index);
  }
  return bytes;
}

function setup(
  options: {
    budgetBytes?: number;
    publish?: boolean;
    enrolled?: boolean;
    limiter?: SlidingWindowLimiter;
  } = {},
) {
  const catalog = new InMemoryCatalogStore();
  const documents = new InMemoryPdfDocumentStore();
  const enrollments = new InMemoryEnrollmentStore();
  const learning = new InMemoryLearningStore();

  catalog.seedPublished(makeDefinition());
  if (options.publish === false) {
    catalog.courses.set("curso-a", { ...catalog.courses.get("curso-a")!, publishedVersion: null });
  }
  if (options.enrolled !== false) {
    enrollments.seed(LEARNER.uid, "curso-a");
  }

  const deps = {
    catalog,
    documents,
    enrollments,
    learning,
    budgetBytes: options.budgetBytes ?? 64 * 1024 * 1024,
    limiter: options.limiter,
    now: () => FIXED_NOW,
  };
  return { catalog, documents, enrollments, learning, deps };
}

const upload = (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({
  actor: ADMIN,
  courseId: "curso-a",
  version: 1,
  topicId: "tema-1",
  documentId: "doc-tema-1",
  title: "Tema 1 — Apuntes",
  pageCount: 3,
  bytes,
  ...overrides,
});

/** PDF de tamaño válido para las pruebas de lectura (10 fragmentos). */
const READ_PDF_BYTES = 40_000;

async function seedReadable(context: ReturnType<typeof setup>, pageCount = 10) {
  const pdf = fakePdf(READ_PDF_BYTES);
  pdf.fill("B".charCodeAt(0), 10);
  await uploadPdfDocument(upload(pdf, { pageCount }), context.deps);
  return pdf;
}

describe("subida: límites de tamaño", () => {
  it("rechaza un archivo vacío", async () => {
    const { deps, documents } = setup();
    await expect(uploadPdfDocument(upload(new Uint8Array(0)), deps)).rejects.toMatchObject({
      code: "PDF_EMPTY",
    });
    expect(documents.saves).toBe(0);
  });

  it("acepta exactamente el máximo permitido (8 MiB)", async () => {
    const { deps, documents } = setup({ budgetBytes: 64 * 1024 * 1024 });
    const pdf = fakePdf(MAX_PDF_BYTES);

    const result = await uploadPdfDocument(upload(pdf, { pageCount: 100 }), deps);

    expect(result.bytes).toBe(MAX_PDF_BYTES);
    expect(result.chunks).toBe(MAX_CHUNKS);
    expect(documents.saves).toBe(1);
  });

  it("rechaza un byte más del máximo", async () => {
    const { deps, documents } = setup();
    const pdf = fakePdf(MAX_PDF_BYTES + 1);

    await expect(uploadPdfDocument(upload(pdf, { pageCount: 100 }), deps)).rejects.toMatchObject({
      code: "PDF_TOO_LARGE",
    });
    expect(documents.saves).toBe(0);
  });

  it("el máximo cabe en una transacción de Firestore (10 MiB)", async () => {
    // Es el fallo de la fase 5: 20 MiB en 27 fragmentos no cabían.
    expect(MAX_CHUNKS * CHUNK_BYTES).toBeLessThan(MAX_TRANSACTION_BYTES);
    // Con el tope anterior (20 MiB) habría fallado: queda como regresión.
    const twentyMiB = 20 * 1024 * 1024;
    expect(Math.ceil(twentyMiB / CHUNK_BYTES) * CHUNK_BYTES).toBeGreaterThan(
      MAX_TRANSACTION_BYTES,
    );
  });

  it("rechaza más páginas que bytes", async () => {
    const { deps } = setup();
    await expect(
      uploadPdfDocument(upload(fakePdf(1000), { pageCount: 5000 }), deps),
    ).rejects.toMatchObject({ code: "PDF_PAGES_EXCEED_BYTES" });
  });

  it("rechaza lo que no es un PDF", async () => {
    const { deps, documents } = setup();
    const html = new TextEncoder().encode("<html>no soy un pdf</html>");
    await expect(uploadPdfDocument(upload(html), deps)).rejects.toMatchObject({
      code: "PDF_SIGNATURE_INVALID",
    });
    expect(documents.saves).toBe(0);
  });

  it("solo administradores activos pueden subir", async () => {
    const { deps, documents } = setup();
    await expect(
      uploadPdfDocument(upload(fakePdf(1024), { actor: LEARNER }), deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      uploadPdfDocument(upload(fakePdf(1024), { actor: PENDING }), deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
    expect(documents.saves).toBe(0);
  });
});

describe("subida: presupuesto, fallos parciales y concurrencia", () => {
  it("no escribe nada si el documento no cabe en el presupuesto", async () => {
    const { deps, documents } = setup({ budgetBytes: 10 * 1024 });
    await expect(
      uploadPdfDocument(upload(fakePdf(20 * 1024), { pageCount: 5 }), deps),
    ).rejects.toMatchObject({ code: "STORAGE_BUDGET_EXCEEDED" });
    expect(documents.saves).toBe(0);
    expect(await documents.usageBytes()).toBe(0);
  });

  it("un fallo a mitad de la escritura no deja fragmentos huérfanos ni contador", async () => {
    const { deps, documents } = setup();
    const pdf = fakePdf(CHUNK_BYTES * 2 + 10);

    documents.failOnChunk(1);

    await expect(
      uploadPdfDocument(upload(pdf, { pageCount: 50 }), deps),
    ).rejects.toThrow();

    // Contrato todo-o-nada: sin metadatos, sin fragmentos y sin cuota gastada.
    expect(await documents.getMeta("doc-tema-1")).toBeNull();
    expect(await documents.usageBytes()).toBe(0);
    expect(documents.chunkCount()).toBe(0);

    // Y se puede volver a intentar con el mismo id.
    const retry = await uploadPdfDocument(upload(pdf, { pageCount: 50 }), deps);
    expect(retry.bytes).toBe(pdf.length);
  });

  it("dos subidas simultáneas no superan el presupuesto (comprobación al escribir)", async () => {
    // 1 MiB de presupuesto y dos PDF de 700 KiB: solo cabe uno.
    const { deps, documents } = setup({ budgetBytes: 1024 * 1024 });
    const pdf = fakePdf(700 * 1024);

    const results = await Promise.allSettled([
      uploadPdfDocument(upload(pdf, { documentId: "doc-a", pageCount: 20 }), deps),
      uploadPdfDocument(upload(pdf, { documentId: "doc-b", pageCount: 20 }), deps),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "STORAGE_BUDGET_EXCEEDED",
    });
    expect(await documents.usageBytes()).toBe(700 * 1024);
    expect(documents.saves).toBe(1);
  });

  it("un documento existente no se sobrescribe", async () => {
    const { deps, documents } = setup();
    await uploadPdfDocument(upload(fakePdf(1024), { pageCount: 5 }), deps);

    await expect(
      uploadPdfDocument(upload(fakePdf(2048), { pageCount: 5 }), deps),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_EXISTS" });
    expect(documents.saves).toBe(1);
  });
});

describe("lectura: matrícula y publicación", () => {
  it("deniega a un usuario sin matrícula aunque el curso esté publicado", async () => {
    const context = setup({ enrolled: false });
    await seedReadable(context);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("deniega si la matrícula está revocada", async () => {
    const context = setup();
    await seedReadable(context);
    context.enrollments.seed(LEARNER.uid, "curso-a", "revoked");

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("un alumno de otro curso no accede (aislamiento entre cursos)", async () => {
    const context = setup();
    await seedReadable(context);
    // Matriculado en otro curso, no en este.
    context.enrollments = new InMemoryEnrollmentStore();
    context.enrollments.seed(LEARNER.uid, "curso-b");
    context.deps.enrollments = context.enrollments;

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("deniega a una cuenta pendiente de activación", async () => {
    const context = setup();
    await seedReadable(context);

    await expect(
      readDocumentPages({ actor: PENDING, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("no sirve documentos de versiones no publicadas a un alumno", async () => {
    const context = setup();
    await seedReadable(context);
    context.catalog.courses.set("curso-a", {
      ...context.catalog.courses.get("curso-a")!,
      publishedVersion: null,
    });

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });
  });

  it("un administrador puede revisar un borrador sin matrícula", async () => {
    const context = setup({ publish: false, enrolled: false });
    await seedReadable(context);

    const result = await readDocumentPages(
      { actor: ADMIN, documentId: "doc-tema-1", from: 1, to: 1 },
      context.deps,
    );
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("devuelve 404 si el documento no existe", async () => {
    const context = setup();
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "nope", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });
});

describe("lectura: secuencia obligatoria", () => {
  it("empieza por la página 1 y exige orden", async () => {
    const context = setup();
    await seedReadable(context, 10);

    const first = await readDocumentPages(
      { actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 },
      context.deps,
    );
    expect(first.nextPage).toBe(2);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 3, to: 3 }, context.deps),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_ORDER" });
  });

  it("no permite repetir una página ya vista", async () => {
    const context = setup();
    await seedReadable(context, 10);

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 2 }, context.deps);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 2 }, context.deps),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_ORDER" });
  });

  it("permite continuar desde donde se quedó, tras recargar", async () => {
    const context = setup();
    await seedReadable(context, 10);

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 4 }, context.deps);
    const next = await readDocumentPages(
      { actor: LEARNER, documentId: "doc-tema-1", from: 5, to: 5 },
      context.deps,
    );
    expect(next.nextPage).toBe(6);
  });

  it("las rebanadas reconstruyen el fichero byte a byte", async () => {
    const context = setup();
    const pdf = await seedReadable(context, 10);

    const pieces: Uint8Array[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await readDocumentPages(
        { actor: LEARNER, documentId: "doc-tema-1", from: page, to: page },
        context.deps,
      );
      pieces.push(result.bytes);
    }

    const joined = new Uint8Array(pdf.length);
    let offset = 0;
    for (const piece of pieces) {
      joined.set(piece, offset);
      offset += piece.length;
    }
    expect(offset).toBe(pdf.length);
    expect(Buffer.from(joined).equals(Buffer.from(pdf))).toBe(true);
  });

  it("marca el documento como leído al llegar a la última página", async () => {
    const context = setup();
    await seedReadable(context, 4);

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 3 }, context.deps);
    const last = await readDocumentPages(
      { actor: LEARNER, documentId: "doc-tema-1", from: 4, to: 4 },
      context.deps,
    );

    expect(last.remainingPages).toBe(0);
    const stored = await context.learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.documents["doc-tema-1"].completedAt).toBe(FIXED_NOW.toISOString());
  });

  it("no confía en un estado APTO enviado por el cliente", async () => {
    const context = setup();
    await seedReadable(context, 10);

    // El cliente no tiene ninguna vía para decir "he leído": solo pide páginas.
    // Si envía campos extra en el objeto, se ignoran por completo.
    const sneaky = {
      actor: LEARNER,
      documentId: "doc-tema-1",
      from: 10,
      to: 10,
      lastPageViewed: 9,
      completedAt: FIXED_NOW.toISOString(),
    } as unknown as Parameters<typeof readDocumentPages>[0];

    await expect(readDocumentPages(sneaky, context.deps)).rejects.toMatchObject({
      code: "PAGE_OUT_OF_ORDER",
    });
  });

  it("rechaza rangos invertidos, fuera del documento y demasiado grandes", async () => {
    const context = setup();
    await seedReadable(context, 30);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 5, to: 4 }, context.deps),
    ).rejects.toMatchObject({ code: "PAGE_INVALID" });

    // Dentro del documento pero saltándose páginas: falla por orden, no por rango.
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 25, to: 25 }, context.deps),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_ORDER" });

    // 12 páginas (cabe en el tope) pero la 31 no existe en un documento de 30.
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 20, to: 31 }, context.deps),
    ).rejects.toMatchObject({ code: "PAGE_OUT_OF_RANGE" });

    await expect(
      readDocumentPages(
        { actor: LEARNER, documentId: "doc-tema-1", from: 1, to: MAX_PAGES_PER_REQUEST + 1 },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "PAGE_RANGE_TOO_LARGE" });
  });

  it("detecta un fragmento que falta en lugar de devolver basura", async () => {
    const context = setup();
    // Documento de 1,5 MiB: ocupa dos fragmentos (0 y 1). 30 páginas ⇒ 50 KB/página.
    const pdf = fakePdf(2 * CHUNK_BYTES + 1000);
    await uploadPdfDocument(upload(pdf, { pageCount: 30 }), context.deps);
    context.documents.dropChunk("doc-tema-1", 1);

    // Las páginas 1..14 caen íntegras en el fragmento 0 y se leen bien…
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 14 }, context.deps),
    ).resolves.toMatchObject({ from: 1, to: 14 });

    // …y al pisar el fragmento perdido se falla sin devolver bytes a medias.
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 15, to: 20 }, context.deps),
    ).rejects.toMatchObject({ code: "DOCUMENT_CORRUPTED" });

    // El progreso no avanza si la lectura falló.
    const stored = await context.learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.documents["doc-tema-1"].lastPageViewed).toBe(14);
  });
});

describe("lectura: límites de consumo", () => {
  it("la cuota es por usuario de la sesión: no se puede cambiar con datos del cliente", async () => {
    const limiter = new SlidingWindowLimiter({ perUser: 2, global: 100, windowMs: 60_000 }, () => 0);
    const context = setup({ limiter });
    await seedReadable(context, 30);

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps);
    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 2, to: 2 }, context.deps);

    // Un campo extra que intente suplantar a otro usuario se ignora: la clave
    // del limitador sale del actor de la sesión, no del objeto de entrada.
    const sneaky = {
      actor: LEARNER,
      documentId: "doc-tema-1",
      from: 3,
      to: 3,
      uid: "otro-uid-00001",
      cost: 0,
      limit: 9999,
    } as unknown as Parameters<typeof readDocumentPages>[0];

    await expect(readDocumentPages(sneaky, context.deps)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("el coste lo calcula el servidor con el rango real, no el cliente", async () => {
    const limiter = new SlidingWindowLimiter({ perUser: 5, global: 100, windowMs: 60_000 }, () => 0);
    const context = setup({ limiter });
    await seedReadable(context, 30);

    // Pedir 5 páginas cuesta 5 aunque el cliente mande `cost=1`.
    const sneaky = {
      actor: LEARNER,
      documentId: "doc-tema-1",
      from: 1,
      to: 5,
      cost: 1,
    } as unknown as Parameters<typeof readDocumentPages>[0];

    const result = await readDocumentPages(sneaky, context.deps);
    expect(result.cost).toBe(5);
    expect(limiter.peek(`pdf:${LEARNER.uid}`).remainingUser).toBe(0);
  });

  it("dos alumnos distintos tienen cuotas distintas", async () => {
    const limiter = new SlidingWindowLimiter({ perUser: 1, global: 100, windowMs: 60_000 }, () => 0);
    const context = setup({ limiter });
    await seedReadable(context, 30);

    const other = { ...LEARNER, uid: "otro-uid-00001" };
    context.enrollments.seed(other.uid, "curso-a");

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps);
    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 2, to: 2 }, context.deps),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // El otro alumno no paga el consumo del primero.
    await expect(
      readDocumentPages({ actor: other, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).resolves.toMatchObject({ from: 1 });
  });

  it("revocar la matrícula cierra el acceso y no deja avanzar el progreso", async () => {
    const context = setup();
    await seedReadable(context, 30);

    await readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps);
    context.enrollments.seed(LEARNER.uid, "curso-a", "revoked");

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 2, to: 2 }, context.deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_AUTHORIZED" });

    const stored = await context.learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.documents["doc-tema-1"].lastPageViewed).toBe(1);
  });

  it("corta las peticiones repetidas de un mismo usuario", async () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(
      { perUser: 5, global: 100, windowMs: 60_000 },
      () => now,
    );
    const context = setup({ limiter });
    await seedReadable(context, 30);

    for (let page = 1; page <= 5; page += 1) {
      await readDocumentPages(
        { actor: LEARNER, documentId: "doc-tema-1", from: page, to: page },
        context.deps,
      );
    }

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 6, to: 6 }, context.deps),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // Al pasar la ventana vuelve a permitir.
    now += 61_000;
    const result = await readDocumentPages(
      { actor: LEARNER, documentId: "doc-tema-1", from: 6, to: 6 },
      context.deps,
    );
    expect(result.from).toBe(6);
  });

  it("cobra por página: pedir 20 páginas consume 20", async () => {
    const now = 0;
    const limiter = new SlidingWindowLimiter(
      { perUser: 10, global: 100, windowMs: 60_000 },
      () => now,
    );
    const context = setup({ limiter });
    await seedReadable(context, 30);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 10 }, context.deps),
    ).resolves.toBeTruthy();

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 11, to: 11 }, context.deps),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    void now;
  });

  it("no escribe progreso cuando el límite corta la petición", async () => {
    const limiter = new SlidingWindowLimiter({ perUser: 0, global: 0, windowMs: 60_000 }, () => 0);
    const context = setup({ limiter });
    await seedReadable(context, 10);

    await expect(
      readDocumentPages({ actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 }, context.deps),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(await context.learning.getProgress(LEARNER.uid, "curso-a")).toBeNull();
  });
});

describe("cuota de almacenamiento", () => {
  it("informa de lo usado y de lo que queda", async () => {
    const { deps } = setup({ budgetBytes: 1024 * 1024 });
    await uploadPdfDocument(upload(fakePdf(256 * 1024), { pageCount: 50 }), deps);

    const usage = await storageUsage(deps);
    expect(usage.usedBytes).toBe(256 * 1024);
    expect(usage.freeBytes).toBe(768 * 1024);
    expect(usage.percent).toBe(25);
  });

  it("archivar libera cuota y deja de servir el documento", async () => {
    const context = setup();
    await seedReadable(context);
    const before = await context.documents.usageBytes();

    const result = await archivePdfDocument(
      { actor: ADMIN, documentId: "doc-tema-1" },
      context.deps,
    );

    expect(result.freedBytes).toBe(before);
    expect(await context.documents.usageBytes()).toBe(0);
    await expect(
      readDocumentPages(
        { actor: LEARNER, documentId: "doc-tema-1", from: 1, to: 1 },
        context.deps,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });

  it("solo administradores archivan", async () => {
    const context = setup();
    await seedReadable(context);

    await expect(
      archivePdfDocument({ actor: LEARNER, documentId: "doc-tema-1" }, context.deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
