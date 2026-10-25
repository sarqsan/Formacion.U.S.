import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import type { CourseVersionDefinition } from "@/domain/courses/content";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  draftEditorView,
  saveDraftStructure,
  startDraft,
  type DraftStructure,
} from "@/server/courses/editor";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import {
  adminCreateCourse,
  adminDraftEditor,
  adminEnroll,
  adminSaveDraftStructure,
  adminStartDraft,
  coursesForLearner,
  courseViewForLearner,
} from "@/demo/service";
import { resetDemoState } from "@/demo/store";
import {
  ADMIN,
  FIXED_NOW,
  InMemoryCatalogStore,
  LEARNER,
  makeDefinition,
  makeTopic,
} from "../helpers/db-doubles";
import { draftSavedRedirect } from "@/server/courses/draft-form";

/**
 * EDITOR DE BORRADORES: LO QUE SE GUARDA, LO QUE NO SE TOCA Y LO QUE NO SE PISA
 * ===========================================================================
 *
 * Cada prueba corresponde a una promesa del bloque 04:
 *
 *   1. un curso existente sin versiones empieza por un borrador v1;
 *   2. un borrador **vacío** se guarda;
 *   3. uno **incompleto** se guarda y se recupera tal cual;
 *   4. crear, editar y reordenar temas conserva identificadores y datos;
 *   5. obligatorio/opcional persiste;
 *   6. la versión publicada **no cambia** al crear o editar su sucesora;
 *   7. dos operaciones concurrentes se detectan, no se pisan;
 *   8. un fallo de persistencia no produce ningún éxito falso;
 *   9. el mismo contrato se cumple con los dobles y con la demo;
 *  10. un borrador no aparece nunca como contenido publicado al alumnado.
 *
 * Aviso de alcance: los dobles y la demo son memoria. Nada de esto demuestra
 * que Firestore escriba: la transacción real no se puede ejecutar aquí (sin
 * credenciales ni emulador) y queda declarada como no verificada.
 */

function setup() {
  const store = new InMemoryCatalogStore();
  return { store, deps: { store, now: () => FIXED_NOW } };
}

/** Curso recién creado: ficha sin versiones, como la deja el alta del bloque 03. */
function seedEmptyCourse(store: InMemoryCatalogStore, courseId = "curso-nuevo") {
  store.courses.set(courseId, {
    courseId,
    title: "Curso nuevo",
    publishedVersion: null,
    lastDraftVersion: null,
  });
}

function structure(overrides: Partial<DraftStructure> = {}): DraftStructure {
  return { title: "Curso nuevo", topics: [], ...overrides };
}

