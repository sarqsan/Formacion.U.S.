import { describe, expect, it } from "vitest";
import {
  publishCourseVersion,
  saveDraftVersion,
  toAnswerKeys,
  toPublicVersion,
} from "@/server/courses/catalog";
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

function setup() {
  const store = new InMemoryCatalogStore();
  // Estas pruebas van del orden de las versiones: los documentos se dan por
  // activos. La puerta de documentos tiene su propia batería
  // (`tests/server/publish-gate.test.ts`).
  const documents = new PublishingDocuments({ autoActiveCourseId: "curso-a" });
  const deps = { store, documents, now: () => FIXED_NOW };
  return { store, documents, deps };
}

describe("toPublicVersion / toAnswerKeys", () => {
  it("el documento público no contiene respuestas correctas", () => {
    const definition = makeDefinition({
      topics: [makeTopic({ id: "tema-1" }), makeTopic({ id: "tema-2", order: 2 })],
    });

    const publicVersion = toPublicVersion(definition, {
      createdAt: FIXED_NOW.toISOString(),
      createdBy: ADMIN.uid,
      status: "draft",
    });

    expect(JSON.stringify(publicVersion)).not.toContain("correctOptionIds");
    expect(publicVersion.topics[0].quiz[0]).not.toHaveProperty("correctOptionIds");
    expect(publicVersion.finalExam[0]).not.toHaveProperty("correctOptionIds");
    // El prompt se conserva: es contenido para el alumno.
    expect(publicVersion.topics[0].quiz[0].prompt).toBe("Pregunta q-tema-1");
  });

  it("las claves contienen exactamente lo que falta en el público", () => {
    const definition = makeDefinition();
    const keys = toAnswerKeys(definition, { createdAt: FIXED_NOW.toISOString() });

    expect(keys.quizByTopic["tema-1"][0].correctOptionIds).toEqual(["a"]);
    expect(keys.finalExam[0].correctOptionIds).toEqual(["b"]);
    expect(Object.keys(keys.quizByTopic)).toEqual(["tema-1"]);
  });

  it("el contenido público no expone ninguna ruta ni ubicación del PDF", () => {
    const publicVersion = toPublicVersion(makeDefinition({ version: 3 }), {
      createdAt: FIXED_NOW.toISOString(),
      createdBy: ADMIN.uid,
      status: "draft",
    });

    const document = publicVersion.topics[0].documents[0];
    expect(Object.keys(document).sort()).toEqual(["id", "pageCount", "title"]);
    expect(JSON.stringify(publicVersion)).not.toContain("storagePath");
    expect(JSON.stringify(publicVersion)).not.toContain("gs://");
    expect(JSON.stringify(publicVersion)).not.toContain("http");
  });

  it("ordena los temas por `order` aunque lleguen desordenados", () => {
    const publicVersion = toPublicVersion(
      makeDefinition({
        topics: [
          makeTopic({ id: "tema-2", order: 2 }),
          makeTopic({ id: "tema-1", order: 1 }),
        ],
      }),
      { createdAt: FIXED_NOW.toISOString(), createdBy: ADMIN.uid, status: "draft" },
    );

    expect(publicVersion.topics.map((topic) => topic.id)).toEqual(["tema-1", "tema-2"]);
  });
});

