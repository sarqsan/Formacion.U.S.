import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import {
  activationSummary,
  disableAccount,
  enableAccount,
  reissueActivationCode,
  type AccountAdminDependencies,
} from "@/server/accounts/service";
import { hashActivationToken, isValidActivationTokenFormat } from "@/server/auth/tokens";
import { ACTIVATION_TOKEN_TTL_HOURS } from "@/domain/auth/activation";
import { InMemoryAccountAdminStore, RecordingCredentials } from "../helpers/account-admin-double";
import {
  adminDisableAccount,
  adminEnableAccount,
  adminReissueActivationCode,
} from "@/demo/service";
import { demoCredentialsForTests } from "@/demo/account-admin";
import { demoState, resetDemoState } from "@/demo/store";

/**
 * ADMINISTRACIÓN DE CUENTAS (bloque 09)
 * =====================================
 *
 * Hasta este bloque, las reglas de transición y la protección del último
 * administrador existían en el dominio pero **nadie las llamaba**: no había
 * forma de deshabilitar una cuenta ni de reemitir un código caducado.
 *
 * Lo que se fija aquí:
 *   · solo administración, y comprobado antes de leer;
 *   · transiciones válidas y errores tipados, sin inventarse estados;
 *   · deshabilitar cierra la puerta por los tres lados (estado, claims y
 *     refresh tokens) y anula los códigos pendientes;
 *   · no se puede dejar el sistema sin administración;
 *   · reemitir invalida el código anterior y el token solo se guarda hasheado;
 *   · un rechazo no escribe nada.
 *
 * Lo que **no** demuestra: que Firebase Auth revoque de verdad ni que las
 * claims se propaguen a los tokens ya emitidos (sin emulador ni proyecto).
 */

const NOW = new Date("2026-02-01T10:00:00.000Z");
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

async function failureOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; status?: number; message?: string };
  }
  throw new Error("Se esperaba un error y la operación terminó bien.");
}

describe("quién puede administrar cuentas", () => {
  it("un alumno no puede deshabilitar a nadie", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "alumno-1" });

    await expect(
      disableAccount({ actor: { uid: "alumno-1", role: "learner", status: "active" }, uid: "admin-1" }, deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(store.statusWrites).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("una cuenta no activa no administra aunque tenga rol", async () => {
    const { deps } = setup();

    await expect(
      disableAccount({ actor: { uid: "admin-1", role: "admin", status: "disabled" }, uid: "admin-1" }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE", status: 403 });
  });

  it("sin sesión no hay operación", async () => {
    const { deps } = setup();
    await expect(
      disableAccount({ actor: null as unknown as Actor, uid: "admin-1" }, deps),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  it("una cuenta inexistente da 404 sin escribir", async () => {
    const { store, deps } = setup();

    const error = await failureOf(() => disableAccount({ actor: ADMIN, uid: "fantasma" }, deps));

    expect(error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(error.status).toBe(404);
    expect(store.statusWrites).toBe(0);
  });
});

describe("deshabilitar", () => {
  it("cierra la puerta por los tres lados y deja rastro", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "alumno-1", username: "rol1.garcia", claimsVersion: 4 });
    store.seedActivation({ uid: "alumno-1", tokenHash: "hash-viejo" });

    const result = await disableAccount({ actor: ADMIN, uid: "alumno-1", reason: "Baja temporal" }, deps);

    // 1. Estado
    expect(result.status).toBe("disabled");
    expect((await store.getAccount("alumno-1"))?.status).toBe("disabled");
    // 2. Claims nuevas: la versión sube y un token viejo deja de valer
    expect(result.claimsVersion).toBe(5);
    expect(credentials.claims.get("alumno-1")).toMatchObject({
      role: "learner",
      status: "disabled",
      claimsVersion: 5,
    });
    // 3. Refresh tokens revocados
    expect(credentials.revoked).toContain("alumno-1");
    // 4. Un código pendiente no puede reactivar la cuenta por la puerta de atrás
    expect(store.activations[0].revokedAt).toBe(NOW.toISOString());
    expect(store.activations[0].revokedReason).toBe("account_disabled");
    // 5. Auditoría con el motivo, sin secretos
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      type: "account_disabled",
      actorUid: "admin-1",
      targetUid: "alumno-1",
      reason: "Baja temporal",
      claimsVersion: 5,
    });
  });

  it("también deshabilita una cuenta pendiente de activación", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "pendiente-1", status: "pending_activation" });

    await expect(disableAccount({ actor: ADMIN, uid: "pendiente-1" }, deps)).resolves.toMatchObject({
      status: "disabled",
    });
  });

  it("no repite la operación sobre una cuenta ya deshabilitada", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "alumno-1", status: "disabled" });

    const error = await failureOf(() => disableAccount({ actor: ADMIN, uid: "alumno-1" }, deps));

    expect(error.code).toBe("STATUS_UNCHANGED");
    expect(store.statusWrites).toBe(0);
  });

  it("no deja el sistema sin administración", async () => {
    const { store, credentials, deps } = setup();
    // admin-1 es el único administrador activo de la base.

    const error = await failureOf(() => disableAccount({ actor: ADMIN, uid: "admin-1" }, deps));

    expect(error.code).toBe("LAST_ADMIN");
    expect(error.status).toBe(409);
    expect(store.statusWrites).toBe(0);
    expect(credentials.revoked).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("sí permite deshabilitar a otro administrador si queda alguno activo", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "admin-2", role: "admin", status: "active" });

    await expect(disableAccount({ actor: ADMIN, uid: "admin-2" }, deps)).resolves.toMatchObject({
      status: "disabled",
    });
    expect(await store.countActiveAdmins()).toBe(1);
  });
});

