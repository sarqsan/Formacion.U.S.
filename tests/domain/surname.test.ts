import { describe, expect, it } from "vitest";
import { normalizeSurname } from "@/domain/people/surname";
import { DomainError } from "@/domain/text";

describe("normalizeSurname", () => {
  it("normaliza acentos, mayúsculas y espacios", () => {
    expect(normalizeSurname("  García  ")).toEqual({ display: "García", key: "garcia" });
    expect(normalizeSurname("SÁNCHEZ")).toEqual({ display: "SÁNCHEZ", key: "sanchez" });
    expect(normalizeSurname("de la Fuente")).toEqual({
      display: "de la Fuente",
      key: "delafuente",
    });
  });

  it("mantiene el apellido compuesto en la clave", () => {
    expect(normalizeSurname("Pérez-Molina").key).toBe("perezmolina");
    expect(normalizeSurname("O'Neil").key).toBe("oneil");
    expect(normalizeSurname("Muñoz").key).toBe("munoz");
  });

  it("admite apellidos con partículas y puntos", () => {
    expect(() => normalizeSurname("St. John")).not.toThrow();
    expect(normalizeSurname("St. John").key).toBe("stjohn");
  });

  it.each([
    ["", "SURNAME_REQUIRED"],
    ["   ", "SURNAME_REQUIRED"],
    ["A", "SURNAME_TOO_SHORT"],
    ["García2", "SURNAME_CONTAINS_DIGITS"],
    ["García; DROP TABLE", "SURNAME_INVALID_CHARS"],
    ["<script>", "SURNAME_INVALID_CHARS"],
    ["-García", "SURNAME_INVALID_CHARS"],
    ["García-", "SURNAME_INVALID_CHARS"],
  ])("rechaza %j con el código %s", (input, code) => {
    try {
      normalizeSurname(input);
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(code);
    }
  });

  it("rechaza números explícitamente", () => {
    expect(() => normalizeSurname(12345)).toThrow(DomainError);
    expect(() => normalizeSurname(null)).toThrow(DomainError);
  });

  it("rechaza apellidos demasiado largos", () => {
    expect(() => normalizeSurname("a".repeat(61))).toThrow(DomainError);
  });
});
