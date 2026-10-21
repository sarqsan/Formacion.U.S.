import { describe, expect, it, vi } from "vitest";
import {
  buildImportPreview,
  confirmImport,
  type AccountProvisionInput,
  type AccountProvisioner,
  type AuditLog,
  type ImportDependencies,
  type PersonDirectory,
} from "@/server/import/service";
import type { Actor } from "@/domain/auth/authorization";
import { DomainError } from "@/domain/text";
import { hashActivationToken, isValidActivationTokenFormat } from "@/server/auth/tokens";
import type { RawPersonRow } from "@/domain/people/import-rows";

const admin: Actor = { uid: "admin-1", role: "admin", status: "active" };
const learner: Actor = { uid: "user-1", role: "learner", status: "active" };

const rows: RawPersonRow[] = [
  { rowNumber: 2, rol: "ROL 1", apellido: "García" },
  { rowNumber: 3, rol: "ROL 2", apellido: "Pérez" },
];

interface Harness {
  deps: ImportDependencies;
  created: AccountProvisionInput[];
  rollbacks: string[];
  audits: unknown[];
  provisioner: AccountProvisioner;
}

function harness(options: { taken?: string[]; failOn?: number } = {}): Harness {
  const taken = new Set(options.taken ?? []);
  const created: AccountProvisionInput[] = [];
  const rollbacks: string[] = [];
  const audits: unknown[] = [];
  let counter = 0;

  const provisioner: AccountProvisioner = {
    async createAccount(input) {
      if (options.failOn !== undefined && created.length + 1 === options.failOn) {
        throw new Error("fallo simulado de Firebase");
      }
      created.push(input);
      counter += 1;
      return { uid: `uid-${counter}` };
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
      audits.push(event);
    },
  };

  return {
    created,
    rollbacks,
    audits,
    provisioner,
    deps: {
      directory,
      provisioner,
      audit,
      authEmailDomain: "formacion.invalid",
      activationTtlHours: 72,
      now: () => new Date("2026-05-01T09:00:00.000Z"),
    },
  };
}