function codes(issues: ReadonlyArray<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

async function readDefinition(
  store: InMemoryCatalogStore,
  courseId: string,
  version: number,
): Promise<CourseVersionDefinition | null> {
  const document = await store.getVersion(courseId, version);
  if (!document) return null;
  return definitionFromDocuments(document, await store.getAnswerKeys(courseId, version));
}

// ---------------------------------------------------------------------------
// 1. Primer borrador de un curso existente
// ---------------------------------------------------------------------------

describe("startDraft: primer borrador", () => {
  it("un curso sin versiones empieza en la versión 1, en borrador y sin publicar", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    const result = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    expect(result).toEqual({
      courseId: "curso-nuevo",
      version: 1,
      created: true,
      revision: 1,
      clonedFrom: null,
    });

    const version = await store.getVersion("curso-nuevo", 1);
    expect(version).toMatchObject({ status: "draft", version: 1, revision: 1 });
    // Vacío de verdad: ni temas ni examen, y sin documento de claves.
    expect(version?.topics).toEqual([]);
    expect(version?.finalExam).toEqual([]);
    expect(await store.getAnswerKeys("curso-nuevo", 1)).toBeNull();

    // La ficha apunta al borrador y sigue sin versión publicada.
    expect(await store.getCourse("curso-nuevo")).toMatchObject({
      publishedVersion: null,
      lastDraftVersion: 1,
    });
  });

  it("reabrir reanuda el mismo borrador: no crea una versión nueva", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    const first = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);
    const second = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ version: 1, created: false, revision: 1 });
    expect(await store.listVersions("curso-nuevo")).toHaveLength(1);
  });

  it("solo un administrador activo puede abrir un borrador", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    await expect(startDraft({ actor: LEARNER, courseId: "curso-nuevo" }, deps)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    // Y no ha dejado nada escrito.
    expect(await store.listVersions("curso-nuevo")).toEqual([]);
  });

  it("un curso inexistente no crea nada", async () => {
    const { store, deps } = setup();

    await expect(
      startDraft({ actor: ADMIN, courseId: "no-existe" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_FOUND" });
    expect(store.versions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2 y 3. Guardar vacío e incompleto, y recuperarlo
// ---------------------------------------------------------------------------

describe("saveDraftStructure: se guarda lo incompleto", () => {
  it("guarda un borrador vacío y lo deja recuperable", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);
    await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    const saved = await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-nuevo",
        version: 1,
        expectedRevision: 1,
        structure: structure({ description: "Todavía sin contenido" }),
      },
      deps,
    );

    expect(saved).toMatchObject({ version: 1, revision: 2 });
    expect(codes(saved.warnings)).toEqual(
      expect.arrayContaining(["COURSE_NO_TOPICS", "FINAL_EXAM_EMPTY"]),
    );

    const recovered = await readDefinition(store, "curso-nuevo", 1);
    expect(recovered).toMatchObject({
      title: "Curso nuevo",
      description: "Todavía sin contenido",
      topics: [],
      finalExam: [],
    });
  });

  it("guarda y recupera un borrador incompleto sin exigir documentos, cuestionarios ni examen", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);
    await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    const saved = await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-nuevo",
        version: 1,
        expectedRevision: 1,
        structure: structure({
          title: "Curso a medias",
          description: "",
          topics: [
            { id: "tema-uno", title: "Tema uno", order: 1, mandatory: true },
            { id: "tema-dos", title: "Tema dos", order: 2, mandatory: false },
          ],
        }),
      },
      deps,
    );

    expect(codes(saved.warnings)).toEqual(
      expect.arrayContaining([
        "TOPIC_WITHOUT_DOCUMENTS",
        "TOPIC_WITHOUT_QUIZ",
        "FINAL_EXAM_EMPTY",
      ]),
    );

    const recovered = await readDefinition(store, "curso-nuevo", 1);
    expect(recovered?.title).toBe("Curso a medias");
    expect(recovered?.description).toBeUndefined();
    expect(recovered?.topics.map((topic) => [topic.id, topic.order, topic.mandatory])).toEqual([
      ["tema-uno", 1, true],
      ["tema-dos", 2, false],
    ]);
    // Sigue siendo un borrador: guardar no publica.
    expect((await store.getVersion("curso-nuevo", 1))?.status).toBe("draft");
    expect((await store.getCourse("curso-nuevo"))?.publishedVersion).toBeNull();
  });

  it("rechaza una estructura rota sin escribir nada (y con mensaje claro)", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);
    await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    const before = await store.getVersion("curso-nuevo", 1);

    await expect(
      saveDraftStructure(
        {
          actor: ADMIN,
          courseId: "curso-nuevo",
          version: 1,
          expectedRevision: 1,
          structure: structure({
            topics: [
              { id: "tema-uno", title: "Uno", order: 1, mandatory: true },
              { id: "tema-uno", title: "Repetido", order: 2, mandatory: true },
            ],
          }),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "COURSE_STRUCTURE_INVALID" });

    expect(await store.getVersion("curso-nuevo", 1)).toEqual(before);
  });

  it("no edita una versión publicada ni una archivada", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    const published = await store.getVersion("curso-a", 1);

    await expect(
      saveDraftStructure(
        {
          actor: ADMIN,
          courseId: "curso-a",
          version: 1,
          expectedRevision: 0,
          structure: structure({ title: "Secuestrado" }),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "VERSION_NOT_EDITABLE" });

    expect(await store.getVersion("curso-a", 1)).toEqual(published);
  });
});

