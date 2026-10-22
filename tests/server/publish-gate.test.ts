import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkPublishableDocuments,
  publishCourseVersion,
  toAnswerKeys,
  toPublicVersion,
} from "@/server/courses/catalog";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import type { CourseVersionDocument } from "@/server/courses/catalog";
import { DomainError } from "@/domain/text";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  makeDefinition,
  makeTopic,
} from "../helpers/db-doubles";
import { PublishingDocuments } from "../helpers/document-double";
import { adminArchivePdfDocument, adminPublish } from "@/demo/service";
import { demoState, resetDemoState } from "@/demo/store";

/**
 * PUBLICACIÓN: LA PUERTA DEL SERVIDOR (bloque 08)
 * ===============================================
 *
 * Publicar es lo único que hace visible un curso al alumnado, así que el
 * servidor no puede fiarse de que la interfaz haya desactivado el botón.
 *
 * Estas pruebas fijan cuatro invariantes:
 *
 *   1. **Contenido**: se publica lo mismo que valida el editor
 *      (`validateCourseVersion`), aplicado a la definición reconstruida con sus
 *      claves. Un borrador a medias se guarda, pero no se publica.
 *   2. **Documentos**: cada PDF de la versión existe, está `active`, tiene
 *      todas sus partes y es de ese curso. Publicar no puede dejar un curso
 *      cuyos documentos devuelvan 404 al alumnado.
 *   3. **Nada a medias**: si algo falla, la versión sigue en borrador, el curso
 *      no cambia de versión publicada y no se llama al almacén.
 *   4. **Coherencia**: al publicar, la versión anterior pasa a `archived`, de
 *      modo que nunca hay dos `published`. Vale igual en los dobles, en la
 *      demostración y en el adaptador de Firestore.
 */

const DEMO_ADMIN = { uid: "demo-admin", role: "admin", status: "active" } as const;

function setup() {
  const store = new InMemoryCatalogStore();
  // Los documentos se dan por activos salvo que la prueba diga lo contrario.
  const documents = new PublishingDocuments({ autoActiveCourseId: "curso-a" });
  return { store, documents, deps: { store, documents, now: () => FIXED_NOW } };
}

/**
 * Deja un borrador tal y como lo guarda el editor: **sin** pasar por la
 * validación estricta. Es la única forma de reproducir un borrador incompleto,
 * que es exactamente lo que la publicación tiene que rechazar.
 */
function seedDraft(
  store: InMemoryCatalogStore,
  definition: CourseVersionDefinition,
): CourseVersionDocument {
  const createdAt = FIXED_NOW.toISOString();
  const version = toPublicVersion(definition, {
    createdAt,
    createdBy: ADMIN.uid,
    status: "draft",
  });
  store.courses.set(definition.courseId, {
    courseId: definition.courseId,
    title: definition.title,
    publishedVersion: null,
    lastDraftVersion: definition.version,
  });
  store.versions.set(`${definition.courseId}@${definition.version}`, version);
  store.keys.set(
    `${definition.courseId}@${definition.version}`,
    toAnswerKeys(definition, { createdAt }),
  );
  return version;
}

async function failureOf(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Se esperaba un DomainError y la operación terminó bien.");
}

describe("contenido: no se publica lo que el editor no permite publicar", () => {
  it("rechaza una versión sin temas", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition({ topics: [] }));

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("COURSE_CONTENT_INVALID");
    expect(error.status).toBe(400);
    expect(store.publishVersionCalls).toBe(0);
    expect(store.versions.get("curso-a@1")?.status).toBe("draft");
    expect(store.courses.get("curso-a")?.publishedVersion).toBeNull();
  });

  it("rechaza un tema obligatorio sin cuestionario", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition({ topics: [makeTopic({ id: "tema-1", quiz: [] })] }));

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("COURSE_CONTENT_INVALID");
    expect(store.publishVersionCalls).toBe(0);
  });

  it("rechaza una versión sin examen final", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition({ finalExam: [] }));

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("COURSE_CONTENT_INVALID");
  });

  it("no deja publicar a un alumno (el rol se comprueba antes que nada)", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition());

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: LEARNER }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(store.publishVersionCalls).toBe(0);
  });
});

