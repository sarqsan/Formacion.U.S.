import { describe, expect, it } from "vitest";
import {
  RESERVED_USERNAMES,
  allocateUsername,
  assertValidUsername,
  buildBaseUsername,
  usernameToAuthEmail,
} from "@/domain/people/username";
import { DomainError } from "@/domain/text";

describe("buildBaseUsername", () => {
  it("es determinista y depende solo de rol + apellido", () => {
    expect(buildBaseUsername("ROL 1", "garcia")).toBe("rol1.garcia");
    expect(buildBaseUsername("ROL 2", "garcia")).toBe("rol2.garcia");
    expect(buildBaseUsername("ROL 1", "garcia")).toBe(buildBaseUsername("ROL 1", "garcia"));
  });

  it("distingue el mismo apellido en roles distintos", () => {
    expect(buildBaseUsername("ROL 1", "perez")).not.toBe(buildBaseUsername("ROL 2", "perez"));
  });
});

describe("allocateUsername", () => {
  it("devuelve el usuario base si está libre", () => {
    expect(allocateUsername("rol1.garcia", () => false)).toBe("rol1.garcia");
  });

  it("evita colisiones con sufijo creciente", () => {
    const taken = new Set(["rol1.garcia", "rol1.garcia2"]);
    expect(allocateUsername("rol1.garcia", (u) => taken.has(u))).toBe("rol1.garcia3");
  });

  it("nunca devuelve un usuario ocupado", () => {
    const taken = new Set(["rol1.garcia", "rol1.garcia2", "rol1.garcia3"]);
    const result = allocateUsername("rol1.garcia", (u) => taken.has(u));
    expect(taken.has(result)).toBe(false);
  });

  it("no asigna nombres reservados", () => {
    for (const reserved of RESERVED_USERNAMES) {
      const result = allocateUsername(reserved.length >= 4 ? reserved : "rol1.x", () => false);
      expect(RESERVED_USERNAMES.has(result)).toBe(false);
    }
  });

  it("falla de forma controlada si no hay hueco", () => {
    expect(() => allocateUsername("rol1.garcia", () => true, 5)).toThrowError(
      /nombre de usuario libre/i,
    );
  });

  it("rechaza bases inválidas", () => {
    expect(() => allocateUsername("Rol 1 García", () => false)).toThrow(DomainError);
  });
});

describe("assertValidUsername", () => {
  it.each(["rol1.garcia", "rol2.sanchez-delafuente", "rol1.o-neil"])("acepta %s", (u) => {
    expect(() => assertValidUsername(u)).not.toThrow();
  });

  it.each(["", "ab", "Rol1.Garcia", "rol1 garcia", "-rol1", "rol1-", "rol1.<script>"])(
    "rechaza %j",
    (u) => {
      expect(() => assertValidUsername(u)).toThrow(DomainError);
    },
  );
});

describe("usernameToAuthEmail", () => {
  it("genera un correo interno con dominio .invalid", () => {
    expect(usernameToAuthEmail("rol1.garcia", "formacion.invalid")).toBe(
      "rol1.garcia@formacion.invalid",
    );
  });

  it("normaliza el dominio", () => {
    expect(usernameToAuthEmail("rol1.garcia", "  Formacion.Invalid ")).toBe(
      "rol1.garcia@formacion.invalid",
    );
  });

  it.each(["localhost", "", "dominio", "con espacios.com"])(
    "rechaza dominio inválido %j",
    (domain) => {
      expect(() => usernameToAuthEmail("rol1.garcia", domain)).toThrow(DomainError);
    },
  );
});
