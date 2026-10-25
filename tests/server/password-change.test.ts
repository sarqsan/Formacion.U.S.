import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import { DomainError } from "@/domain/text";
import {
  changeOwnPassword,
  type PasswordChangeDependencies,
} from "@/server/accounts/password-service";

/**
 * CAMBIO DE CONTRASEÑA POR EL PROPIO USUARIO
 * ==========================================
 *
 * Lo que se fija aquí, y por qué:
 *
 *   · se exige la contraseña actual y se comprueba **contra Auth**, no contra
 *     un valor del cuerpo;
 *   · la contraseña nueva cumple la misma política que `/activar` y no puede
 *     repetir la actual;
 *   · el uid sale del actor, nunca del cuerpo: esta ruta no sirve para tocar la
 *     cuenta de otra persona;
 *   · las sesiones se cierran (refresh tokens revocados) al terminar;
 *   · la contraseña nueva no aparece en la auditoría ni en el resultado;
 *   · un rechazo no cambia nada.
 *
 * Lo que **no** demuestra: que Firebase Auth acepte la contraseña ni que la
 * revocación invalide sesiones reales (sin emulador ni proyecto).
 */

const NOW = new Date("2026-10-24T10:00:00.000Z");
const ACTOR: Actor = { uid: "uid-1", role: "learner", status: "active" };

interface World {
  deps: PasswordChangeDependencies;
  passwords: Array<{ uid: string; password: string }>;
  revoked: string[];
  audits: Array<Record<string, unknown>>;
  verified: Array<{ email: string; password: string }>;
}

function makeWorld(
  options: {
    status?: string;
    passwordMatches?: boolean;
    verifyThrows?: Error;
    username?: string;
  } = {},
): World {
  const passwords: World["passwords"] = [];
  const revoked: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const verified: World["verified"] = [];

  const deps: PasswordChangeDependencies = {
    store: {
      async getAccount() {
        return { username: options.username ?? "persona1", status: options.status ?? "active" };
      },
    },
    credentials: {
      async setPassword(uid, password) {
        passwords.push({ uid, password });
      },
      async setClaims() {},
      async revokeRefreshTokens(uid) {
        revoked.push(uid);
      },
    },
    async verifyPassword(email, password) {
      verified.push({ email, password });
      if (options.verifyThrows) throw options.verifyThrows;
      return options.passwordMatches ?? true;
    },
    audit: {
      async record(event) {
        audits.push(event as unknown as Record<string, unknown>);
      },
    },
    authEmailDomain: "formacion.invalid",
    now: () => NOW,
  };

  return { deps, passwords, revoked, audits, verified };
}

const GOOD = "NuevaClave2026";

async function expectDomainError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toBeInstanceOf(DomainError);
  await promise.catch((error: DomainError) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
}