describe("reactivar", () => {
  it("vuelve a dejar la cuenta activa con claims nuevas", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "alumno-1", status: "disabled", claimsVersion: 7 });

    const result = await enableAccount({ actor: ADMIN, uid: "alumno-1" }, deps);

    expect(result.status).toBe("active");
    expect(result.claimsVersion).toBe(8);
    expect(credentials.claims.get("alumno-1")).toMatchObject({ status: "active", claimsVersion: 8 });
    expect(credentials.revoked).toContain("alumno-1");
    expect(store.audits[0]).toMatchObject({ type: "account_enabled", claimsVersion: 8 });
  });

  it("no activa una cuenta pendiente: su camino es el código y la contraseña", async () => {
    const { store, credentials, deps } = setup();
    store.seed({ uid: "pendiente-1", status: "pending_activation" });

    const error = await failureOf(() => enableAccount({ actor: ADMIN, uid: "pendiente-1" }, deps));

    expect(error.code).toBe("ACCOUNT_PENDING_ACTIVATION");
    expect(error.status).toBe(409);
    expect(store.statusWrites).toBe(0);
    expect(credentials.claims.size).toBe(0);
  });

  it("no «reactiva» una cuenta que ya está activa", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "alumno-1", status: "active" });

    await expect(enableAccount({ actor: ADMIN, uid: "alumno-1" }, deps)).rejects.toMatchObject({
      code: "STATUS_UNCHANGED",
    });
  });
});

describe("reemitir el código de activación", () => {
  it("emite un token nuevo, anula el anterior y guarda solo el hash", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "pendiente-1", username: "rol2.perez", status: "pending_activation" });
    store.seedActivation({ uid: "pendiente-1", tokenHash: "hash-antiguo" });

    const reissued = await reissueActivationCode({ actor: ADMIN, uid: "pendiente-1" }, deps);

    expect(isValidActivationTokenFormat(reissued.token)).toBe(true);
    expect(reissued.username).toBe("rol2.perez");
    expect(reissued.revokedPrevious).toBe(1);
    expect(reissued.expiresAt).toBe(
      new Date(NOW.getTime() + ACTIVATION_TOKEN_TTL_HOURS * 3_600_000).toISOString(),
    );

    // El código viejo queda revocado y el nuevo se guarda por hash.
    const previous = store.activations.find((token) => token.tokenHash === "hash-antiguo");
    expect(previous?.revokedAt).toBe(NOW.toISOString());
    const stored = store.activations.find(
      (token) => token.tokenHash === hashActivationToken(reissued.token),
    );
    expect(stored).toBeTruthy();
    expect(stored?.usedAt).toBeNull();

    // En ningún sitio queda el token en claro.
    expect(JSON.stringify(store.activations)).not.toContain(reissued.token);
    expect(JSON.stringify(store.audits)).not.toContain(reissued.token);
  });

  it("cada reemisión invalida la anterior: nunca hay dos códigos vivos", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "pendiente-1", status: "pending_activation" });

    const first = await reissueActivationCode({ actor: ADMIN, uid: "pendiente-1" }, deps);
    const second = await reissueActivationCode({ actor: ADMIN, uid: "pendiente-1" }, deps);

    expect(second.token).not.toBe(first.token);
    expect(second.revokedPrevious).toBe(1);
    const alive = store.activations.filter((token) => !token.usedAt && !token.revokedAt);
    expect(alive).toHaveLength(1);
    expect(alive[0].tokenHash).toBe(hashActivationToken(second.token));
  });

  it("no emite códigos para una cuenta activa ni para una deshabilitada", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "activa-1", status: "active" });
    store.seed({ uid: "baja-1", status: "disabled" });

    await expect(
      reissueActivationCode({ actor: ADMIN, uid: "activa-1" }, deps),
    ).rejects.toMatchObject({ code: "ACTIVATION_NOT_APPLICABLE" });
    await expect(
      reissueActivationCode({ actor: ADMIN, uid: "baja-1" }, deps),
    ).rejects.toMatchObject({ code: "ACTIVATION_NOT_APPLICABLE" });

    expect(store.activations).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it("la auditoría registra la emisión, nunca el código", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "pendiente-1", status: "pending_activation" });

    const reissued = await reissueActivationCode({ actor: ADMIN, uid: "pendiente-1" }, deps);

    expect(store.audits[0]).toMatchObject({
      type: "activation_reissued",
      actorUid: "admin-1",
      targetUid: "pendiente-1",
      expiresAt: reissued.expiresAt,
      revokedPrevious: 0,
    });
    expect(store.audits[0]).not.toHaveProperty("token");
  });
});