describe("saveDraftVersion", () => {
  it("guarda en borrador y las claves por separado", async () => {
    const { store, deps } = setup();

    const result = await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);

    expect(result).toEqual({ courseId: "curso-a", version: 1 });
    expect(store.saveVersionCalls).toBe(1);

    const version = await store.getVersion("curso-a", 1);
    expect(version?.status).toBe("draft");
    expect(version?.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(version?.createdBy).toBe(ADMIN.uid);
    expect(version?.publishedAt).toBeNull();

    const keys = await store.getAnswerKeys("curso-a", 1);
    expect(keys?.finalExam[0].correctOptionIds).toEqual(["b"]);

    // Lo guardado públicamente nunca lleva las claves.
    expect(JSON.stringify(version)).not.toContain("correctOptionIds");
  });

  it("rechaza a quien no es administrador", async () => {
    const { store, deps } = setup();

    await expect(
      saveDraftVersion({ definition: makeDefinition(), actor: LEARNER }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(store.saveVersionCalls).toBe(0);
  });

  it("rechaza una cuenta no activa aunque sea administradora", async () => {
    const { deps } = setup();

    await expect(
      saveDraftVersion(
        { definition: makeDefinition(), actor: { ...ADMIN, status: "pending_activation" } },
        deps,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("no sobrescribe una versión existente (las versiones son inmutables)", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);

    await expect(
      saveDraftVersion(
        { definition: makeDefinition({ title: "Otro título" }), actor: ADMIN },
        deps,
      ),
    ).rejects.toMatchObject({ code: "VERSION_ALREADY_EXISTS" });

    expect((await store.getVersion("curso-a", 1))?.title).toBe("Curso A");
  });

  it("valida el contenido antes de escribir nada", async () => {
    const { store, deps } = setup();

    await expect(
      saveDraftVersion(
        {
          definition: makeDefinition({
            topics: [makeTopic({ id: "tema-1", order: 1 }), makeTopic({ id: "tema-1", order: 2 })],
          }),
          actor: ADMIN,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(DomainError);

    expect(store.saveVersionCalls).toBe(0);
  });

  it("exige un tema obligatorio con cuestionario", async () => {
    const { store, deps } = setup();

    await expect(
      saveDraftVersion(
        { definition: makeDefinition({ topics: [makeTopic({ id: "tema-1", mandatory: false })] }), actor: ADMIN },
        deps,
      ),
    ).rejects.toBeInstanceOf(DomainError);

    expect(store.saveVersionCalls).toBe(0);
  });
});

describe("publishCourseVersion", () => {
  it("publica la versión siguiente y deja el curso apuntando a ella", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);

    const result = await publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps);

    expect(result).toEqual({
      courseId: "curso-a",
      version: 1,
      publishedAt: "2026-03-01T10:00:00.000Z",
    });
    expect(store.publishVersionCalls).toBe(1);

    const version = await store.getVersion("curso-a", 1);
    expect(version?.status).toBe("published");
    expect(version?.publishedBy).toBe(ADMIN.uid);
    expect(version?.publishedAt).toBe("2026-03-01T10:00:00.000Z");
    expect((await store.getCourse("curso-a"))?.publishedVersion).toBe(1);
  });

  it("rechaza publicar una versión que no está en borrador", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);
    await publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps);

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    ).rejects.toMatchObject({ code: "VERSION_ALREADY_PUBLISHED" });

    expect(store.publishVersionCalls).toBe(1);
  });

  it("no deja saltar de la v1 a la v3", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);
    await saveDraftVersion({ definition: makeDefinition({ version: 3 }), actor: ADMIN }, deps);

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 3, actor: ADMIN }, deps),
    ).rejects.toBeInstanceOf(DomainError);

    expect(store.publishVersionCalls).toBe(0);
  });

  it("se niega a publicar si faltan las claves de corrección", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);
    store.keys.delete("curso-a@1");

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    ).rejects.toMatchObject({ code: "ANSWER_KEYS_MISSING" });

    expect(store.publishVersionCalls).toBe(0);
    expect((await store.getVersion("curso-a", 1))?.status).toBe("draft");
  });

  it("se niega a publicar un documento con respuestas dentro", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);

    // Simula una escritura defectuosa: claves coladas en el documento público.
    const version = await store.getVersion("curso-a", 1);
    store.versions.set("curso-a@1", {
      ...version!,
      finalExam: [
        { id: "q-final", type: "single_choice", optionIds: ["a", "b", "c"], correctOptionIds: ["b"] },
      ] as never,
    });

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps),
    ).rejects.toMatchObject({ code: "CONTENT_LEAK" });

    expect(store.publishVersionCalls).toBe(0);
  });

  it("solo administradores pueden publicar", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);

    await expect(
      publishCourseVersion({ courseId: "curso-a", version: 1, actor: LEARNER }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(store.publishVersionCalls).toBe(0);
  });

  it("una versión nueva archiva la anterior sin borrarla", async () => {
    const { store, deps } = setup();
    await saveDraftVersion({ definition: makeDefinition(), actor: ADMIN }, deps);
    await publishCourseVersion({ courseId: "curso-a", version: 1, actor: ADMIN }, deps);

    await saveDraftVersion(
      { definition: makeDefinition({ version: 2, title: "Curso A (v2)" }), actor: ADMIN },
      deps,
    );
    await publishCourseVersion({ courseId: "curso-a", version: 2, actor: ADMIN }, deps);

    expect((await store.getVersion("curso-a", 1))?.status).toBe("archived");
    expect((await store.getVersion("curso-a", 2))?.status).toBe("published");
    expect((await store.getCourse("curso-a"))?.publishedVersion).toBe(2);
    // Las claves de la v1 siguen disponibles para el historial.
    expect(await store.getAnswerKeys("curso-a", 1)).not.toBeNull();
  });
});