// ---------------------------------------------------------------------------
// 4 y 5. Temas: crear, editar, reordenar y obligatoriedad
// ---------------------------------------------------------------------------

describe("saveDraftStructure: temas", () => {
  async function draftFromPublished() {
    const { store, deps } = setup();
    store.seedPublished(
      makeDefinition({
        topics: [
          makeTopic({ id: "tema-1", order: 1 }),
          makeTopic({ id: "tema-2", order: 2, mandatory: false }),
        ],
      }),
    );
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);
    return { store, deps, opened };
  }

  it("crea el borrador como copia profunda de la publicada, con documentos y cuestionarios", async () => {
    const { store, opened } = await draftFromPublished();

    expect(opened).toMatchObject({ version: 2, created: true, clonedFrom: 1 });

    const definition = await readDefinition(store, "curso-a", 2);
    expect(definition?.topics.map((topic) => topic.id)).toEqual(["tema-1", "tema-2"]);
    expect(definition?.topics[0].documents).toEqual([
      { id: "doc-tema-1", title: "PDF tema-1", pageCount: 3 },
    ]);
    expect(definition?.topics[0].quiz[0]).toMatchObject({ id: "q-tema-1", correctOptionIds: ["a"] });
    // Las claves de la versión nueva apuntan a la versión nueva.
    expect(await store.getAnswerKeys("curso-a", 2)).toMatchObject({ version: 2 });
  });

  it("crear, editar y reordenar conserva identificadores y contenido no editado", async () => {
    const { store, deps, opened } = await draftFromPublished();

    const saved = await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: {
          title: "Curso A (revisado)",
          description: "Nueva descripción",
          topics: [
            // El nuevo entra el primero, con orden inventado a propósito.
            { id: "tema-nuevo", title: "Tema nuevo", order: 40, mandatory: true },
            { id: "tema-2", title: "Tema dos (renombrado)", order: 20, mandatory: false },
            { id: "tema-1", title: "Tema uno", order: 10, mandatory: true },
          ],
        },
      },
      deps,
    );

    expect(saved.revision).toBe(opened.revision + 1);

    const definition = await readDefinition(store, "curso-a", opened.version);
    expect(definition?.title).toBe("Curso A (revisado)");
    expect(definition?.description).toBe("Nueva descripción");

    // Orden normalizado y determinista: 1..n en el orden pedido.
    expect(definition?.topics.map((topic) => [topic.id, topic.order])).toEqual([
      ["tema-1", 1],
      ["tema-2", 2],
      ["tema-nuevo", 3],
    ]);

    // El id es estable y con él su contenido: documentos y cuestionario intactos.
    const tema1 = definition?.topics.find((topic) => topic.id === "tema-1");
    expect(tema1?.documents.map((document) => document.id)).toEqual(["doc-tema-1"]);
    expect(tema1?.quiz.map((question) => question.id)).toEqual(["q-tema-1"]);

    // El tema nuevo entra vacío: este editor no inventa contenido.
    const nuevo = definition?.topics.find((topic) => topic.id === "tema-nuevo");
    expect(nuevo?.documents).toEqual([]);
    expect(nuevo?.quiz).toEqual([]);

    // El examen final no se toca en este bloque.
    expect(definition?.finalExam.map((question) => question.id)).toEqual(["q-final"]);
  });

  it("persiste obligatorio/opcional en ambos sentidos", async () => {
    const { store, deps, opened } = await draftFromPublished();

    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: {
          title: "Curso A",
          topics: [
            { id: "tema-1", title: "Tema uno", order: 1, mandatory: false },
            { id: "tema-2", title: "Tema dos", order: 2, mandatory: true },
          ],
        },
      },
      deps,
    );

    const definition = await readDefinition(store, "curso-a", opened.version);
    expect(definition?.topics.map((topic) => [topic.id, topic.mandatory])).toEqual([
      ["tema-1", false],
      ["tema-2", true],
    ]);

    // Y el editor lo muestra con ese mismo valor.
    const view = draftEditorView({
      course: (await store.getCourse("curso-a"))!,
      version: (await store.getVersion("curso-a", opened.version))!,
      definition: definition!,
    });
    expect(view.topics.map((topic) => [topic.id, topic.mandatory])).toEqual([
      ["tema-1", false],
      ["tema-2", true],
    ]);
  });

  it("eliminar un tema del borrador no toca la versión publicada", async () => {
    const { store, deps, opened } = await draftFromPublished();

    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: { title: "Curso A", topics: [{ id: "tema-1", title: "Tema uno", order: 1, mandatory: true }] },
      },
      deps,
    );

    const published = await readDefinition(store, "curso-a", 1);
    expect(published?.topics.map((topic) => topic.id)).toEqual(["tema-1", "tema-2"]);
  });

  it("eliminar un tema arrastra sus claves: no quedan respuestas huérfanas", async () => {
    const { store, deps, opened } = await draftFromPublished();

    // El borrador nace con las claves de la publicada.
    const keysBefore = await store.getAnswerKeys("curso-a", opened.version);
    expect(Object.keys(keysBefore?.quizByTopic ?? {})).toContain("tema-2");

    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        // Solo se conserva el tema 1: el 2 desaparece del borrador.
        structure: {
          title: "Curso A",
          topics: [{ id: "tema-1", title: "Tema uno", order: 1, mandatory: true }],
        },
      },
      deps,
    );

    const keysAfter = await store.getAnswerKeys("curso-a", opened.version);
    expect(Object.keys(keysAfter?.quizByTopic ?? {})).toEqual(["tema-1"]);
    expect(JSON.stringify(keysAfter)).not.toContain("q-tema-2");

    // Y la publicada conserva las suyas intactas.
    const publishedKeys = await store.getAnswerKeys("curso-a", 1);
    expect(Object.keys(publishedKeys?.quizByTopic ?? {})).toEqual(["tema-1", "tema-2"]);
  });
});

