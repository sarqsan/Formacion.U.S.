import { describe, expect, it } from "vitest";
import {
  areAllMandatoryTopicsPassed,
  completionPercent,
  initProgress,
  isCourseCompleted,
  isFinalExamUnlocked,
  recordFinalExamAttempt,
  recordTopicAttempt,
  restartForVersion,
} from "@/domain/progress/course-progress";
import { DomainError } from "@/domain/text";

const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-02T10:00:00.000Z";

const fresh = () => initProgress("curso-a", 1, ["tema-1", "tema-2"]);

function approveTopics() {
  let progress = fresh();
  progress = recordTopicAttempt(progress, "tema-1", { passed: true, score: 100 }, T0);
  progress = recordTopicAttempt(progress, "tema-2", { passed: true, score: 100 }, T0);
  return progress;
}

describe("initProgress", () => {
  it("crea un tema por cada obligatorio y bloquea el examen", () => {
    const progress = fresh();
    expect(Object.keys(progress.topics)).toEqual(["tema-1", "tema-2"]);
    expect(progress.finalExam.passed).toBe(false);
    expect(progress.completedAt).toBeNull();
    expect(isFinalExamUnlocked(progress)).toBe(false);
    expect(completionPercent(progress)).toBe(0);
  });

  it("ignora temas duplicados en la lista", () => {
    const progress = initProgress("curso-a", 1, ["tema-1", "tema-1"]);
    expect(progress.mandatoryTopicIds).toEqual(["tema-1"]);
  });

  it("rechaza versiones inválidas", () => {
    expect(() => initProgress("curso-a", 0, ["tema-1"])).toThrow(DomainError);
  });
});

describe("recordTopicAttempt", () => {
  it("acumula intentos y conserva el aprobado", () => {
    let progress = fresh();
    progress = recordTopicAttempt(progress, "tema-1", { passed: false, score: 50 }, T0);
    expect(progress.topics["tema-1"]).toMatchObject({ passed: false, attempts: 1, bestScore: 50 });

    progress = recordTopicAttempt(progress, "tema-1", { passed: true, score: 100 }, T1);
    expect(progress.topics["tema-1"]).toMatchObject({
      passed: true,
      attempts: 2,
      bestScore: 100,
      passedAt: T1,
    });

    // Un intento posterior fallido no revoca el aprobado.
    progress = recordTopicAttempt(progress, "tema-1", { passed: false, score: 0 }, T1);
    expect(progress.topics["tema-1"].passed).toBe(true);
    expect(progress.topics["tema-1"].bestScore).toBe(100);
  });

  it("no muta el objeto de entrada", () => {
    const progress = fresh();
    const next = recordTopicAttempt(progress, "tema-1", { passed: true, score: 100 }, T0);
    expect(progress.topics["tema-1"].attempts).toBe(0);
    expect(next.topics["tema-1"].attempts).toBe(1);
  });

  it("rechaza temas que no son del curso", () => {
    expect(() =>
      recordTopicAttempt(fresh(), "tema-99", { passed: true, score: 100 }, T0),
    ).toThrowError(expect.objectContaining({ code: "TOPIC_NOT_IN_COURSE" }));
  });

  it("rechaza marcas de tiempo inválidas", () => {
    expect(() =>
      recordTopicAttempt(fresh(), "tema-1", { passed: true, score: 100 }, "no-es-fecha"),
    ).toThrow(DomainError);
  });
});

describe("desbloqueo del examen final", () => {
  it("sigue bloqueado hasta aprobar todos los temas", () => {
    let progress = fresh();
    progress = recordTopicAttempt(progress, "tema-1", { passed: true, score: 100 }, T0);
    expect(isFinalExamUnlocked(progress)).toBe(false);

    progress = recordTopicAttempt(progress, "tema-2", { passed: true, score: 100 }, T0);
    expect(isFinalExamUnlocked(progress)).toBe(true);
  });

  it("no permite aprobar el examen sin los temas, aunque el cliente lo intente", () => {
    expect(() => recordFinalExamAttempt(fresh(), { passed: true, score: 100 }, T0)).toThrowError(
      expect.objectContaining({ code: "FINAL_EXAM_LOCKED" }),
    );
  });

  it("permite repetir el examen hasta aprobar", () => {
    let progress = approveTopics();
    progress = recordFinalExamAttempt(progress, { passed: false, score: 60 }, T0);
    expect(progress.finalExam).toMatchObject({ passed: false, attempts: 1, bestScore: 60 });
    expect(progress.completedAt).toBeNull();

    progress = recordFinalExamAttempt(progress, { passed: true, score: 100 }, T1);
    expect(progress.finalExam).toMatchObject({ passed: true, attempts: 2, bestScore: 100 });
    expect(isCourseCompleted(progress)).toBe(true);
    expect(progress.completedAt).toBe(T1);
    expect(completionPercent(progress)).toBe(100);
  });

  it("el examen fallido no puede saltarse el bloqueo", () => {
    expect(() => recordFinalExamAttempt(fresh(), { passed: false, score: 0 }, T0)).toThrowError(
      expect.objectContaining({ code: "FINAL_EXAM_LOCKED" }),
    );
  });
});

describe("completionPercent", () => {
  it("cuenta temas y examen", () => {
    let progress = fresh();
    expect(completionPercent(progress)).toBe(0);
    progress = recordTopicAttempt(progress, "tema-1", { passed: true, score: 100 }, T0);
    expect(completionPercent(progress)).toBe(33); // 1 de 3 pasos
    progress = recordTopicAttempt(progress, "tema-2", { passed: true, score: 100 }, T0);
    expect(completionPercent(progress)).toBe(67);
  });
});

describe("restartForVersion", () => {
  it("reinicia el progreso al publicar una versión nueva", () => {
    const completed = recordFinalExamAttempt(approveTopics(), { passed: true, score: 100 }, T1);
    expect(isCourseCompleted(completed)).toBe(true);

    const restarted = restartForVersion(completed, 2, ["tema-1"]);
    expect(restarted.version).toBe(2);
    expect(restarted.completedAt).toBeNull();
    expect(restarted.finalExam.passed).toBe(false);
    expect(restarted.topics["tema-1"].attempts).toBe(0);
  });

  it("solo acepta versiones posteriores", () => {
    expect(() => restartForVersion(fresh(), 1, ["tema-1"])).toThrowError(
      expect.objectContaining({ code: "PROGRESS_VERSION_NOT_NEWER" }),
    );
  });
});

describe("invariantes", () => {
  it("un curso sin temas obligatorios no se considera completado sin examen", () => {
    const progress = initProgress("curso-a", 1, []);
    expect(areAllMandatoryTopicsPassed(progress)).toBe(true);
    expect(isCourseCompleted(progress)).toBe(false);
  });
});
