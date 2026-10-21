import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_STATUSES,
  assertEnrollmentSegment,
  assertValidEnrollment,
  enrollmentDocId,
  isEnrollmentActive,
} from "@/domain/courses/enrollment";
import { DomainError } from "@/domain/text";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    uid: "learner-uid-0001",
    courseId: "curso-a",
    status: "active",
    version: 1,
    enrolledAt: "2026-03-01T10:00:00.000Z",
    enrolledBy: "admin-uid-0001",
    updatedAt: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("identificador de matrícula", () => {
  it("es determinista: una matrícula por usuario y curso", () => {
    expect(enrollmentDocId("learner-uid-0001", "curso-a")).toBe("learner-uid-0001_curso-a");
    expect(enrollmentDocId("learner-uid-0001", "curso-a")).toBe(
      enrollmentDocId("learner-uid-0001", "curso-a"),
    );
  });

  it("no confunde dos pares distintos que comparten texto", () => {
    expect(enrollmentDocId("learner-uid-0001", "curso-a")).not.toBe(
      enrollmentDocId("learner-uid-0002", "curso-a"),
    );
    expect(enrollmentDocId("learner-uid-0001", "curso-a")).not.toBe(
      enrollmentDocId("learner-uid-0001", "curso-b"),
    );
  });

  it("rechaza identificadores que romperían la ruta del documento", () => {
    for (const courseId of ["", "curso/a", "../curso", "-empieza-mal", "con espacio"]) {
      expect(() => enrollmentDocId("learner-uid-0001", courseId)).toThrow(DomainError);
    }
    for (const uid of ["", "corto", "x".repeat(129)]) {
      expect(() => enrollmentDocId(uid, "curso-a")).toThrow(DomainError);
    }
  });

  it("el error de identificador no filtra el valor recibido", () => {
    try {
      assertEnrollmentSegment("../../etc/passwd", "courseId");
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).message).not.toContain("passwd");
      expect((error as DomainError).status).toBe(400);
    }
  });
});

describe("¿da acceso la matrícula?", () => {
  it("solo con estado «active»", () => {
    expect(isEnrollmentActive({ status: "active" })).toBe(true);
  });

  it("deniega por defecto: revocada, ausente o con estado inventado", () => {
    expect(isEnrollmentActive({ status: "revoked" })).toBe(false);
    expect(isEnrollmentActive(null)).toBe(false);
    expect(isEnrollmentActive(undefined)).toBe(false);
    expect(isEnrollmentActive({ status: "ACTIVE" as never })).toBe(false);
    expect(isEnrollmentActive({ status: "pending" as never })).toBe(false);
    expect(isEnrollmentActive({} as never)).toBe(false);
  });

  it("solo hay dos estados declarados", () => {
    expect(ENROLLMENT_STATUSES).toEqual(["active", "revoked"]);
  });
});

describe("documento de matrícula almacenado", () => {
  it("acepta un documento completo", () => {
    const parsed = assertValidEnrollment(valid());
    expect(parsed).toMatchObject({ uid: "learner-uid-0001", courseId: "curso-a", status: "active" });
  });

  it("acepta versión nula (curso aún sin publicar)", () => {
    expect(assertValidEnrollment(valid({ version: null })).version).toBeNull();
  });

  it("rechaza documentos incompletos o corruptos", () => {
    const broken: Array<Record<string, unknown>> = [
      valid({ uid: "" }),
      valid({ courseId: undefined }),
      valid({ status: "activo" }),
      valid({ version: 0 }),
      valid({ enrolledAt: "" }),
      valid({ enrolledBy: 42 }),
      {},
    ];

    for (const value of broken) {
      expect(() => assertValidEnrollment(value), JSON.stringify(value)).toThrow(DomainError);
    }
    expect(() => assertValidEnrollment(null)).toThrow(DomainError);
    expect(() => assertValidEnrollment("active")).toThrow(DomainError);
  });

  it("un documento corrupto es un error de servidor, no del cliente", () => {
    try {
      assertValidEnrollment({});
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect((error as DomainError).status).toBe(500);
      expect((error as DomainError).code).toBe("ENROLLMENT_INVALID");
    }
  });
});