// ---------------------------------------------------------------------------
// 6. La publicada no se modifica
// ---------------------------------------------------------------------------

describe("la versión publicada es inmutable", () => {
  it("crear y editar su sucesora no cambia ni un campo de la publicada", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    const snapshot = structuredClone(await store.getVersion("curso-a", 1));
    const keys = structuredClone(await store.getAnswerKeys("curso-a", 1));

    const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);
    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-a",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: {
          title: "Otro título",
          topics: [{ id: "tema-1", title: "Renombrado", order: 1, mandatory: false }],
        },
      },
      deps,
    );

    expect(await store.getVersion("curso-a", 1)).toEqual(snapshot);
    expect(await store.getAnswerKeys("curso-a", 1)).toEqual(keys);
    // El curso sigue apuntando a la publicada.
    expect((await store.getCourse("curso-a"))?.publishedVersion).toBe(1);
  });

  it("el clon no comparte referencias con la publicada", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);

    const draft = await store.getVersion("curso-a", opened.version);
    const published = await store.getVersion("curso-a", 1);

    // Misma forma, objetos distintos en todos los niveles.
    expect(draft?.topics).toEqual(published?.topics);
    expect(draft?.topics).not.toBe(published?.topics);
    expect(draft?.topics[0]).not.toBe(published?.topics[0]);
    expect(draft?.topics[0].documents[0]).not.toBe(published?.topics[0].documents[0]);
    expect(draft?.topics[0].quiz[0]).not.toBe(published?.topics[0].quiz[0]);
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrencia y reintentos
// ---------------------------------------------------------------------------

