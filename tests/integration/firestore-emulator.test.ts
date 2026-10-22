import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
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
    for (const collection of ["documents", "pdfChunks", "progress", "progressHistory"]) {
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

/**
 * HISTÓRICO DE FORMACIÓN CONTRA FIRESTORE (EMULADO)
 * =================================================
 *
 * Lo que esta prueba añade sobre las de servicio (que usan un doble en
 * memoria): que la consulta real —`where("uid", "==", uid).limit(200)`, **sin
 * `orderBy`**— se ejecuta, y que `archivedAt` se normaliza venga como cadena
 * (escritura actual) o como `Timestamp` (documentos antiguos, de cuando
 * `saveProgress` usaba `serverTimestamp()`).
 *
 * Aviso honesto: el emulador **crea índices automáticamente**, así que pasar
 * aquí no demuestra que el proyecto real no necesite un índice compuesto. Eso
 * lo comprueba `npm run db:check` contra el proyecto real (consulta incluida) o
 * la consola de Firebase. Lo que sí demuestra es que la forma del documento y
 * el filtro son los que el código espera.
 */
describe.skipIf(!enabled)("Firestore (emulador): histórico de formación", () => {
  let db: ReturnType<typeof getFirestore>;

  beforeAll(() => {
    process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
    if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
    db = getFirestore();
  });

  afterAll(async () => {
    for (const collection of ["progress", "progressHistory"]) {
      const snapshot = await db.collection(collection).get();
      await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
    }
  });

  const progressOf = (uid: string, version: number) => ({
    uid,
    courseId: "curso-a",
    version,
    mandatoryTopicIds: ["tema-1"],
    topics: {
      "tema-1": {
        topicId: "tema-1",
        passed: true,
        attempts: 1,
        passedAt: "2026-01-10T09:00:00.000Z",
        lastAttemptAt: "2026-01-10T09:00:00.000Z",
        bestScore: 100,
      },
    },
    documents: {},
    finalExam: {
      passed: true,
      attempts: 1,
      bestScore: 90,
      passedAt: "2026-01-11T09:00:00.000Z",
      lastAttemptAt: "2026-01-11T09:00:00.000Z",
    },
    completedAt: "2026-01-11T09:00:00.000Z",
    updatedAt: "2026-01-11T09:00:00.000Z",
  });

  it("devuelve solo el histórico del uid pedido, con archivedAt en ISO", async () => {
    await db
      .collection("progressHistory")
      .doc("alumno-1_curso-a_v1")
      .set({ ...progressOf("alumno-1", 1), archivedAt: "2026-02-01T10:00:00.000Z" });
    await db
      .collection("progressHistory")
      .doc("alumno-2_curso-a_v1")
      .set({ ...progressOf("alumno-2", 1), archivedAt: "2026-02-02T10:00:00.000Z" });

    const store = new FirestoreLearningStore();
    const entries = await store.listArchivedProgress("alumno-1");

    expect(entries).toHaveLength(1);
    expect(entries[0].uid).toBe("alumno-1");
    expect(entries[0].courseId).toBe("curso-a");
    expect(entries[0].archivedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(entries[0].completedAt).toBe("2026-01-11T09:00:00.000Z");
  });

  it("normaliza un archivedAt antiguo guardado como Timestamp", async () => {
    // Es lo que escribía `saveProgress` antes de unificar el tipo.
    await db
      .collection("progressHistory")
      .doc("alumno-3_curso-a_v1")
      .set({ ...progressOf("alumno-3", 1), archivedAt: Timestamp.fromDate(new Date("2026-02-03T10:00:00.000Z")) });

    const store = new FirestoreLearningStore();
    const entries = await store.listArchivedProgress("alumno-3");

    expect(entries).toHaveLength(1);
    expect(entries[0].archivedAt).toBe("2026-02-03T10:00:00.000Z");
  });

  it("lo que escribe el servidor vuelve a leerse como cadena ISO (sin mezclar tipos)", async () => {
    const store = new FirestoreLearningStore();
    const progress = progressOf("alumno-4", 2);

    // `saveProgress` con archivo es el camino que antes usaba serverTimestamp().
    await store.saveProgress(progress, progressOf("alumno-4", 1));

    const raw = await db.collection("progressHistory").doc("alumno-4_curso-a_v1").get();
    expect(typeof raw.get("archivedAt")).toBe("string");
    expect(raw.get("serverUpdatedAt")).toBeTruthy();

    const entries = await store.listArchivedProgress("alumno-4");
    expect(entries).toHaveLength(1);
    expect(entries[0].archivedAt).toBe(progress.updatedAt);
  });

  it("archiva también al registrar un intento que provoca cambio de versión", async () => {
    const store = new FirestoreLearningStore();
    const previous = progressOf("alumno-5", 1);
    const next = { ...progressOf("alumno-5", 2), completedAt: null, updatedAt: "2026-03-01T10:00:00.000Z" };

    await store.saveProgress(previous);
    await store.commitAttempt({
      attempt: {
        uid: "alumno-5",
        courseId: "curso-a",
        version: 2,
        assessmentType: "topic",
        topicId: "tema-1",
        answers: [{ questionId: "q-1", selectedOptionIds: ["a"] }],
        passed: true,
        correctCount: 1,
        totalQuestions: 1,
        score: 100,
        at: "2026-03-01T10:00:00.000Z",
        gradedBy: "server",
      },
      progress: next,
      archive: previous,
    });

    const raw = await db.collection("progressHistory").doc("alumno-5_curso-a_v1").get();
    expect(typeof raw.get("archivedAt")).toBe("string");
    expect(await store.listArchivedProgress("alumno-5")).toHaveLength(1);
  }, 30_000);

  it("el archivo y el progreso nuevo son atómicos: si falla, no queda histórico suelto", async () => {
    const store = new FirestoreLearningStore();
    // Un progreso inválido hace fallar la validación antes de escribir nada.
    await expect(
      store.saveProgress(
        { ...progressOf("alumno-6", 2), version: 0 } as never,
        progressOf("alumno-6", 1),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_PROGRESS_INVALID" });

    const snapshot = await db.collection("progressHistory").doc("alumno-6_curso-a_v1").get();
    expect(snapshot.exists).toBe(false);
  });
});
