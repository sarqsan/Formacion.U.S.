import { describe, expect, it } from "vitest";
import { initProgress, type CourseProgress } from "@/domain/progress/course-progress";
import { accountHistory, learnerHistory } from "@/server/learning/history";
import type { StoredProgress } from "@/server/learning/store";
import { ADMIN, FIXED_NOW, InMemoryCatalogStore, InMemoryLearningStore, LEARNER } from "../helpers/db-doubles";
import { makeDefinition } from "../helpers/db-doubles";

/**
 * HISTÓRICO: SERVICIO
 * ===================
 *
 * Qué se lee de `progressHistory`, con qué forma y para quién. La persistencia
 * es un doble en memoria (el emulador no se puede ejecutar hoy), así que estas
 * pruebas demuestran la lógica del servicio, no que Firestore guarde nada.
 */

/** Progreso de un tema ya superado, con la forma completa del dominio. */
function topicPassed(topicId: string, bestScore = 100) {
  return {
    topicId,
    passed: true,
    attempts: 1,
    passedAt: "2026-01-10T09:00:00.000Z",
    lastAttemptAt: "2026-01-10T09:00:00.000Z",
    bestScore,
  };
}

function topicPending(topicId: string, bestScore = 60) {
  return {
    topicId,
    passed: false,
    attempts: 1,
    passedAt: null as string | null,
    lastAttemptAt: "2026-01-11T09:00:00.000Z",
    bestScore,
  };
}

function exam(passed: boolean, bestScore: number) {
  return {
    passed,
    attempts: 1,
    bestScore,
    passedAt: passed ? "2026-01-12T09:00:00.000Z" : null,
    lastAttemptAt: "2026-01-12T09:00:00.000Z",
  };
}

function stored(
  overrides: Partial<StoredProgress> & Pick<StoredProgress, "courseId" | "version">,
): StoredProgress {
  return {
    ...initProgress(overrides.courseId, overrides.version, ["tema-1", "tema-2"]),
    uid: LEARNER.uid,
    documents: {},
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  } as StoredProgress;
}

function setup() {
  const catalog = new InMemoryCatalogStore();
  catalog.seedPublished(makeDefinition({ courseId: "curso-a", version: 1, title: "Curso A" }));
  const learning = new InMemoryLearningStore();
  return { catalog, learning, deps: { catalog, learning } };
}