describe("concurrencia", () => {
  it("dos guardados con la misma revisión: el segundo no pisa, recibe DRAFT_STALE", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-nuevo",
        version: 1,
        expectedRevision: opened.revision,
        structure: structure({ title: "Guardado de la primera pestaña" }),
      },
      deps,
    );

    await expect(
      saveDraftStructure(
        {
          actor: ADMIN,
          courseId: "curso-nuevo",
          version: 1,
          expectedRevision: opened.revision,
          structure: structure({ title: "Guardado de la segunda pestaña" }),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DRAFT_STALE", status: 409 });

    // Lo guardado es lo primero, y la revisión avanzó una sola vez.
    const version = await store.getVersion("curso-nuevo", 1);
    expect(version?.title).toBe("Guardado de la primera pestaña");
    expect(version?.revision).toBe(2);
  });

  it("si otra operación creó el borrador entre la lectura y la escritura, se reanuda en vez de duplicar", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    // Simula la carrera: otra pestaña escribe justo antes de la comprobación.
    store.beforeCreateDraft = () => {
      store.courses.set("curso-nuevo", {
        courseId: "curso-nuevo",
        title: "Curso nuevo",
        publishedVersion: null,
        lastDraftVersion: 1,
      });
      store.versions.set("curso-nuevo@1", {
        courseId: "curso-nuevo",
        version: 1,
        status: "draft",
        revision: 1,
        title: "Curso nuevo",
        description: null,
        topics: [],
        finalExam: [],
        createdAt: FIXED_NOW.toISOString(),
        createdBy: ADMIN.uid,
        publishedAt: null,
        publishedBy: null,
      });
    };

    const result = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);

    expect(result).toMatchObject({ version: 1, created: false });
    expect(await store.listVersions("curso-nuevo")).toHaveLength(1);
    expect((await store.getCourse("curso-nuevo"))?.lastDraftVersion).toBe(1);
  });

  it("dos aperturas simultáneas acaban en la misma versión", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    const [a, b] = await Promise.all([
      startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps),
      startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps),
    ]);

    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    // Una la creó y la otra la reanudó: nunca dos borradores.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await store.listVersions("curso-nuevo")).toHaveLength(1);
  });

  it("no sobrescribe una versión existente que no sea borrador", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    // Una v2 publicada de la que el puntero de borrador no sabe nada.
    store.versions.set("curso-a@2", {
      ...(await store.getVersion("curso-a", 1))!,
      version: 2,
      status: "published",
      publishedAt: FIXED_NOW.toISOString(),
      publishedBy: ADMIN.uid,
    });

    await expect(
      startDraft({ actor: ADMIN, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    expect((await store.getVersion("curso-a", 2))?.status).toBe("published");
  });

  it("no clona si la publicada perdió sus claves de corrección", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    store.keys.delete("curso-a@1");

    await expect(
      startDraft({ actor: ADMIN, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "ANSWER_KEYS_MISSING" });

    expect(await store.listVersions("curso-a")).toHaveLength(1);
  });

  it("publicar consume el borrador: el puntero queda a null y la siguiente apertura crea v+1", async () => {
    const { store, deps } = setup();
    store.seedPublished(makeDefinition());
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);
    expect(opened.version).toBe(2);

    await store.publishVersion({
      courseId: "curso-a",
      version: opened.version,
      publishedAt: FIXED_NOW.toISOString(),
      publishedBy: ADMIN.uid,
    });

    expect(await store.getCourse("curso-a")).toMatchObject({
      publishedVersion: 2,
      lastDraftVersion: null,
    });

    const next = await startDraft({ actor: ADMIN, courseId: "curso-a" }, deps);
    expect(next).toMatchObject({ version: 3, created: true, clonedFrom: 2 });
    // La versión anterior quedó archivada, no borrada.
    expect((await store.getVersion("curso-a", 1))?.status).toBe("archived");
  });

  it("no clona si la publicada no existe (puntero incoherente)", async () => {
    const { store, deps } = setup();
    store.courses.set("curso-a", {
      courseId: "curso-a",
      title: "Curso A",
      publishedVersion: 3,
      lastDraftVersion: null,
    });

    await expect(
      startDraft({ actor: ADMIN, courseId: "curso-a" }, deps),
    ).rejects.toMatchObject({ code: "VERSION_STATE_INCONSISTENT" });
  });
});

// ---------------------------------------------------------------------------
// 8. Errores de persistencia: nunca un éxito falso
// ---------------------------------------------------------------------------