describe("documentos: solo se publica lo que se puede servir", () => {
  it("publica cuando el documento está activo y completo", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition());

    const result = await publishCourseVersion(
      { courseId: "curso-a", version: 1, actor: ADMIN },
      deps,
    );

    expect(result).toMatchObject({ courseId: "curso-a", version: 1 });
    expect(store.versions.get("curso-a@1")?.status).toBe("published");
    expect(store.courses.get("curso-a")).toMatchObject({
      publishedVersion: 1,
      lastDraftVersion: null,
    });
  });

  it("rechaza un documento que no existe en el almacén", async () => {
    const store = new InMemoryCatalogStore();
    const documents = new PublishingDocuments(); // nada sembrado: todo inexistente
    const deps = { store, documents, now: () => FIXED_NOW };
    seedDraft(store, makeDefinition());

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({
      documents: [{ documentId: "doc-tema-1", problem: "missing" }],
    });
    expect(store.publishVersionCalls).toBe(0);
    expect(store.versions.get("curso-a@1")?.status).toBe("draft");
  });

  it("rechaza un documento pendiente o archivado", async () => {
    for (const state of ["pending", "aborted", "archived"]) {
      const { store, documents, deps } = setup();
      seedDraft(store, makeDefinition());
      documents.seed("doc-tema-1", { state });

      const error = await failureOf(() =>
        publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
      );

      expect(error.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
      expect(error.details).toMatchObject({
        documents: [{ documentId: "doc-tema-1", problem: "inactive" }],
      });
      expect(store.publishVersionCalls).toBe(0);
    }
  });

  it("rechaza un documento al que le faltan partes", async () => {
    const { store, documents, deps } = setup();
    seedDraft(store, makeDefinition());
    // Dos fragmentos declarados y solo uno recibido: nunca se verificó entero.
    documents.seed("doc-tema-1", { partsReceived: 1, chunkLengths: [1024, 512] });

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
    expect(error.details).toMatchObject({
      documents: [{ documentId: "doc-tema-1", problem: "incomplete" }],
    });
  });

  it("rechaza un documento de otro curso", async () => {
    const { store, documents, deps } = setup();
    seedDraft(store, makeDefinition());
    documents.seed("doc-tema-1", { courseId: "curso-b" });

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("DOCUMENT_NOT_PUBLISHABLE");
    expect(error.details).toMatchObject({
      documents: [{ documentId: "doc-tema-1", problem: "course" }],
    });
  });

  it("un identificador con forma de ruta lo rechaza antes la validación de contenido", async () => {
    const { store, deps } = setup();
    seedDraft(
      store,
      makeDefinition({
        topics: [
          makeTopic({
            id: "tema-1",
            documents: [{ id: "../privado", title: "Intento de ruta", pageCount: 1 }],
          }),
        ],
      }),
    );

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    // `validateCourseVersion` exige identificadores tipo slug, así que el
    // intento de ruta ni siquiera llega a la comprobación de documentos.
    expect(error.code).toBe("COURSE_CONTENT_INVALID");
    expect(error.details).toMatchObject({ issues: [{ code: "DOCUMENT_ID_INVALID" }] });
    expect(store.publishVersionCalls).toBe(0);
  });

  it("la comprobación de documentos también filtra identificadores inseguros", async () => {
    // Defensa en profundidad: si un documento llegara al almacén con un
    // identificador que no puede formar parte de una ruta, la puerta tampoco
    // lo deja publicar.
    const version = toPublicVersion(
      makeDefinition({
        topics: [
          makeTopic({
            id: "tema-1",
            documents: [{ id: "../../etc/passwd", title: "Ruta", pageCount: 1 }],
          }),
        ],
      }),
      { createdAt: FIXED_NOW.toISOString(), createdBy: ADMIN.uid, status: "draft" },
    );

    await expect(
      checkPublishableDocuments(version, new PublishingDocuments()),
    ).resolves.toEqual([{ documentId: "../../etc/passwd", problem: "id" }]);
  });

  it("informa de todos los documentos problemáticos de una vez", async () => {
    const { store, documents, deps } = setup();
    seedDraft(
      store,
      makeDefinition({
        topics: [
          makeTopic({ id: "tema-1", order: 1 }),
          makeTopic({ id: "tema-2", order: 2 }),
        ],
      }),
    );
    documents.seed("doc-tema-1", { state: "archived" });
    documents.seed("doc-tema-2", { partsReceived: 0, chunkLengths: [1024] });

    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.details).toMatchObject({
      documents: [
        { documentId: "doc-tema-1", problem: "inactive" },
        { documentId: "doc-tema-2", problem: "incomplete" },
      ],
    });
  });
});

