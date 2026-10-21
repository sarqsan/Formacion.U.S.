import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { initializeApp, getApps } from "firebase-admin/app";
import { FirestorePdfDocumentStore } from "@/server/firebase/document-store";
import { FirestoreLearningStore } from "@/server/firebase/learning-store";
import { uploadPdfDocument, readDocumentPages, storageUsage } from "@/server/documents/service";
import { CHUNK_BYTES, MAX_CHUNKS, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  makeDefinition,
} from "../helpers/db-doubles";
import { InMemoryEnrollmentStore } from "../helpers/enrollment-double";

/**
 * PRUEBA DE INTEGRACIÓN CONTRA EL EMULADOR DE FIRESTORE
 * ====================================================
 *
 * Requiere el emulador arrancado:
 *
 *     npm run test:firestore            # arranca el emulador y ejecuta esto
 *
 * Si `FIRESTORE_EMULATOR_HOST` no está definido, el bloque se **omite** (no
 * finge pasar). Es la única prueba de este repositorio que ejercita el
 * Firestore real (emulado): transacción, límites de tamaño, contador de cuota
 * y concurrencia.
 *
 * El catálogo, la matrícula y el progreso usan dobles en memoria (declarado a
 * propósito: lo que se quiere medir aquí es Firestore, no el catálogo).
 */

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const enabled = Boolean(EMULATOR);
const required = process.env.REQUIRE_FIRESTORE_EMULATOR === "1";

/**
 * Cuando las pruebas se lanzan con `npm run test:firestore`, el envoltorio
 * exporta `REQUIRE_FIRESTORE_EMULATOR=1`. En ese caso **no se permite omitir**:
 * si el emulador no está, aparece una prueba en rojo con la etiqueta BLOCKED en
 * lugar de un fichero "skipped" que parece que todo va bien.
 */
if (!enabled && required) {
  describe("Firestore (emulador) — preflight", () => {
    it("BLOCKED: se exige el emulador y FIRESTORE_EMULATOR_HOST no está definido", () => {
      throw new Error(
        "BLOCKED: sin emulador no se ejecuta ninguna prueba de integración. " +
          "Arranca el emulador con `npm run test:firestore` (requiere Java y el jar; ver docs/ENTORNO-PRUEBAS.md).",
      );
    });
  });
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "demo-formacion";

function pdf(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(0x42);
  const header = "%PDF-1.7\n";
  for (let index = 0; index < header.length; index += 1) bytes[index] = header.charCodeAt(index);
  return bytes;
}

if (!enabled && !required) {
  console.warn(
    "\n[integración] OMITIDAS las pruebas de Firestore: FIRESTORE_EMULATOR_HOST no está definido.\n" +
      "[integración] Esto NO significa que hayan pasado. Ejecuta `npm run test:firestore` para verlas correr.\n",
  );
}

describe.skipIf(!enabled)("Firestore (emulador): subida, transacción y cuota", () => {
  let db: ReturnType<typeof getFirestore>;

  beforeAll(() => {
    process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
    if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
    db = getFirestore();
  });

  afterAll(async () => {
    // Se borra solo lo creado por estas pruebas (proyecto `demo-`, sin datos).
    for (const collection of ["documents", "pdfChunks"]) {
      const snapshot = await db.collection(collection).get();
      await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
    }
    await db.doc("meta/storage").delete();
  });

  function setup(budgetBytes = 64 * 1024 * 1024) {
    const catalog = new InMemoryCatalogStore();
    const enrollments = new InMemoryEnrollmentStore();
    const learning = new FirestoreLearningStore();
    catalog.seedPublished(makeDefinition());
    enrollments.seed(LEARNER.uid, "curso-a");

    const deps = {
      catalog,
      documents: new FirestorePdfDocumentStore(),
      enrollments,
      learning,
      budgetBytes,
      now: () => FIXED_NOW,
    };
    return { catalog, enrollments, learning, deps };
  }

  const upload = (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({
    actor: ADMIN,
    courseId: "curso-a",
    version: 1,
    topicId: "tema-1",
    documentId: "doc-emulador",
    title: "Documento de prueba",
    pageCount: 40,
    bytes,
    ...overrides,
  });

  it("acepta un PDF de 8 MiB en UNA transacción y deja contador y fragmentos exactos", async () => {
    const { deps } = setup();

    const result = await uploadPdfDocument(upload(pdf(MAX_PDF_BYTES)), deps);

    expect(result.bytes).toBe(MAX_PDF_BYTES);
    expect(result.chunks).toBe(MAX_CHUNKS);

    const chunks = await db.collection("pdfChunks").get();
    expect(chunks.size).toBe(MAX_CHUNKS);

    for (const chunk of chunks.docs) {
      const data = chunk.get("data") as Buffer;
      expect(data.length).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(chunk.get("sha256OfDocument")).toBe(result.sha256);
    }

    const meta = await db.collection("documents").doc("doc-emulador").get();
    expect(meta.exists).toBe(true);
    expect(meta.get("bytes")).toBe(MAX_PDF_BYTES);
    expect(meta.get("chunkLengths")).toHaveLength(MAX_CHUNKS);

    const counter = await db.doc("meta/storage").get();
    expect(counter.get("usedBytes")).toBe(MAX_PDF_BYTES);

    const usage = await storageUsage(deps);
    expect(usage.usedBytes).toBe(MAX_PDF_BYTES);
  }, 120_000);

  it("lee las páginas reconstruyendo los fragmentos y avanza el progreso", async () => {
    const { deps, learning } = setup();
    await uploadPdfDocument(upload(pdf(MAX_PDF_BYTES)), deps);

    const first = await readDocumentPages(
      { actor: LEARNER, documentId: "doc-emulador", from: 1, to: 10 },
      deps,
    );
    expect(first.bytes.length).toBeGreaterThan(0);
    expect(first.from).toBe(1);
    expect(first.to).toBe(10);
    expect(first.nextPage).toBe(11);

    const stored = await learning.getProgress(LEARNER.uid, "curso-a");
    expect(stored?.documents["doc-emulador"].lastPageViewed).toBe(10);
  }, 120_000);

  it("dos subidas simultáneas del mismo id: una gana y el contador no se duplica", async () => {
    const { deps } = setup();
    const bytes = pdf(1024 * 1024);

    const results = await Promise.allSettled([
      uploadPdfDocument(upload(bytes), deps),
      uploadPdfDocument(upload(bytes), deps),
    ]);

    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "DOCUMENT_ALREADY_EXISTS",
    });

    const counter = await db.doc("meta/storage").get();
    expect(counter.get("usedBytes")).toBe(1024 * 1024);

    const chunks = await db.collection("pdfChunks").get();
    expect(chunks.size).toBe(2);
  }, 120_000);

  it("dos subidas distintas que no caben juntas: solo una respeta el presupuesto", async () => {
    const budget = Math.floor(1024 * 1024 * 1.5);
    const { deps } = setup(budget);
    const bytes = pdf(1024 * 1024);

    const results = await Promise.allSettled([
      uploadPdfDocument(upload(bytes, { documentId: "doc-a" }), deps),
      uploadPdfDocument(upload(bytes, { documentId: "doc-b" }), deps),
    ]);

    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "STORAGE_BUDGET_EXCEEDED",
    });

    const counter = await db.doc("meta/storage").get();
    expect(counter.get("usedBytes")).toBeLessThanOrEqual(budget);
  }, 120_000);
});
