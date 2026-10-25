import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import {
  createPerson,
  type AccountProvisionInput,
  type AccountProvisioner,
  type AuditLog,
  type ImportDependencies,
  type PersonDirectory,
} from "@/server/import/service";
import { hashActivationToken, isValidActivationTokenFormat } from "@/server/auth/tokens";

/**
 * ALTA DE UNA PERSONA SUELTA
 * ==========================
 *
 * Es el mismo camino que la importación de Excel con otra entrada. Eso es
 * justamente lo que hay que vigilar: que no se convierta en una segunda forma
 * de crear cuentas con reglas más flojas.
 *
 * Lo que se fija aquí:
 *   · solo administradores;
 *   · la cuenta nace `pending_activation` y con rol `learner`: por aquí no se
 *     crea un administrador ni una cuenta activa;
 *   · el usuario lo calcula el servidor a partir del apellido y el rol;
 *   · el código se devuelve una vez y en el almacén queda solo su hash;
 *   · si el usuario ya existe no se crea nada; «es otra persona» lleva al
 *     sufijo que usa la importación;
 *   · un fallo a mitad deshace lo hecho y se audita sin el código.
 */

const ADMIN: Actor = { uid: "admin-1", role: "admin", status: "active" };
const NOW = new Date("2026-10-24T10:00:00.000Z");

interface Harness {
  deps: ImportDependencies;
  created: AccountProvisionInput[];
  rollbacks: string[];
  audits: Array<Record<string, unknown>>;
}

function harness(options: { taken?: string[]; fail?: boolean } = {}): Harness {
  const taken = new Set(options.taken ?? []);
  const created: AccountProvisionInput[] = [];
  const rollbacks: string[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const provisioner: AccountProvisioner = {
    async createAccount(input) {
      if (options.fail) throw new Error("fallo simulado de Firebase");
      created.push(input);
      return { uid: `uid-${created.length}` };
    },
    async rollbackAccount(uid) {
      rollbacks.push(uid);
    },
  };

  const directory: PersonDirectory = {
    async listTakenUsernames() {
      return taken;
    },
    async isUsernameTaken(username) {
      return taken.has(username);
    },
  };

  const audit: AuditLog = {
    async record(event) {
      audits.push(event as unknown as Record<string, unknown>);
    },
  };

  return {
    created,
    rollbacks,
    audits,
    deps: {
      directory,
      provisioner,
      audit,
      authEmailDomain: "formacion.invalid",
      activationTtlHours: 72,
      now: () => NOW,
    },
  };
}

describe("alta de una persona: camino correcto", () => {
  it("crea una cuenta pendiente, de alumnado, con usuario calculado por el servidor", async () => {
    const h = harness();
    const result = await createPerson(
      { actor: ADMIN, apellido: "García López", rol: "ROL 1" },
      h.deps,
    );

    // Dos apellidos se unen sin espacios: «García López» → rol1.garcialopez.
    expect(result.username).toBe("rol1.garcialopez");
    expect(result.personRol).toBe("ROL 1");
    expect(h.created).toHaveLength(1);

    const provision = h.created[0]!;
    expect(provision.role).toBe("learner");
    expect(provision.status).toBe("pending_activation");
    expect(provision.authEmail).toBe("rol1.garcialopez@formacion.invalid");
    expect(provision.claims).toMatchObject({ role: "learner", status: "pending_activation" });
    expect(provision.createdBy).toBe("admin-1");
    // La contraseña de fábrica no sirve para entrar: nadie la conoce.
    expect(provision.randomPassword.length).toBeGreaterThan(30);
  });

  it("devuelve un código de un solo uso y guarda solo su hash", async () => {
    const h = harness();
    const result = await createPerson(
      { actor: ADMIN, apellido: "Pérez", rol: "ROL 2" },
      h.deps,
    );

    expect(isValidActivationTokenFormat(result.activationToken)).toBe(true);
    expect(result.activationExpiresAt).toBe("2026-10-27T10:00:00.000Z");

    const provision = h.created[0]!;
    expect(provision.activationTokenHash).toBe(hashActivationToken(result.activationToken));
    expect(provision.activationTokenHash).not.toBe(result.activationToken);
    expect(JSON.stringify(h.created)).not.toContain(result.activationToken);
  });

  it("audita el alta sin el código ni datos de más", async () => {
    const h = harness();
    const result = await createPerson(
      { actor: ADMIN, apellido: "García", rol: "ROL 1" },
      h.deps,
    );

    expect(h.audits).toEqual([
      {
        type: "person_created",
        actorUid: "admin-1",
        at: NOW.toISOString(),
        uid: "uid-1",
        username: "rol1.garcia",
        personRol: "ROL 1",
      },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain(result.activationToken);
  });
});

describe("alta de una persona: duplicados", () => {
  it("si el usuario ya existe no crea nada y dice con qué choca", async () => {
    const h = harness({ taken: ["rol1.garcia"] });

    await expect(
      createPerson({ actor: ADMIN, apellido: "García", rol: "ROL 1" }, h.deps),
    ).rejects.toMatchObject({ code: "PERSON_ALREADY_EXISTS", status: 409 });

    expect(h.created).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("si el usuario base está libre pero el sufijo ocupado, no reutiliza el número", async () => {
    // `rol1.garcia` libre (otra persona con ese apellido no existe como base),
    // pero `rol1.garcia2` ya está cogido por otra alta anterior.
    const h = harness({ taken: ["rol1.garcia2"] });

    const result = await createPerson(
      { actor: ADMIN, apellido: "García", rol: "ROL 1" },
      h.deps,
    );

    expect(result.username).toBe("rol1.garcia");
    expect(h.created).toHaveLength(1);
  });
});

describe("alta de una persona: lo que se rechaza", () => {
  it("un alumno no puede crear cuentas", async () => {
    const h = harness();
    await expect(
      createPerson(
        { actor: { uid: "alumno-1", role: "learner", status: "active" }, apellido: "García", rol: "ROL 1" },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(h.created).toHaveLength(0);
  });

  it("un rol inventado no crea nada", async () => {
    const h = harness();
    await expect(
      createPerson({ actor: ADMIN, apellido: "García", rol: "ROL 9" }, h.deps),
    ).rejects.toMatchObject({ code: "PERSON_INVALID", status: 400 });

    expect(h.created).toHaveLength(0);
  });

  it("un apellido vacío no crea nada", async () => {
    const h = harness();
    await expect(
      createPerson({ actor: ADMIN, apellido: "   ", rol: "ROL 1" }, h.deps),
    ).rejects.toMatchObject({ code: "PERSON_INVALID", status: 400 });

    expect(h.created).toHaveLength(0);
  });

  it("si la creación falla, deshace y no audita", async () => {
    const h = harness({ fail: true });

    await expect(
      createPerson({ actor: ADMIN, apellido: "García", rol: "ROL 1" }, h.deps),
    ).rejects.toMatchObject({ code: "PROVISION_FAILED", status: 500 });

    expect(h.created).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});