describe("coherencia de las versiones", () => {
  it("una versión se publica una sola vez: error tipado, no un 500", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition());
    await publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps);

    // Segunda publicación de la misma versión.
    const error = await failureOf(() =>
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    );

    expect(error.code).toBe("VERSION_ALREADY_PUBLISHED");
    expect(error.status).toBe(409);
    expect(store.publishVersionCalls).toBe(1);
  });

  it("los dobles archivan la anterior y dejan una sola publicada", async () => {
    const { store, deps } = setup();
    seedDraft(store, makeDefinition());
    await publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps);

    seedDraft(store, makeDefinition({ version: 2, title: "Curso A (v2)" }));
    await publishCourseVersion({ courseId: "curso-a", version: 2, actor: ADMIN }, deps);

    const versions = await store.listVersions("curso-a");
    expect(versions.filter((item) => item.status === "published")).toEqual([
      { version: 2, status: "published" },
    ]);
    expect(versions.find((item) => item.version === 1)?.status).toBe("archived");
    // La tercera versión se puede publicar: no queda estado inconsistente.
    seedDraft(store, makeDefinition({ version: 3, title: "Curso A (v3)" }));
    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 3, actor: ADMIN }, deps),
    ).resolves.toMatchObject({ version: 3 });
  });
});

describe("la demostración pasa por la misma puerta", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("archiva la versión anterior y deja solo la nueva publicada", async () => {
    await adminPublish(DEMO_ADMIN, "curso-proteccion-datos", 2);

    const course = demoState().courses.get("curso-proteccion-datos")!;
    expect(course.summary.publishedVersion).toBe(2);
    expect(course.summary.lastDraftVersion).toBeNull();
    expect(course.versions.get(1)?.version.status).toBe("archived");
    expect(course.versions.get(2)?.version.status).toBe("published");
  });

  it("no publica si un documento del borrador se ha archivado después", async () => {
    // El documento se asoció cuando estaba activo; después se archiva. La
    // versión publicada anterior no se toca: el borrador sigue en borrador.
    await adminArchivePdfDocument(DEMO_ADMIN, "doc-soporte");

    await expect(adminPublish(DEMO_ADMIN, "curso-proteccion-datos", 2)).rejects.toMatchObject({
      code: "DOCUMENT_NOT_PUBLISHABLE",
    });

    const course = demoState().courses.get("curso-proteccion-datos")!;
    expect(course.summary.publishedVersion).toBe(1);
    expect(course.versions.get(2)?.version.status).toBe("draft");
  });
});

describe("adaptador de Firestore: el archivado va dentro de la transacción", () => {
  /**
   * Comprobación sobre el código, no una ejecución: Firestore no se puede
   * ejecutar aquí (sin emulador, sin credenciales y con la red hacia Google
   * cortada). Fija que la transacción archiva la versión anterior y mueve el
   * puntero, que es lo que la demostración y los dobles ya hacían.
   */
  it("lee el puntero, archiva la anterior y actualiza el curso", () => {
    const source = readFileSync("src/server/firebase/catalog-store.ts", "utf8");
    const start = source.indexOf("async publishVersion(");
    const end = source.indexOf("async createDraftVersion(");
    const transaction = source.slice(start, end);

    expect(transaction).toContain("db.runTransaction(");
    expect(transaction).toContain("publishedVersion");
    expect(transaction).toContain('status: "archived"');
    expect(transaction).toContain("publishedVersion: input.version");
    expect(transaction).toContain("lastDraftVersion: null");
    // Las lecturas de una transacción de Firestore van antes de las escrituras.
    expect(transaction.indexOf("transaction.get(")).toBeLessThan(
      transaction.indexOf("transaction.update("),
    );
  });
});