describe("errores de persistencia", () => {
  it("si el almacén falla al guardar, el servicio falla y no queda nada escrito", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);
    const before = await store.getVersion("curso-nuevo", 1);

    const failing: CourseCatalogStore = Object.create(store);
    failing.replaceDraftContent = async () => {
      throw new DomainError("FIRESTORE_UNAVAILABLE", "La base de datos no responde.", 503);
    };

    await expect(
      saveDraftStructure(
        {
          actor: ADMIN,
          courseId: "curso-nuevo",
          version: 1,
          expectedRevision: opened.revision,
          structure: structure({ title: "No se guardará" }),
        },
        { store: failing, now: () => FIXED_NOW },
      ),
    ).rejects.toMatchObject({ code: "FIRESTORE_UNAVAILABLE", status: 503 });

    expect(await store.getVersion("curso-nuevo", 1)).toEqual(before);
  });

  it("si falla la creación del borrador, el curso sigue sin versiones", async () => {
    const { store } = setup();
    seedEmptyCourse(store);

    const failing: CourseCatalogStore = Object.create(store);
    failing.createDraftVersion = async () => {
      throw new DomainError("FIRESTORE_UNAVAILABLE", "La base de datos no responde.", 503);
    };

    await expect(
      startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, { store: failing, now: () => FIXED_NOW }),
    ).rejects.toMatchObject({ code: "FIRESTORE_UNAVAILABLE" });

    expect(await store.listVersions("curso-nuevo")).toEqual([]);
    expect((await store.getCourse("curso-nuevo"))?.lastDraftVersion).toBeNull();
  });

  it("la pantalla solo dice «guardado» cuando el servicio confirmó", () => {
    const ok = draftSavedRedirect({ courseId: "curso-nuevo", version: 1, failure: null });
    expect(ok).toContain("ok=guardado");
    expect(ok).not.toContain("error=");

    const failed = draftSavedRedirect({
      courseId: "curso-nuevo",
      version: 1,
      failure: "El borrador se ha modificado desde que abriste el editor.",
    });
    expect(failed).toContain("error=");
    expect(failed).not.toContain("ok=");
  });
});

// ---------------------------------------------------------------------------
// 9. Mismo contrato en la demo y en los dobles
// ---------------------------------------------------------------------------

describe("equivalencia demo ↔ contrato real", () => {
  beforeEach(() => {
    resetDemoState();
  });

  it("la demo recorre el mismo camino con los mismos resultados", async () => {
    const { store, deps } = setup();
    seedEmptyCourse(store);

    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };

    // --- dobles ---
    const realOpen = await startDraft({ actor: ADMIN, courseId: "curso-nuevo" }, deps);
    const realSaved = await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-nuevo",
        version: realOpen.version,
        expectedRevision: realOpen.revision,
        structure: {
          title: "Curso nuevo",
          topics: [{ id: "tema-uno", title: "Tema uno", order: 1, mandatory: true }],
        },
      },
      deps,
    );

    // --- demo ---
    await adminCreateCourse(demoAdmin, { courseId: "curso-nuevo", title: "Curso nuevo" });
    const demoOpen = await adminStartDraft(demoAdmin, "curso-nuevo");
    const demoSaved = await adminSaveDraftStructure(demoAdmin, {
      courseId: "curso-nuevo",
      version: demoOpen.version,
      expectedRevision: demoOpen.revision,
      structure: {
        title: "Curso nuevo",
        topics: [{ id: "tema-uno", title: "Tema uno", order: 1, mandatory: true }],
      },
    });

    expect({
      version: demoOpen.version,
      created: demoOpen.created,
      clonedFrom: demoOpen.clonedFrom,
    }).toEqual({
      version: realOpen.version,
      created: realOpen.created,
      clonedFrom: realOpen.clonedFrom,
    });
    expect(demoSaved).toEqual(realSaved);

    const demoView = await adminDraftEditor("curso-nuevo", demoOpen.version);
    expect(demoView?.topics).toEqual([
      {
        id: "tema-uno",
        title: "Tema uno",
        order: 1,
        mandatory: true,
        documents: 0,
        documentList: [],
        questions: 0,
        quiz: [],
        screens: [],
      },
    ]);
    expect(demoView?.revision).toBe(realSaved.revision);

    // Reabrir en la demo también reanuda, no crea otra versión.
    const demoReopened = await adminStartDraft(demoAdmin, "curso-nuevo");
    expect(demoReopened).toMatchObject({ version: demoOpen.version, created: false });
  });

  it("la demo detecta el guardado obsoleto igual que el doble", async () => {
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    await adminCreateCourse(demoAdmin, { courseId: "curso-demo-conflicto", title: "Curso" });
    const opened = await adminStartDraft(demoAdmin, "curso-demo-conflicto");

    await adminSaveDraftStructure(demoAdmin, {
      courseId: "curso-demo-conflicto",
      version: opened.version,
      expectedRevision: opened.revision,
      structure: { title: "Primera pestaña", topics: [] },
    });

    await expect(
      adminSaveDraftStructure(demoAdmin, {
        courseId: "curso-demo-conflicto",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: { title: "Segunda pestaña", topics: [] },
      }),
    ).rejects.toMatchObject({ code: "DRAFT_STALE" });

    expect((await adminDraftEditor("curso-demo-conflicto", opened.version))?.title).toBe(
      "Primera pestaña",
    );
  });
});

