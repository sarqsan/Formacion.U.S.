import { describe, expect, it } from "vitest";
import { assertSessionIssuable, resolveSession, type AccountSnapshot } from "@/domain/auth/actor";

/**
 * Estas pruebas verifican la POLÍTICA de sesión de la aplicación (qué token
 * vale contra qué ficha), no la verificación criptográfica del token de
 * Firebase ni las reglas de Firestore. Ver docs/PRUEBAS.md para el alcance
 * exacto de lo ejecutado.
 */

const account = (overrides: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  uid: "uid-1",
  role: "learner",
  status: "active",
  claimsVersion: 3,
  personRol: "ROL 1",
  ...overrides,
});

const claims = (overrides: Record<string, unknown> = {}) => ({
  role: "learner",
  status: "active",
  claimsVersion: 3,
  ...overrides,
});

describe("sesión válida", () => {
  it("acepta una cuenta activa con token coherente", () => {
    const result = resolveSession(claims(), account());
    expect(result).toEqual({
      ok: true,
      actor: { uid: "uid-1", role: "learner", status: "active", personRol: "ROL 1" },
    });
  });

  it("acepta administradores activos y conserva el rol", () => {
    const result = resolveSession(claims({ role: "admin" }), account({ role: "admin" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.actor.role).toBe("admin");
  });
});

describe("cuenta deshabilitada con token todavía válido", () => {
  it("rechaza la sesión: la base de datos manda sobre el token", () => {
    // Escenario del requisito: el token se emitió cuando la cuenta estaba
    // activa y sigue siendo criptográficamente válido, pero ya está
    // deshabilitada en la base de datos.
    const result = resolveSession(claims({ status: "active" }), account({ status: "disabled" }));
    expect(result).toEqual({ ok: false, reason: "account_not_active" });
  });

  it("rechaza también a un administrador deshabilitado", () => {
    const result = resolveSession(
      claims({ role: "admin", status: "active" }),
      account({ role: "admin", status: "disabled" }),
    );
    expect(result).toEqual({ ok: false, reason: "account_not_active" });
  });

  it("rechaza una cuenta pendiente de activación", () => {
    const result = resolveSession(
      claims({ status: "pending_activation" }),
      account({ status: "pending_activation" }),
    );
    expect(result).toEqual({ ok: false, reason: "account_not_active" });
  });
});

describe("claims obsoletas", () => {
  it("rechaza si la versión de claims no coincide", () => {
    expect(resolveSession(claims({ claimsVersion: 2 }), account({ claimsVersion: 3 }))).toEqual({
      ok: false,
      reason: "stale_claims_version",
    });
  });

  it("rechaza si el token no trae versión de claims", () => {
    const legacy = claims();
    delete (legacy as Record<string, unknown>).claimsVersion;
    expect(resolveSession(legacy, account())).toEqual({
      ok: false,
      reason: "stale_claims_version",
    });
  });

  it("rechaza si la ficha no tiene versión utilizable", () => {
    expect(resolveSession(claims(), account({ claimsVersion: undefined }))).toEqual({
      ok: false,
      reason: "stale_claims_version",
    });
    expect(resolveSession(claims(), account({ claimsVersion: "3" }))).toEqual({
      ok: false,
      reason: "stale_claims_version",
    });
  });

  it("rechaza a un administrador degradado que conserva el token antiguo", () => {
    const result = resolveSession(claims({ role: "admin" }), account({ role: "learner" }));
    expect(result).toEqual({ ok: false, reason: "role_mismatch" });
  });

  it("rechaza si el estado del token no coincide con el de la ficha", () => {
    const result = resolveSession(claims({ status: "disabled" }), account({ status: "active" }));
    expect(result).toEqual({ ok: false, reason: "status_mismatch" });
  });
});

describe("fichas inválidas o ausentes", () => {
  it("rechaza si no existe ficha (cuenta de Auth sin alta en la app)", () => {
    expect(resolveSession(claims(), null)).toEqual({ ok: false, reason: "no_account" });
    expect(resolveSession(claims(), undefined)).toEqual({ ok: false, reason: "no_account" });
    expect(resolveSession(claims(), account({ uid: "" }))).toEqual({
      ok: false,
      reason: "no_account",
    });
  });

  it("rechaza roles y estados desconocidos almacenados", () => {
    expect(resolveSession(claims(), account({ role: "superadmin" }))).toEqual({
      ok: false,
      reason: "invalid_stored_role",
    });
    expect(resolveSession(claims(), account({ status: "inventado" }))).toEqual({
      ok: false,
      reason: "invalid_stored_status",
    });
  });

  it("rechaza si faltan claims por completo", () => {
    expect(resolveSession(null, account())).toEqual({
      ok: false,
      reason: "stale_claims_version",
    });
  });
});

describe("no hay forma de elevar privilegios por los claims", () => {
  it("un claim de admin sobre ficha de alumno no concede admin", () => {
    const result = resolveSession(
      claims({ role: "admin", status: "active" }),
      account({ role: "learner" }),
    );
    expect(result.ok).toBe(false);
  });

  it("un claim de alumno sobre ficha de admin tampoco vale", () => {
    const result = resolveSession(claims({ role: "learner" }), account({ role: "admin" }));
    expect(result.ok).toBe(false);
  });

  it("el rol devuelto procede siempre de la ficha", () => {
    const result = resolveSession(claims({ role: "admin" }), account({ role: "admin" }));
    expect(result.ok && result.actor.role).toBe("admin");
  });
});

/**
 * CANJE DEL TOKEN POR LA COOKIE
 * =============================
 *
 * `assertSessionIssuable` es la misma política aplicada en el momento de
 * emitir la cookie (`POST /api/auth/session`). Estas pruebas fijan que una
 * cuenta pendiente o deshabilitada **no** recibe sesión, y que un token que
 * dice «admin» sobre una ficha de alumno no la recibe tampoco.
 */
describe("emisión de la cookie de sesión", () => {
  it("emite para una cuenta activa y coherente", () => {
    const actor = assertSessionIssuable(claims(), account());
    expect(actor).toEqual({ uid: "uid-1", role: "learner", status: "active", personRol: "ROL 1" });
  });

  it("rechaza una cuenta pendiente de activación", () => {
    expect(() =>
      assertSessionIssuable(claims({ status: "pending_activation" }), account({ status: "pending_activation" })),
    ).toThrowError(expect.objectContaining({ code: "ACCOUNT_NOT_ACTIVE", status: 403 }));
  });

  it("rechaza una cuenta deshabilitada", () => {
    expect(() => assertSessionIssuable(claims(), account({ status: "disabled" }))).toThrowError(
      expect.objectContaining({ code: "ACCOUNT_NOT_ACTIVE" }),
    );
  });

  it("rechaza un token sin ficha de cuenta", () => {
    expect(() => assertSessionIssuable(claims(), null)).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_ISSUABLE", status: 403 }),
    );
  });

  it("rechaza claims con otra versión (sesión invalidada)", () => {
    expect(() => assertSessionIssuable(claims({ claimsVersion: 2 }), account())).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_ISSUABLE", status: 401 }),
    );
  });

  it("no deja que un token con rol admin eleve a un alumno", () => {
    // El rol de la ficha es la verdad: el token no puede conceder permisos.
    expect(() => assertSessionIssuable(claims({ role: "admin" }), account())).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_ISSUABLE", status: 401 }),
    );
  });

  it("rechaza una ficha con rol almacenado desconocido", () => {
    expect(() => assertSessionIssuable(claims(), account({ role: "superadmin" }))).toThrowError(
      expect.objectContaining({ code: "SESSION_NOT_ISSUABLE", status: 403 }),
    );
  });
});
