import { describe, expect, it } from "vitest";
import { isAccountRole, normalizePersonRol, personRolSlug } from "@/domain/roles";

describe("normalizePersonRol", () => {
  it.each([
    ["ROL 1", "ROL 1"],
    ["rol 1", "ROL 1"],
    ["Rol1", "ROL 1"],
    ["  ROL   1  ", "ROL 1"],
    ["ROL-1", "ROL 1"],
    ["rol_1", "ROL 1"],
    ["ROL 2", "ROL 2"],
    ["rol2", "ROL 2"],
  ])("acepta %j como %s", (input, expected) => {
    expect(normalizePersonRol(input)).toBe(expected);
  });

  it.each(["ROL 3", "ROL 12", "ROL", "1", "", "  ", "administrador", null, undefined, 1, {}])(
    "rechaza %j",
    (input) => {
      expect(normalizePersonRol(input)).toBeNull();
    },
  );

  it("convierte el rol en un fragmento estable de usuario", () => {
    expect(personRolSlug("ROL 1")).toBe("rol1");
    expect(personRolSlug("ROL 2")).toBe("rol2");
  });
});

describe("isAccountRole", () => {
  it("solo admite admin y learner", () => {
    expect(isAccountRole("admin")).toBe(true);
    expect(isAccountRole("learner")).toBe(true);
    expect(isAccountRole("ROL 1")).toBe(false);
    expect(isAccountRole("superadmin")).toBe(false);
  });
});