describe("la demostración ejecuta el mismo servicio", () => {
  beforeEach(() => {
    resetDemoState();
  });

  const DEMO_ADMIN: Actor = { uid: "demo-admin", role: "admin", status: "active" };

  it("deshabilita a un alumno y su cuenta deja de valer", async () => {
    await adminDisableAccount(DEMO_ADMIN, "demo-alumno-1", "Prueba del recorrido");

    const account = demoState().accounts.find((item) => item.uid === "demo-alumno-1");
    expect(account?.status).toBe("disabled");
    expect(account?.claimsVersion).toBe(2);
    expect(demoCredentialsForTests().revoked).toContain("demo-alumno-1");
    expect(demoState().audits.at(-1)).toMatchObject({
      type: "account_disabled",
      targetUid: "demo-alumno-1",
    });
  });

  it("reactiva y deja la cuenta utilizable otra vez", async () => {
    await adminDisableAccount(DEMO_ADMIN, "demo-alumno-1");
    await adminEnableAccount(DEMO_ADMIN, "demo-alumno-1");

    expect(demoState().accounts.find((item) => item.uid === "demo-alumno-1")?.status).toBe("active");
  });

  it("reemite el código de la cuenta pendiente de la demostración", async () => {
    const reissued = await adminReissueActivationCode(DEMO_ADMIN, "demo-pendiente");

    expect(isValidActivationTokenFormat(reissued.token)).toBe(true);
    expect(demoState().activationTokens.has(hashActivationToken(reissued.token))).toBe(true);
    expect(JSON.stringify([...demoState().activationTokens.keys()])).not.toContain(reissued.token);
  });

  it("no deja sin administración a la demostración", async () => {
    await expect(adminDisableAccount(DEMO_ADMIN, "demo-admin")).rejects.toMatchObject({
      code: "LAST_ADMIN",
    });
  });
});

describe("adaptador de Firestore: la consulta ya tiene índice", () => {
  /**
   * Comprobación sobre el código y sobre `firestore.indexes.json`, no una
   * ejecución: no hay emulador ni proyecto. Lo que fija es que el recuento de
   * administradores activos usa la consulta que **ya** estaba indexada y que el
   * bloque no añade índices que habría que publicar sin permiso.
   */
  it("cuenta administradores activos con role+status y sin índices nuevos", () => {
    const source = readFileSync("src/server/firebase/account-admin-store.ts", "utf8");
    expect(source).toContain('.where("role", "==", "admin")');
    expect(source).toContain('.where("status", "==", "active")');
    expect(source).toContain(".count()");

    const indexes = JSON.parse(readFileSync("firestore.indexes.json", "utf8")) as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
    };
    const accountIndex = indexes.indexes.find(
      (index) =>
        index.collectionGroup === "accounts" &&
        index.fields.map((field) => field.fieldPath).join(",") === "role,status",
    );
    expect(accountIndex).toBeTruthy();
  });

  it("no escribe el token en claro ni toca contraseñas", () => {
    const source = readFileSync("src/server/firebase/account-admin-store.ts", "utf8");
    expect(source).toContain("tokenHash");
    expect(source).not.toContain("setPassword");
    // El estado y la versión de claims van en la misma escritura.
    const statusIndex = source.indexOf("status: input.status");
    const claimsIndex = source.indexOf("claimsVersion: input.claimsVersion");
    expect(statusIndex).toBeGreaterThan(-1);
    expect(claimsIndex).toBeGreaterThan(statusIndex);
  });
});

describe("resumen de códigos para la ficha", () => {
  it("distingue pendientes, usados y revocados sin devolver hashes", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "pendiente-1", status: "pending_activation" });
    store.seedActivation({ uid: "pendiente-1", tokenHash: "vivo" });
    store.seedActivation({ uid: "pendiente-1", tokenHash: "usado", usedAt: "2026-01-02T10:00:00.000Z" });
    store.seedActivation({ uid: "pendiente-1", tokenHash: "anulado", revokedAt: "2026-01-03T10:00:00.000Z" });

    const summary = await activationSummary({ actor: ADMIN, uid: "pendiente-1" }, deps);

    expect(summary).toMatchObject({ pending: 1, used: 1, revoked: 1 });
    expect(summary.expiresAt).toBe("2026-01-04T09:00:00.000Z");
    expect(JSON.stringify(summary)).not.toContain("vivo");
  });

  it("una cuenta inexistente da 404 también en el resumen", async () => {
    const { deps } = setup();
    await expect(activationSummary({ actor: ADMIN, uid: "fantasma" }, deps)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      status: 404,
    });
  });

  it("un alumno no puede leer el resumen de otra cuenta", async () => {
    const { store, deps } = setup();
    store.seed({ uid: "alumno-1" });

    await expect(
      activationSummary(
        { actor: { uid: "alumno-1", role: "learner", status: "active" }, uid: "admin-1" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