describe("learnerHistory", () => {
  it("devuelve el histórico vacío cuando nunca se archivó nada", async () => {
    const { deps } = setup();

    await expect(learnerHistory(deps, LEARNER)).resolves.toEqual({ entries: [], unresolved: 0 });
  });

  it("resume una versión archivada completa con el título que tenía entonces", async () => {
    const { catalog, learning, deps } = setup();
    learning.seedArchived(
      stored({
        courseId: "curso-a",
        version: 1,
        topics: { "tema-1": topicPassed("tema-1"), "tema-2": topicPassed("tema-2") },
        finalExam: exam(true, 90),
        completedAt: "2026-01-20T09:00:00.000Z",
      }),
      "2026-02-01T10:00:00.000Z",
    );

    const { entries, unresolved } = await learnerHistory(deps, LEARNER);

    expect(unresolved).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      courseId: "curso-a",
      courseTitle: "Curso A",
      version: 1,
      completed: true,
      completedAt: "2026-01-20T09:00:00.000Z",
      archivedAt: "2026-02-01T10:00:00.000Z",
      topicsPassed: 2,
      topicsTotal: 2,
      finalScore: 90,
      finalExamPassed: true,
      // La v1 sigue siendo la publicada: nada la ha sustituido.
      supersededBy: null,
    });

    // El histórico se lee, no se reescribe: el progreso vivo no aparece aquí.
    expect(await catalog.getCourse("curso-a")).toMatchObject({ publishedVersion: 1 });
  });

  it("muestra también lo que quedó a medias, marcado como incompleto", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(
      stored({
        courseId: "curso-a",
        version: 1,
        topics: { "tema-1": topicPassed("tema-1"), "tema-2": topicPending("tema-2") },
      }),
      "2026-02-01T10:00:00.000Z",
    );

    const { entries } = await learnerHistory(deps, LEARNER);

    expect(entries[0].completed).toBe(false);
    expect(entries[0].topicsPassed).toBe(1);
    expect(entries[0].topicsTotal).toBe(2);
  });

  it("indica qué versión sustituye a la archivada", async () => {
    const { catalog, learning, deps } = setup();
    catalog.seedPublished(makeDefinition({ courseId: "curso-a", version: 2, title: "Curso A v2" }));
    learning.seedArchived(stored({ courseId: "curso-a", version: 1 }), "2026-02-01T10:00:00.000Z");

    const { entries } = await learnerHistory(deps, LEARNER);

    expect(entries[0].version).toBe(1);
    // El título es el de la versión archivada, no el actual del curso.
    expect(entries[0].courseTitle).toBe("Curso A");
    expect(entries[0].supersededBy).toBe(2);
  });

  it("no mezcla el histórico de otras personas", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(
      stored({ courseId: "curso-a", version: 1, uid: "otra-persona" }),
      "2026-02-01T10:00:00.000Z",
    );
    learning.seedArchived(stored({ courseId: "curso-a", version: 1 }), "2026-02-02T10:00:00.000Z");

    const { entries } = await learnerHistory(deps, LEARNER);

    expect(entries).toHaveLength(1);
    expect(entries[0].archivedAt).toBe("2026-02-02T10:00:00.000Z");
  });

  it("cuenta los registros de cursos que ya no existen en vez de romperse", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(
      stored({ courseId: "curso-borrado", version: 1 }),
      "2026-02-01T10:00:00.000Z",
    );

    const { entries, unresolved } = await learnerHistory(deps, LEARNER);

    expect(entries).toEqual([]);
    expect(unresolved).toBe(1);
  });

  it("ordena lo más reciente primero, sin depender del orden del almacén", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(
      stored({ courseId: "curso-a", version: 1, completedAt: "2026-01-01T00:00:00.000Z" }),
      "2026-02-01T10:00:00.000Z",
    );
    learning.seedArchived(
      stored({ courseId: "curso-a", version: 2, completedAt: "2026-03-01T00:00:00.000Z" }),
      "2026-04-01T10:00:00.000Z",
    );

    const { entries } = await learnerHistory(deps, LEARNER);

    expect(entries.map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("rechaza una cuenta pendiente de activación", async () => {
    const { deps } = setup();

    await expect(
      learnerHistory(deps, { uid: "pendiente", role: "learner", status: "pending_activation" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("rechaza una cuenta deshabilitada", async () => {
    const { deps } = setup();

    await expect(
      learnerHistory(deps, { uid: LEARNER.uid, role: "learner", status: "disabled" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });
});

describe("accountHistory", () => {
  it("cada persona ve su propio histórico", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(stored({ courseId: "curso-a", version: 1 }), "2026-02-01T10:00:00.000Z");

    const result = await accountHistory(deps, { actor: LEARNER, uid: LEARNER.uid });

    expect(result.entries).toHaveLength(1);
  });

  it("un alumno no puede leer el histórico de otra persona", async () => {
    const { deps } = setup();

    await expect(accountHistory(deps, { actor: LEARNER, uid: "otra-persona" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("administración puede leer el de cualquiera", async () => {
    const { learning, deps } = setup();
    learning.seedArchived(stored({ courseId: "curso-a", version: 1 }), "2026-02-01T10:00:00.000Z");

    const result = await accountHistory(deps, { actor: ADMIN, uid: LEARNER.uid });

    expect(result.entries).toHaveLength(1);
  });

  it("rechaza un uid vacío en vez de leer el archivo entero", async () => {
    const { deps } = setup();

    await expect(accountHistory(deps, { actor: ADMIN, uid: "   " })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
  });
});

/** Comodidad: `CourseProgress` es el tipo que devuelve `initProgress`. */
export type ArchivedShape = CourseProgress;