describe("cambio de contraseña: camino correcto", () => {
  it("cambia la contraseña, revoca sesiones y audita sin guardar la contraseña", async () => {
    const world = makeWorld();
    const result = await changeOwnPassword(
      ACTOR,
      {
        currentPassword: "ClaveActual2025",
        newPassword: GOOD,
        newPasswordRepeat: GOOD,
      },
      world.deps,
    );

    expect(result).toEqual({ username: "persona1", changedAt: NOW.toISOString() });
    expect(world.passwords).toEqual([{ uid: "uid-1", password: GOOD }]);
    expect(world.revoked).toEqual(["uid-1"]);
    expect(world.audits).toEqual([
      { type: "password_changed", actorUid: "uid-1", at: NOW.toISOString() },
    ]);

    const serialised = JSON.stringify({ world: world.audits, result });
    expect(serialised).not.toContain(GOOD);
    expect(serialised).not.toContain("ClaveActual2025");
  });

  it("comprueba la contraseña actual con el correo sintético del usuario", async () => {
    const world = makeWorld({ username: "Persona1" });
    await changeOwnPassword(
      ACTOR,
      { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
      world.deps,
    );

    // El correo se normaliza a minúsculas: es el que usa el login.
    expect(world.verified).toEqual([
      { email: "persona1@formacion.invalid", password: "ClaveActual2025" },
    ]);
  });

  it("cambia la contraseña de un administrador igual que la de un alumno", async () => {
    const world = makeWorld();
    await changeOwnPassword(
      { uid: "admin-1", role: "admin", status: "active" },
      { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
      world.deps,
    );
    expect(world.passwords[0]?.uid).toBe("admin-1");
  });
});

describe("cambio de contraseña: lo que se rechaza", () => {
  it("sin sesión no toca nada", async () => {
    const world = makeWorld();
    await expectDomainError(
      changeOwnPassword(
        null,
        { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "UNAUTHENTICATED",
      401,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("una cuenta no activa no puede cambiar la contraseña", async () => {
    const world = makeWorld();
    await expectDomainError(
      changeOwnPassword(
        { ...ACTOR, status: "disabled" },
        { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "ACCOUNT_NOT_ACTIVE",
      403,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("un actor con el rol manipulado no basta: manda el estado de la ficha", async () => {
    const world = makeWorld({ status: "pending_activation" });
    await expectDomainError(
      changeOwnPassword(
        { ...ACTOR, role: "admin", status: "active" },
        { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "ACCOUNT_NOT_ACTIVE",
      403,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("si la contraseña actual no es correcta, no se cambia nada", async () => {
    const world = makeWorld({ passwordMatches: false });
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: "NoEsLaBuena1", newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "PASSWORD_INCORRECT",
      401,
    );
    expect(world.passwords).toHaveLength(0);
    expect(world.revoked).toHaveLength(0);
    expect(world.audits).toHaveLength(0);
  });

  it("las dos contraseñas nuevas deben coincidir", async () => {
    const world = makeWorld();
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: "OtraClave2026" },
        world.deps,
      ),
      "PASSWORD_MISMATCH",
      400,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("la contraseña nueva no puede ser la actual", async () => {
    const world = makeWorld();
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: GOOD, newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "PASSWORD_WEAK",
      400,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("la política es la misma que la de la activación", async () => {
    const world = makeWorld();
    for (const weak of ["corta", "sinmayusculas2026", "SINMINUSCULAS2026", "SinNumerosAqui"]) {
      await expectDomainError(
        changeOwnPassword(
          ACTOR,
          { currentPassword: "ClaveActual2025", newPassword: weak, newPasswordRepeat: weak },
          world.deps,
        ),
        "PASSWORD_WEAK",
        400,
      );
    }
    expect(world.passwords).toHaveLength(0);
  });

  it("la contraseña nueva no puede contener el nombre de usuario", async () => {
    const world = makeWorld({ username: "persona1" });
    const weak = "Persona1Clave2026";
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: "ClaveActual2025", newPassword: weak, newPasswordRepeat: weak },
        world.deps,
      ),
      "PASSWORD_WEAK",
      400,
    );
    expect(world.passwords).toHaveLength(0);
  });

  it("los campos vacíos o ausentes se rechazan con un mensaje claro", async () => {
    const world = makeWorld();
    await expectDomainError(
      changeOwnPassword(ACTOR, { newPassword: GOOD, newPasswordRepeat: GOOD }, world.deps),
      "PASSWORD_REQUIRED",
      400,
    );
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: "ClaveActual2025", newPassword: "", newPasswordRepeat: GOOD },
        world.deps,
      ),
      "PASSWORD_REQUIRED",
      400,
    );
  });

  it("si Auth no responde, no se cambia la contraseña", async () => {
    const world = makeWorld({
      verifyThrows: new DomainError("AUTH_UNAVAILABLE", "Sin conexión.", 503),
    });
    await expectDomainError(
      changeOwnPassword(
        ACTOR,
        { currentPassword: "ClaveActual2025", newPassword: GOOD, newPasswordRepeat: GOOD },
        world.deps,
      ),
      "AUTH_UNAVAILABLE",
      503,
    );
    expect(world.passwords).toHaveLength(0);
    expect(world.revoked).toHaveLength(0);
  });
});
