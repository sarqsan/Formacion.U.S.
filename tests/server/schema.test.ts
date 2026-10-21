import { describe, expect, it } from "vitest";
import {
  answerKeysDocId,
  progressDocId,
  progressHistoryDocId,
  validateAccountDocument,
  validateAttemptDocument,
  validateProgressDocument,
  versionPath,
} from "@/server/db/schema";
import {
  COLLECTIONS,
  ROOT_COLLECTIONS,
  SCHEMA_VERSION,
  CLIENT_READABLE_COLLECTIONS,
  SERVER_ONLY_COLLECTIONS,
} from "@/server/db/schema.constants";
import { DomainError } from "@/domain/text";

const UID = "AbCdEf123456";

describe("identificadores", () => {
  it("construye el id de progreso", () => {
    expect(progressDocId(UID, "curso-a")).toBe(`${UID}_curso-a`);
  });

  it("construye el id del histórico con la versión", () => {
    expect(progressHistoryDocId(UID, "curso-a", 2)).toBe(`${UID}_curso-a_v2`);
  });

  it("construye el id de claves por evaluación", () => {
    expect(answerKeysDocId("curso-a", 1, "final")).toBe("curso-a_v1_final");
    expect(answerKeysDocId("curso-a", 3, "tema-1")).toBe("curso-a_v3_tema-1");
  });

  it("construye la ruta de una versión", () => {
    expect(versionPath("curso-a", 2)).toBe("courses/curso-a/versions/2");
  });

  it.each(["", "con espacio", "../escape", "a/b", "-empieza-mal", "x".repeat(65)])(
    "rechaza identificadores no válidos: %j",
    (value) => {
      expect(() => progressDocId(UID, value)).toThrow(DomainError);
      expect(() => versionPath(value, 1)).toThrow(DomainError);
    },
  );

  it("rechaza uids inválidos y versiones no enteras", () => {
    expect(() => progressDocId("", "curso-a")).toThrow(DomainError);
    expect(() => progressDocId("corto", "curso-a")).toThrow(DomainError);
    expect(() => progressHistoryDocId(UID, "curso-a", 0)).toThrow(DomainError);
    expect(() => versionPath("curso-a", 1.5)).toThrow(DomainError);
  });
});

describe("validación de documentos", () => {
  const account = {
    uid: UID,
    username: "rol1.garcia",
    authEmail: "rol1.garcia@formacion.invalid",
    apellido: "García",
    personRol: "ROL 1",
    role: "learner",
    status: "pending_activation",
    claimsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "admin-uid",
  };

  it("acepta una cuenta correcta", () => {
    expect(() => validateAccountDocument(account)).not.toThrow();
  });

  it("rechaza roles y estados inventados", () => {
    expect(() => validateAccountDocument({ ...account, role: "superadmin" })).toThrowError(
      expect.objectContaining({ code: "SCHEMA_ACCOUNT_INVALID" }),
    );
    expect(() => validateAccountDocument({ ...account, status: "activo" })).toThrow(DomainError);
  });

  it("rechaza claimsVersion no entero (rompería las reglas)", () => {
    expect(() => validateAccountDocument({ ...account, claimsVersion: "1" })).toThrow(DomainError);
    expect(() => validateAccountDocument({ ...account, claimsVersion: 1.5 })).toThrow(DomainError);
  });

  it("rechaza campos obligatorios ausentes", () => {
    for (const field of ["uid", "username", "role", "status", "createdAt"]) {
      const broken: Record<string, unknown> = { ...account };
      delete broken[field];
      expect(() => validateAccountDocument(broken), field).toThrow(DomainError);
    }
  });

  const progress = {
    uid: UID,
    courseId: "curso-a",
    version: 1,
    mandatoryTopicIds: ["tema-1"],
    completedAt: null,
  };

  it("valida el progreso", () => {
    expect(() => validateProgressDocument(progress)).not.toThrow();
    expect(() =>
      validateProgressDocument({ ...progress, mandatoryTopicIds: "tema-1" }),
    ).toThrow(DomainError);
    expect(() => validateProgressDocument({ ...progress, version: 0 })).toThrow(DomainError);
    expect(() => validateProgressDocument({ ...progress, completedAt: 123 })).toThrow(DomainError);
  });

  const attempt = {
    uid: UID,
    courseId: "curso-a",
    version: 1,
    assessmentType: "final",
    topicId: null,
    passed: true,
    correctCount: 5,
    totalQuestions: 5,
    at: "2026-01-01T00:00:00.000Z",
  };

  it("valida intentos", () => {
    expect(() => validateAttemptDocument(attempt)).not.toThrow();
    expect(() =>
      validateAttemptDocument({ ...attempt, assessmentType: "topic", topicId: null }),
    ).toThrow(DomainError);
    expect(() =>
      validateAttemptDocument({ ...attempt, correctCount: 6, totalQuestions: 5 }),
    ).toThrow(DomainError);
    expect(() => validateAttemptDocument({ ...attempt, passed: "sí" })).toThrow(DomainError);
  });
});

describe("catálogo de colecciones", () => {
  it("no hay solapamiento entre legibles y solo-servidor", () => {
    const readable = new Set<string>(CLIENT_READABLE_COLLECTIONS);
    for (const collection of SERVER_ONLY_COLLECTIONS) {
      expect(readable.has(collection), `${collection} no puede ser a la vez legible y privada`).toBe(
        false,
      );
    }
  });

  it("todas las colecciones de nivel raíz están clasificadas o son subcolección", () => {
    const classified = new Set<string>([
      ...CLIENT_READABLE_COLLECTIONS,
      ...SERVER_ONLY_COLLECTIONS,
      COLLECTIONS.versions,
    ]);
    for (const collection of ROOT_COLLECTIONS) {
      expect(classified.has(collection), `${collection} sin clasificar`).toBe(true);
    }
  });

  it("la versión de esquema es un entero positivo", () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});