describe("permisos", () => {
  it("rechaza a usuarios que no son administradores", async () => {
    const h = harness();
    await expect(
      buildImportPreview({ rows, actor: learner }, h.deps),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmImport({ rows, actor: learner }, h.deps)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.created).toHaveLength(0);
  });

  it("rechaza a administradores deshabilitados", async () => {
    const h = harness();
    await expect(
      confirmImport({ rows, actor: { ...admin, status: "disabled" } }, h.deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });
});

describe("vista previa", () => {
  it("no escribe nada", async () => {
    const h = harness();
    const { preview } = await buildImportPreview({ rows, actor: admin }, h.deps);
    expect(preview.summary.valid).toBe(2);
    expect(h.created).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("respeta los usuarios existentes", async () => {
    const h = harness({ taken: ["rol1.garcia"] });
    const { preview } = await buildImportPreview({ rows, actor: admin }, h.deps);
    expect(preview.summary.duplicatesPending).toBe(1);
    expect(preview.summary.confirmable).toBe(false);
  });
});

describe("confirmación", () => {
  it("crea cuentas learner pendientes de activación, nunca administradores", async () => {
    const h = harness();
    const result = await confirmImport({ rows, actor: admin }, h.deps);

    expect(result.created.map((c) => c.username)).toEqual(["rol1.garcia", "rol2.perez"]);
    expect(h.created).toHaveLength(2);
    for (const account of h.created) {
      expect(account.role).toBe("learner");
      expect(account.status).toBe("pending_activation");
      expect(account.claims).toMatchObject({
        role: "learner",
        status: "pending_activation",
        claimsVersion: 1,
      });
      expect(account.claims.role).not.toBe("admin");
    }
  });

  it("genera tokens de activación de un solo uso y guarda solo el hash", async () => {
    const h = harness();
    const result = await confirmImport({ rows, actor: admin }, h.deps);

    for (const [index, item] of result.created.entries()) {
      expect(isValidActivationTokenFormat(item.activationToken)).toBe(true);
      const account = h.created[index];
      expect(account.activationTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(account.activationTokenHash).not.toBe(item.activationToken);
      expect(account.activationTokenHash).toBe(hashActivationToken(item.activationToken));
      expect(JSON.stringify(h.audits)).not.toContain(item.activationToken);
    }
  });

  it("crea contraseñas aleatorias distintas y no las devuelve", async () => {
    const h = harness();
    const result = await confirmImport({ rows, actor: admin }, h.deps);
    const passwords = h.created.map((c) => c.randomPassword);
    expect(new Set(passwords).size).toBe(2);
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(32);
      expect(JSON.stringify(result)).not.toContain(password);
    }
  });

  it("usa correos sintéticos no enrutables", async () => {
    const h = harness();
    await confirmImport({ rows, actor: admin }, h.deps);
    expect(h.created[0].authEmail).toBe("rol1.garcia@formacion.invalid");
  });

  it("ignora los nombres de usuario enviados por el cliente", async () => {
    const h = harness();
    const tampered = [
      { rowNumber: 2, rol: "ROL 1", apellido: "García", username: "admin" },
    ] as unknown as RawPersonRow[];

    const result = await confirmImport({ rows: tampered, actor: admin }, h.deps);
    expect(result.created[0].username).toBe("rol1.garcia");
    expect(h.created[0].username).not.toBe("admin");
  });

  it("rechaza la confirmación si quedan duplicados sin resolver", async () => {
    const h = harness();
    const duplicateRows: RawPersonRow[] = [
      { rowNumber: 2, rol: "ROL 1", apellido: "García" },
      { rowNumber: 3, rol: "ROL 1", apellido: "García" },
    ];
    await expect(confirmImport({ rows: duplicateRows, actor: admin }, h.deps)).rejects.toMatchObject({
      code: "IMPORT_NOT_CONFIRMABLE",
    });
    expect(h.created).toHaveLength(0);
  });

  it("importa el duplicado cuando el administrador confirma que es otra persona", async () => {
    const h = harness();
    const duplicateRows: RawPersonRow[] = [
      { rowNumber: 2, rol: "ROL 1", apellido: "García" },
      { rowNumber: 3, rol: "ROL 1", apellido: "García" },
    ];
    const result = await confirmImport(
      { rows: duplicateRows, actor: admin, resolutions: { 3: "include" } },
      h.deps,
    );
    expect(result.created.map((c) => c.username)).toEqual(["rol1.garcia", "rol1.garcia2"]);
  });

  it("rechaza filas inválidas sin crear nada", async () => {
    const h = harness();
    await expect(
      confirmImport(
        { rows: [{ rowNumber: 2, rol: "ROL 9", apellido: "García" }], actor: admin },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_NOT_CONFIRMABLE" });
    expect(h.created).toHaveLength(0);
  });

  it("detecta conflictos de usuario aparecidos tras la vista previa", async () => {
    const h = harness();
    // El segundo usuario se ocupa entre la vista previa y la confirmación.
    h.deps.directory.isUsernameTaken = async (username) => username === "rol2.perez";

    await expect(confirmImport({ rows, actor: admin }, h.deps)).rejects.toMatchObject({
      code: "USERNAME_CONFLICT",
    });
    // La cuenta ya creada se deshace.
    expect(h.rollbacks).toEqual(["uid-1"]);
  });

  it("hace rollback si una creación falla a mitad", async () => {
    const h = harness({ failOn: 2 });
    await expect(confirmImport({ rows, actor: admin }, h.deps)).rejects.toMatchObject({
      code: "IMPORT_FAILED",
    });
    expect(h.rollbacks).toEqual(["uid-1"]);
    expect(h.audits).toHaveLength(0);
  });

  it("registra auditoría sin datos sensibles", async () => {
    const h = harness();
    await confirmImport({ rows, actor: admin }, h.deps);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      type: "people_import",
      actorUid: "admin-1",
      createdUsernames: ["rol1.garcia", "rol2.perez"],
    });
  });

  it("valida decisiones de duplicados recibidas del cliente", async () => {
    const h = harness();
    await expect(
      confirmImport({ rows, actor: admin, resolutions: { 99: "include" } }, h.deps),
    ).rejects.toMatchObject({ code: "RESOLUTIONS_UNKNOWN_ROW" });
  });

  it("no llama al provisioner dos veces con el mismo usuario", async () => {
    const h = harness();
    const spy = vi.spyOn(h.provisioner, "createAccount");
    await confirmImport({ rows, actor: admin }, h.deps);
    const usernames = spy.mock.calls.map((call) => call[0].username);
    expect(new Set(usernames).size).toBe(usernames.length);
  });
});

describe("errores de dominio", () => {
  it("no expone detalles internos al cliente", async () => {
    const h = harness({ failOn: 1 });
    try {
      await confirmImport({ rows, actor: admin }, h.deps);
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).message).not.toContain("simulado");
    }
  });
});
