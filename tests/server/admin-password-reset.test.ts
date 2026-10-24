import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import { validatePassword } from "@/domain/auth/activation";
import { resetPasswordByAdmin, type AccountAdminDependencies } from "@/server/accounts/service";
import { ACTIVATION_TOKEN_TTL_HOURS } from "@/domain/auth/activation";
import { generateTemporaryPassword, groupPasswordForReading } from "@/server/auth/tokens";
import { InMemoryAccountAdminStore, RecordingCredentials } from "../helpers/account-admin-double";

/**
 * RESTABLECER LA CONTRASEÑA DE OTRA PERSONA (PANEL)
 * =================================================
 *
 * Es el mismo efecto que `--reset-password` por terminal, pero sin credenciales
 * de servicio: lo que necesita quien administra sin ser técnico.
 *
 * Lo que se fija aquí:
 *   · solo administradores, y comprobado antes de tocar nada;
 *   · solo cuentas **activas**: una pendiente se activa con su código y una
 *     deshabilitada se reactiva antes (no hay atajo);
 *   · la contraseña la genera el servidor y **cumple la política** por
 *     construcción, sin depender de lo que teclee nadie;
 *   · se revocan las sesiones abiertas y se audita **sin la contraseña**;
 *   · un rechazo no escribe nada.
 *
 * Lo que **no** demuestra: que Firebase Auth aplique el cambio ni que la
 * revocación invalide sesiones reales (sin emulador ni proyecto).
 */

const NOW = new Date("2026-10-24T10:00:00.000Z");
const ADMIN: Actor = { uid: "admin-1", role: "admin", status: "active" };

function setup() {
  const store = new InMemoryAccountAdminStore();
  const credentials = new RecordingCredentials();
  const deps: AccountAdminDependencies = {
    store,
    credentials,
    activationTtlHours: ACTIVATION_TOKEN_TTL_HOURS,
    now: () => NOW,
  };
  store.seed({ uid: "admin-1", username: "admin.uno", role: "admin", status: "active" });
  return { store, credentials, deps };
}

describe("contraseña temporal generada por el servidor", () => {
  it("cumple la política de la activación", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "persona-1", username: "persona1", status: "active" });

    const result = await resetPasswordByAdmin({ actor: ADMIN, uid: "persona-1" }, deps);

    expect(validatePassword(result.password, { username: "persona1" })).toEqual([]);
    expect(result.password.length).toBeGreaterThanOrEqual(12);
  });

  it("no se repite en 200 generaciones y ninguna contiene el usuario", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const password = generateTemporaryPassword();
      expect(validatePassword(password, { username: "persona1" })).toEqual([]);
      expect(seen.has(password)).toBe(false);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });

  it("se agrupa para dictarla sin cambiar la contraseña real", () => {
    const password = "AbcdEfgh2345Ijkl";
    const grouped = groupPasswordForReading(password);
    expect(grouped).toBe("Abcd-Efgh-2345-Ijkl");
    expect(grouped.replaceAll("-", "")).toBe(password);
  });
});

describe("restablecer contraseña: lo que se hace", () => {
  it("cambia la contraseña, revoca sesiones y audita sin guardarla", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "persona-1", username: "persona1", status: "active" });

    const result = await resetPasswordByAdmin({ actor: ADMIN, uid: "persona-1" }, deps);

    expect(result.username).toBe("persona1");
    expect(result.changedAt).toBe(NOW.toISOString());
    expect(credentials.passwordChanges).toBe(1);
    expect(credentials.revoked).toEqual(["persona-1"]);
    expect(store.audits).toEqual([
      {
        type: "password_reset_admin",
        actorUid: "admin-1",
        targetUid: "persona-1",
        at: NOW.toISOString(),
        source: "generated",
      },
    ]);

    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain(result.password);
    // El estado de la cuenta no cambia: la contraseña no toca status ni claims.
    expect(store.statusWrites).toBe(0);
  });

  it("también sirve para la contraseña de otro administrador", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "admin-2", username: "admin.dos", role: "admin", status: "active" });

    await resetPasswordByAdmin({ actor: ADMIN, uid: "admin-2" }, deps);
    expect(credentials.passwordChanges).toBe(1);
    expect(credentials.revoked).toEqual(["admin-2"]);
  });
});

describe("restablecer contraseña: lo que se rechaza", () => {
  it("un alumno no puede restablecer la contraseña de nadie", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "persona-1", username: "persona1", status: "active" });

    await expect(
      resetPasswordByAdmin(
        { actor: { uid: "persona-1", role: "learner", status: "active" }, uid: "admin-1" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(credentials.passwordChanges).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("una cuenta pendiente de activación se rechaza: se activa con su código", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "pendiente-1", username: "pendiente1", status: "pending_activation" });

    await expect(
      resetPasswordByAdmin({ actor: ADMIN, uid: "pendiente-1" }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_PENDING_ACTIVATION", status: 409 });

    expect(credentials.passwordChanges).toBe(0);
  });

  it("una cuenta deshabilitada se rechaza: primero se reactiva", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "baja-1", username: "baja1", status: "disabled" });

    await expect(
      resetPasswordByAdmin({ actor: ADMIN, uid: "baja-1" }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE", status: 409 });

    expect(credentials.passwordChanges).toBe(0);
    expect(credentials.revoked).toHaveLength(0);
  });

  it("una cuenta que no existe da 404 sin inventarla", async () => {
    const { store, credentials, deps } = setup();

    await expect(
      resetPasswordByAdmin({ actor: ADMIN, uid: "fantasma" }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", status: 404 });

    expect(credentials.passwordChanges).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("un uid vacío no busca nada raro", async () => {
    const { deps } = setup();
    await expect(
      resetPasswordByAdmin({ actor: ADMIN, uid: "   " }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", status: 404 });
  });
});
