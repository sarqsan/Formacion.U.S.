import { describe, expect, it } from "vitest";
import {
  assertBootstrapAllowed,
  MAX_BOOTSTRAP_ADMINS,
  parseBootstrapAdminList,
  planBootstrapAdmins,
} from "@/server/admin/bootstrap-plan";
import { DomainError } from "@/domain/text";

describe("parseBootstrapAdminList", () => {
  it("separa, normaliza y limpia", () => {
    expect(parseBootstrapAdminList(" Rol1.Garcia , ,rol1.perez ")).toEqual([
      "rol1.garcia",
      "rol1.perez",
    ]);
    expect(parseBootstrapAdminList(undefined)).toEqual([]);
    expect(parseBootstrapAdminList("")).toEqual([]);
  });
});

describe("planBootstrapAdmins", () => {
  it("crea los administradores nuevos y omite los existentes", () => {
    const plan = planBootstrapAdmins(new Set(["rol1.existe"]), [
      "rol1.existe",
      "rol1.nuevo",
      "rol2.nuevo",
    ]);
    expect(plan.create).toEqual(["rol1.nuevo", "rol2.nuevo"]);
    expect(plan.skipExisting).toEqual(["rol1.existe"]);
    expect(plan.invalid).toEqual([]);
  });

  it("elimina duplicados de la lista", () => {
    const plan = planBootstrapAdmins(new Set(), ["rol1.garcia", "ROL1.GARCIA"]);
    expect(plan.create).toEqual(["rol1.garcia"]);
  });

  it("rechaza nombres inválidos sin abortar el resto", () => {
    const plan = planBootstrapAdmins(new Set(), ["ab", "rol1.garcia", "admin", "Rol 1"]);
    expect(plan.create).toEqual(["rol1.garcia"]);
    expect(plan.invalid.map((item) => item.username)).toEqual(["ab", "admin", "rol 1"]);
    expect(plan.invalid.map((item) => item.reason)).toContain("nombre reservado");
  });

  it("exige al menos un administrador", () => {
    expect(() => planBootstrapAdmins(new Set(), [])).toThrow(DomainError);
  });

  it("limita el número de administradores por ejecución", () => {
    const many = Array.from({ length: MAX_BOOTSTRAP_ADMINS + 1 }, (_, i) => `rol1.admin${i}`);
    expect(() => planBootstrapAdmins(new Set(), many)).toThrowError(
      expect.objectContaining({ code: "BOOTSTRAP_TOO_MANY" }),
    );
  });
});

describe("assertBootstrapAllowed", () => {
  it("permite simulación sin confirmación", () => {
    expect(() =>
      assertBootstrapAllowed({ dryRun: true, confirmed: false, hasCredentials: true, usingEmulator: false }),
    ).not.toThrow();
  });

  it("exige confirmación explícita para aplicar cambios", () => {
    expect(() =>
      assertBootstrapAllowed({ dryRun: false, confirmed: false, hasCredentials: true, usingEmulator: false }),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_NOT_CONFIRMED" }));
  });

  it("exige credenciales", () => {
    expect(() =>
      assertBootstrapAllowed({ dryRun: false, confirmed: true, hasCredentials: false, usingEmulator: false }),
    ).toThrowError(expect.objectContaining({ code: "BOOTSTRAP_NO_CREDENTIALS" }));
  });

  it("acepta emulador sin credenciales reales", () => {
    expect(() =>
      assertBootstrapAllowed({ dryRun: false, confirmed: true, hasCredentials: false, usingEmulator: true }),
    ).not.toThrow();
  });
});