// ---------------------------------------------------------------------------
// 10. El borrador no es contenido publicado
// ---------------------------------------------------------------------------

describe("el alumnado nunca ve un borrador como publicado", () => {
  beforeEach(() => {
    resetDemoState();
  });

  const COURSE = "curso-proteccion-datos";

  it("editar el borrador no cambia lo que ve el alumno matriculado", async () => {
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    // La alumna se matricula en la versión publicada (v1) y luego se edita el
    // borrador de la v2: lo que ve no puede cambiar.
    await adminEnroll(demoAdmin, LEARNER.uid, COURSE);

    const before = await courseViewForLearner(LEARNER, COURSE);
    expect(before.version).toBe(1);

    // La demo ya trae un borrador v2 sembrado: abrirlo lo reanuda, no lo duplica.
    const opened = await adminStartDraft(demoAdmin, COURSE);
    expect(opened).toMatchObject({ version: 2, created: false });

    await adminSaveDraftStructure(demoAdmin, {
      courseId: COURSE,
      version: opened.version,
      expectedRevision: opened.revision,
      structure: {
        title: "Título del borrador que no debe verse",
        description: "Descripción no publicada",
        topics: [{ id: "tema-inventado", title: "Tema no publicado", order: 1, mandatory: true }],
      },
    });

    const after = await courseViewForLearner(LEARNER, COURSE);
    expect(after.version).toBe(1);
    expect(after.title).toBe(before.title);
    expect(after.description).toBe(before.description);
    expect(after.topics.map((topic) => topic.id)).toEqual(before.topics.map((topic) => topic.id));
    expect(after.topics.map((topic) => topic.id)).not.toContain("tema-inventado");
  });

  it("el catálogo del alumno sigue anunciando la versión publicada", async () => {
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    await adminEnroll(demoAdmin, LEARNER.uid, COURSE);

    const opened = await adminStartDraft(demoAdmin, COURSE);
    await adminSaveDraftStructure(demoAdmin, {
      courseId: COURSE,
      version: opened.version,
      expectedRevision: opened.revision,
      structure: { title: "Borrador", topics: [] },
    });

    const card = (await coursesForLearner(LEARNER)).find((item) => item.courseId === COURSE);
    expect(card?.version).toBe(1);
    expect(card?.title).not.toBe("Borrador");
  });

  it("un curso con solo borrador no entra en el catálogo del alumnado", async () => {
    const demoAdmin: Actor = { uid: "demo-admin", role: "admin", status: "active" };
    await adminCreateCourse(demoAdmin, { courseId: "curso-solo-borrador", title: "Solo borrador" });
    await adminStartDraft(demoAdmin, "curso-solo-borrador");

    const catalog = await coursesForLearner(LEARNER);
    expect(catalog.map((item) => item.courseId)).not.toContain("curso-solo-borrador");
  });
});
