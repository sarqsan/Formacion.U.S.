import { describe, expect, it } from "vitest";
import {
  activateAccount,
  type ActivationAccountSnapshot,
  type ActivationDependencies,
  type ActivationInput,
  type ActivationStore,
  type CredentialService,
} from "@/server/auth/activation-service";
import type { ActivationRecord } from "@/domain/auth/activation";
import { resolveSession } from "@/domain/auth/actor";
import { generateActivationToken, hashActivationToken } from "@/server/auth/tokens";
import { DomainError } from "@/domain/text";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const STRONG = "Cuartel-2026-Seguro";

interface Harness {
  deps: ActivationDependencies;
  token: string;
  passwords: Array<{ uid: string; password: string }>;
  claims: Array<{ uid: string; claims: Record<string, unknown> }>;
  consumed: string[];
  activations: Array<{ uid: string; claimsVersion: number }>;
  revoked: string[];
}

function harness(options: {
  account?: Partial<ActivationAccountSnapshot>;
  record?: Partial<ActivationRecord>;
  username?: string;
} = {}): Harness {
  const token = generateActivationToken();
  const tokenHash = hashActivationToken(token);

  const record: ActivationRecord = {
    uid: "uid-1",
    tokenHash,
    createdAt: "2026-05-31T12:00:00.000Z",
    expiresAt: "2026-06-04T12:00:00.000Z",
    usedAt: null,
    revokedAt: null,
    ...options.record,
  };

  // Por defecto, un alumno importado de Excel: rol de cuenta `learner` y rol de
  // persona `ROL 1`. Un administrador de arranque se simula con
  // `{ role: "admin", personRol: null }`.
  const account: ActivationAccountSnapshot = {
    uid: "uid-1",
    username: "rol1.garcia",
    status: "pending_activation",
    claimsVersion: 1,
    role: "learner",
    personRol: "ROL 1",
    ...options.account,
  };

  const passwords: Harness["passwords"] = [];
  const claims: Harness["claims"] = [];
  const consumed: string[] = [];
  const activations: Harness["activations"] = [];
  const revoked: string[] = [];

  const store: ActivationStore = {
    async findActivationByHash(hash) {
      return hash === tokenHash ? record : null;
    },
    async getAccount(uid) {
      return uid === account.uid ? account : null;
    },
    async consumeActivation({ tokenHash: hash }) {
      consumed.push(hash);
    },
    async markAccountActive({ uid, claimsVersion }) {
      activations.push({ uid, claimsVersion });
    },
  };

  const credentials: CredentialService = {
    async setPassword(uid, password) {
      passwords.push({ uid, password });
    },
    async setClaims(uid, nextClaims) {
      claims.push({ uid, claims: nextClaims });
    },
    async revokeRefreshTokens(uid) {
      revoked.push(uid);
    },
  };

  return {
    token,
    passwords,
    claims,
    consumed,
    activations,
    revoked,
    deps: { store, credentials, now: () => NOW },
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`debería haber lanzado ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("activación correcta", () => {
  it("fija la contraseña, activa la cuenta e invalida sesiones", async () => {
    const h = harness();
    const result = await activateAccount(
      { username: "rol1.garcia", token: h.token, newPassword: STRONG },
      h.deps,
    );

    expect(result).toEqual({ uid: "uid-1", username: "rol1.garcia" });
    expect(h.passwords).toEqual([{ uid: "uid-1", password: STRONG }]);
    expect(h.claims[0].claims).toEqual({
      role: "learner",
      status: "active",
      personRol: "ROL 1",
      claimsVersion: 2,
    });
    expect(h.consumed).toHaveLength(1);
    expect(h.activations).toEqual([{ uid: "uid-1", claimsVersion: 2 }]);
    expect(h.revoked).toEqual(["uid-1"]);
  });

  it("acepta el usuario con mayúsculas o espacios", async () => {
    const h = harness();
    await expect(
      activateAccount({ username: "  ROL1.Garcia ", token: h.token, newPassword: STRONG }, h.deps),
    ).resolves.toBeTruthy();
  });

  it("no devuelve la contraseña ni el token", async () => {
    const h = harness();
    const result = await activateAccount(
      { username: "rol1.garcia", token: h.token, newPassword: STRONG },
      h.deps,
    );
    expect(JSON.stringify(result)).not.toContain(STRONG);
    expect(JSON.stringify(result)).not.toContain(h.token);
  });
});

describe("rechazos de activación", () => {
  it("token inexistente → error genérico", async () => {
    const h = harness();
    const other = generateActivationToken();
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: other, newPassword: STRONG }, h.deps),
      "ACTIVATION_INVALID",
    );
    expect(h.passwords).toHaveLength(0);
  });

  it("token con formato inválido → mismo error genérico", async () => {
    const h = harness();
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: "no-es-un-token", newPassword: STRONG }, h.deps),
      "ACTIVATION_INVALID",
    );
  });

  it("token usado", async () => {
    const h = harness({ record: { usedAt: "2026-06-01T10:00:00.000Z" } });
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: h.token, newPassword: STRONG }, h.deps),
      "ACTIVATION_ALREADY_USED",
    );
    expect(h.passwords).toHaveLength(0);
  });

  it("token caducado", async () => {
    const h = harness({ record: { expiresAt: "2026-06-01T11:00:00.000Z" } });
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: h.token, newPassword: STRONG }, h.deps),
      "ACTIVATION_EXPIRED",
    );
    expect(h.passwords).toHaveLength(0);
  });

  it("token revocado", async () => {
    const h = harness({ record: { revokedAt: "2026-06-01T10:00:00.000Z" } });
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: h.token, newPassword: STRONG }, h.deps),
      "ACTIVATION_REVOKED",
    );
  });

  it("token de otra cuenta → error genérico sin filtrar información", async () => {
    const h = harness();
    await expectCode(
      activateAccount({ username: "rol1.perez", token: h.token, newPassword: STRONG }, h.deps),
      "ACTIVATION_INVALID",
    );
  });

  it("cuenta ya activada", async () => {
    const h = harness({ account: { status: "active" } });
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: h.token, newPassword: STRONG }, h.deps),
      "ACTIVATION_NOT_PENDING",
    );
  });

  it("contraseña débil: no se toca nada", async () => {
    const h = harness();
    await expectCode(
      activateAccount({ username: "rol1.garcia", token: h.token, newPassword: "corta" }, h.deps),
      "PASSWORD_WEAK",
    );
    expect(h.passwords).toHaveLength(0);
    expect(h.consumed).toHaveLength(0);
    expect(h.claims).toHaveLength(0);
  });

  it("contraseña que contiene el usuario", async () => {
    const h = harness();
    await expectCode(
      activateAccount(
        { username: "rol1.garcia", token: h.token, newPassword: "Rol1.Garcia2026" },
        h.deps,
      ),
      "PASSWORD_WEAK",
    );
  });

  it("usuario vacío", async () => {
    const h = harness();
    await expectCode(
      activateAccount({ username: "   ", token: h.token, newPassword: STRONG }, h.deps),
      "USERNAME_REQUIRED",
    );
  });
});

/**
 * El rol de las claims sale SIEMPRE de la ficha almacenada, nunca del cliente
 * ni de un valor fijo del código. Estos dos casos cubren las dos direcciones:
 * conservar la administración y no ascender a nadie.
 */
describe("rol tras la activación", () => {
  it("un administrador pendiente conserva admin y su sesión resuelve", async () => {
    const h = harness({ account: { role: "admin", personRol: null } });
    await activateAccount(
      { username: "rol1.garcia", token: h.token, newPassword: STRONG },
      h.deps,
    );

    const emitted = h.claims[0].claims;
    expect(emitted.role).toBe("admin");
    expect(emitted.status).toBe("active");
    expect(emitted.claimsVersion).toBe(2);
    // Sin rol de persona no se inventa uno en las claims.
    expect(emitted).not.toHaveProperty("personRol");

    // La ficha que deja `markAccountActive`: mismo `role`, `active` y la versión
    // que acaban de recibir las claims. La sesión tiene que poder emitirse.
    const resolution = resolveSession(emitted, {
      uid: "uid-1",
      role: "admin",
      status: "active",
      claimsVersion: 2,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.actor.role).toBe("admin");
      expect(resolution.actor.status).toBe("active");
    }
  });

  it("un admin conserva también su rol de persona si lo tiene", async () => {
    const h = harness({ account: { role: "admin", personRol: "ROL 1" } });
    await activateAccount(
      { username: "rol1.garcia", token: h.token, newPassword: STRONG },
      h.deps,
    );
    expect(h.claims[0].claims).toMatchObject({ role: "admin", personRol: "ROL 1" });
  });

  it("un token con rol distinto al de la ficha no vale (regresión original)", () => {
    // Es exactamente lo que ocurría antes de la corrección: la activación
    // emitía `learner` para una ficha `admin` y la sesión quedaba inservible
    // para siempre, sin operación de interfaz que la recuperase.
    expect(
      resolveSession(
        { role: "learner", status: "active", claimsVersion: 2 },
        { uid: "uid-1", role: "admin", status: "active", claimsVersion: 2 },
      ),
    ).toEqual({ ok: false, reason: "role_mismatch" });
  });

  it("un alumno sigue siendo alumno: activar no asciende a nadie", async () => {
    const h = harness(); // rol de cuenta `learner` en la ficha
    await activateAccount(
      { username: "rol1.garcia", token: h.token, newPassword: STRONG },
      h.deps,
    );

    expect(h.claims[0].claims.role).toBe("learner");
    const resolution = resolveSession(h.claims[0].claims, {
      uid: "uid-1",
      role: "learner",
      status: "active",
      claimsVersion: 2,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.actor.role).toBe("learner");
  });

  it("un rol enviado por el cliente se ignora", async () => {
    // La entrada no tiene campo de rol; aunque alguien lo inyecte en el cuerpo
    // de la petición, el servicio solo lee la ficha. El `as` es del test.
    const h = harness();
    await activateAccount(
      {
        username: "rol1.garcia",
        token: h.token,
        newPassword: STRONG,
        role: "admin",
      } as unknown as ActivationInput,
      h.deps,
    );
    expect(h.claims[0].claims.role).toBe("learner");
  });

  it("una ficha inexistente o con rol inválido no se activa", async () => {
    // `getAccount` del almacén real devuelve `null` si el rol no es válido;
    // aquí se comprueba que el servicio no activa una cuenta que no encuentra.
    const h = harness();
    await expectCode(
      activateAccount(
        { username: "rol1.otro", token: h.token, newPassword: STRONG },
        { ...h.deps, store: { ...h.deps.store, async getAccount() { return null; } } },
      ),
      "ACTIVATION_INVALID",
    );
    expect(h.claims).toHaveLength(0);
  });
});
