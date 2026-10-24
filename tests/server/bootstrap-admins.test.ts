import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BootstrapError,
  MAX_BOOTSTRAP_ADMINS,
  TOKEN_TTL_HOURS,
  assertEmailDomainsMatch,
  buildAccountDocument,
  checkEmailDomains,
  generateActivationToken,
  hashActivationToken,
  isConcurrencyConflict,
  parseAdminList,
  planAdminUsernames,
  provisionAdmin,
  rollbackProvisioned,
  runBootstrap,
  writeBootstrapAudit,
} from "../../scripts/lib/bootstrap-admin-core.mjs";

/**
 * ALTA DE ADMINISTRADORES: LOS CAMINOS QUE DUELEN
 * ===============================================
 *
 * Estas pruebas no comprueban el «camino feliz» y ya está: reproducen los
 * fallos parciales que en producción dejan basura invisible.
 *
 *   - el lote se aplica y el SDK informa de un error después;
 *   - el borrado de un recurso falla (rollback incompleto);
 *   - la auditoría falla DESPUÉS de haber creado cuentas y códigos;
 *   - dos ejecuciones pelean por el mismo nombre de usuario.
 *
 * El mundo es un doble en memoria con la forma de `firebase-admin`. No hay red
 * ni credenciales: nada de esto toca Firebase.
 */

// ---------------------------------------------------------------------------
// Doble en memoria
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

interface Hooks {
  commit?: Error | null;
  /** Si es `true`, el commit aplica los cambios y DESPUÉS falla. */
  commitAppliesFirst?: boolean;
  createUser?: Error | null;
  setClaims?: Error | null;
  deleteUser?: Error | null;
  audit?: Error | null;
  deleteError?: (path: string) => Error | null;
}

interface World {
  deps: { db: unknown; auth: unknown; emailDomain: string };
  docs: Map<string, DocData>;
  users: Map<string, { email: string; password: string; claims?: DocData }>;
  audits: DocData[];
  deletes: string[];
  preReserve: (username: string) => void;
}

function missingUserError(): Error {
  return Object.assign(new Error("There is no user record corresponding to the identifier."), {
    code: "auth/user-not-found",
  });
}

function createWorld(hooks: Hooks = {}): World {
  const docs = new Map<string, DocData>();
  const users = new Map<string, { email: string; password: string; claims?: DocData }>();
  const audits: DocData[] = [];
  const deletes: string[] = [];
  let uidSeq = 0;

  const path = (collection: string, id: string) => `${collection}/${id}`;

  function docRef(collection: string, id: string) {
    const docPath = path(collection, id);
    return {
      id,
      path: docPath,
      async get() {
        return { exists: docs.has(docPath), data: () => docs.get(docPath) };
      },
      async delete() {
        const failure = hooks.deleteError?.(docPath);
        if (failure) throw failure;
        docs.delete(docPath);
        deletes.push(docPath);
      },
    };
  }

  const db = {
    collection(name: string) {
      return {
        doc: (id: string) => docRef(name, id),
        async add(data: DocData) {
          if (hooks.audit) throw hooks.audit;
          audits.push({ ...data });
          return { id: `audit-${audits.length}` };
        },
      };
    },
    async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      const pending: Array<() => void> = [];
      const tx = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        create: (ref: { path: string }, data: DocData) => {
          pending.push(() => docs.set(ref.path, { ...data }));
        },
      };
      const result = await fn(tx);
      for (const apply of pending) apply();
      return result;
    },
    batch() {
      const pending: Array<() => void> = [];
      return {
        create: (ref: { path: string }, data: DocData) => {
          pending.push(() => docs.set(ref.path, { ...data }));
        },
        update: (ref: { path: string }, data: DocData) => {
          pending.push(() => docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data }));
        },
        async commit() {
          if (hooks.commit) {
            if (hooks.commitAppliesFirst) for (const apply of pending) apply();
            throw hooks.commit;
          }
          for (const apply of pending) apply();
        },
      };
    },
  };

  const auth = {
    async createUser(input: { email: string; password: string }) {
      if (hooks.createUser) throw hooks.createUser;
      uidSeq += 1;
      const uid = `uid-${String(uidSeq).padStart(4, "0")}`;
      users.set(uid, { email: input.email, password: input.password });
      return { uid };
    },
    async setCustomUserClaims(uid: string, claims: DocData) {
      if (hooks.setClaims) throw hooks.setClaims;
      const user = users.get(uid);
      if (!user) throw missingUserError();
      user.claims = claims;
    },
    async deleteUser(uid: string) {
      if (hooks.deleteUser) throw hooks.deleteUser;
      if (!users.has(uid)) throw missingUserError();
      users.delete(uid);
      deletes.push(`auth:${uid}`);
    },
    async getUser(uid: string) {
      const user = users.get(uid);
      if (!user) throw missingUserError();
      return user;
    },
  };

  return {
    deps: { db, auth, emailDomain: "formacion.invalid" },
    docs,
    users,
    audits,
    deletes,
    preReserve(username: string) {
      docs.set(path("usernames", username), { uid: null, reservedBy: "otra-ejecucion" });
    },
  };
}


type CleanupReport = {
  cleaned: string[];
  failed: Array<{ resource: string; error: string }>;
  residual: Array<{ resource: string; state: string; error?: string }>;
};

type FailedProvision = {
  status: "failed";
  username: string;
  stage: string;
  error: string;
  uid: string | null;
  tokenHash: string | null;
  cleanup: CleanupReport;
};

type SkippedProvision = { status: "skipped"; username: string; reason: string };

type CreatedProvision = {
  status: "created";
  username: string;
  uid: string;
  token: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
};

/** El módulo es JS: el tipo de retorno es una unión, y aquí se estrecha. */
function asCreated(result: unknown): CreatedProvision {
  return result as CreatedProvision;
}

function asFailed(result: unknown): FailedProvision {
  return result as FailedProvision;
}

function asSkipped(result: unknown): SkippedProvision {
  return result as SkippedProvision;
}

const NOW = new Date("2026-10-24T09:00:00.000Z");
const USERNAME = "rol1.garcia";

function docsAsText(world: World): string {
  return JSON.stringify([...world.docs.entries()]);
}

// ---------------------------------------------------------------------------
// Plan y dominios
// ---------------------------------------------------------------------------

describe("planAdminUsernames", () => {
  it("separa válidos, inválidos y reservados sin abortar el resto", () => {
    const plan = planAdminUsernames(["rol1.garcia", "ab", "admin", "Rol 1", "rol2.perez"]);
    expect(plan.create).toEqual(["rol1.garcia", "rol2.perez"]);
    expect(plan.invalid.map((item) => item.username)).toEqual(["ab", "admin", "Rol 1"]);
  });

  it("normaliza la lista de entrada y quita duplicados", () => {
    expect(parseAdminList(" Rol1.Garcia , ,ROL1.GARCIA, rol2.perez ")).toEqual([
      "rol1.garcia",
      "rol2.perez",
    ]);
  });

  it("mantiene el límite de administradores por ejecución", () => {
    expect(MAX_BOOTSTRAP_ADMINS).toBe(20);
  });
});

describe("dominio de correo interno", () => {
  it("acepta dos variables iguales", () => {
    const check = checkEmailDomains({
      AUTH_EMAIL_DOMAIN: "formacion.invalid",
      NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.invalid",
    });
    expect(check.ok).toBe(true);
    expect(check.server).toBe("formacion.invalid");
  });

  it("rechaza dominios distintos y explica el síntoma", () => {
    const check = checkEmailDomains({
      AUTH_EMAIL_DOMAIN: "formacion.invalid",
      NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.example",
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("formacion.invalid");
    expect(check.reason).toContain("formacion.example");
  });

  it("usa el valor por defecto del navegador cuando la variable pública no existe", () => {
    expect(checkEmailDomains({ AUTH_EMAIL_DOMAIN: "formacion.invalid" }).ok).toBe(true);
    // Si el servidor usa otro dominio y el cliente se queda con el de por
    // defecto, el alta debe negarse: el navegador construiría otro correo.
    expect(checkEmailDomains({ AUTH_EMAIL_DOMAIN: "interno.example" }).ok).toBe(false);
  });

  it("rechaza valores con forma inválida", () => {
    expect(checkEmailDomains({ AUTH_EMAIL_DOMAIN: "sinpunto" }).ok).toBe(false);
  });

  it("lanza BootstrapError con código cuando no coinciden", () => {
    expect(() =>
      assertEmailDomainsMatch({
        AUTH_EMAIL_DOMAIN: "formacion.invalid",
        NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "otro.invalid",
      }),
    ).toThrowError(BootstrapError);
    try {
      assertEmailDomainsMatch({ AUTH_EMAIL_DOMAIN: "a.invalid", NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "b.invalid" });
    } catch (error) {
      expect((error as BootstrapError).code).toBe("EMAIL_DOMAIN_MISMATCH");
    }
  });
});

// ---------------------------------------------------------------------------
// Camino feliz: lo que se guarda y lo que NO
// ---------------------------------------------------------------------------

describe("provisionAdmin: alta correcta", () => {
  it("crea reserva, usuario, claims, ficha y código con caducidad", async () => {
    const world = createWorld();
    const result = asCreated(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("created");
    expect(world.docs.has(`usernames/${USERNAME}`)).toBe(true);
    expect(world.docs.get(`usernames/${USERNAME}`)?.uid).toBe(result.uid);
    expect(world.docs.has(`accounts/${result.uid}`)).toBe(true);
    expect(world.docs.has(`activationTokens/${result.tokenHash}`)).toBe(true);

    const account = world.docs.get(`accounts/${result.uid}`) ?? {};
    expect(account.role).toBe("admin");
    expect(account.status).toBe("pending_activation");
    expect(account.claimsVersion).toBe(1);
    expect(account.apellido).toBeNull();
    expect(account.personRol).toBeNull();
    expect(account.activatedAt).toBeNull();

    const activation = world.docs.get(`activationTokens/${result.tokenHash}`) ?? {};
    expect(activation.usedAt).toBeNull();
    expect(activation.revokedAt).toBeNull();
    expect(activation.expiresAt).toBe(
      new Date(NOW.getTime() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString(),
    );

    expect(world.users.get(result.uid)?.claims).toEqual({
      role: "admin",
      status: "pending_activation",
      claimsVersion: 1,
    });
  });

  it("guarda el hash y nunca el token en claro", async () => {
    const world = createWorld();
    const result = asCreated(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.tokenHash).toBe(createHash("sha256").update(result.token, "utf8").digest("hex"));

    // Ni en los documentos, ni en las claves de documento, ni en las claims.
    expect(docsAsText(world)).not.toContain(result.token);
    expect(Object.keys(world.docs.get(`activationTokens/${result.tokenHash}`) ?? {})).not.toContain("token");
    expect(JSON.stringify([...world.users.entries()])).not.toContain(result.token);
  });

  it("usa una contraseña aleatoria distinta en cada alta y no la devuelve", async () => {
    const world = createWorld();
    const first = asCreated(await provisionAdmin({ username: "rol1.uno", deps: world.deps, now: NOW }));
    const second = asCreated(await provisionAdmin({ username: "rol1.dos", deps: world.deps, now: NOW }));

    const passwordOne = world.users.get(first.uid)?.password ?? "";
    const passwordTwo = world.users.get(second.uid)?.password ?? "";
    expect(passwordOne.length).toBeGreaterThan(40);
    expect(passwordOne).not.toBe(passwordTwo);
    expect(JSON.stringify(first)).not.toContain(passwordOne);
    expect(JSON.stringify(second)).not.toContain(passwordTwo);
  });

  it("el documento de la ficha conserva los campos que valida el servidor", () => {
    const doc = buildAccountDocument({
      uid: "uid-x",
      username: USERNAME,
      authEmail: `${USERNAME}@formacion.invalid`,
      createdAt: NOW.toISOString(),
    });
    for (const field of ["uid", "username", "role", "status", "claimsVersion", "createdAt", "createdBy"]) {
      expect(doc).toHaveProperty(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("rollback: no deja credenciales vivas", () => {
  it("si el commit falla, borra también activationTokens (el hueco que había antes)", async () => {
    const world = createWorld({ commit: new Error("commit rechazado") });
    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("failed");
    expect(result.stage).toBe("commit");
    expect(world.docs.size).toBe(0);
    expect(world.users.size).toBe(0);
    // El código se había generado antes del commit: el rollback debe borrarlo
    // aunque el lote no llegara a escribirse.
    expect(result.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cleanup.cleaned).toContain(`activationTokens/${result.tokenHash}`);
    expect(result.cleanup.cleaned).toContain(`accounts/${result.uid}`);
    expect(result.cleanup.cleaned).toContain(`auth:${result.uid}`);
    expect(result.cleanup.cleaned).toContain(`usernames/${USERNAME}`);
    expect(result.cleanup.residual).toEqual([]);
  });

  it("si el lote se aplicó y el SDK informó de error, el código huérfano no sobrevive", async () => {
    const world = createWorld({ commit: new Error("timeout ambiguo"), commitAppliesFirst: true });
    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("failed");
    expect(world.docs.size).toBe(0);
    expect(world.users.size).toBe(0);
    expect(world.docs.has(`usernames/${USERNAME}`)).toBe(false);
    expect(docsAsText(world)).not.toContain("activationTokens/");
    expect(result.cleanup.residual).toEqual([]);
  });

  it("si fallan las claims, retira el usuario y la reserva sin dejar ficha", async () => {
    const world = createWorld({ setClaims: new Error("permiso denegado") });
    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("failed");
    expect(result.stage).toBe("auth.setCustomUserClaims");
    expect(world.docs.has(`usernames/${USERNAME}`)).toBe(false);
    expect(world.users.size).toBe(0);
    expect(result.cleanup.cleaned).toEqual([
      `accounts/${result.uid}`,
      `auth:${result.uid}`,
      `usernames/${USERNAME}`,
    ]);
    expect(result.cleanup.residual).toEqual([]);
  });

  it("si Auth rechaza al crear el usuario, la reserva no se queda puesta", async () => {
    const world = createWorld({ createUser: new Error("cuota agotada") });
    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("failed");
    expect(result.stage).toBe("auth.createUser");
    expect(world.docs.size).toBe(0);
    expect(result.cleanup.cleaned).toEqual([`usernames/${USERNAME}`]);
  });

  it("informa de cada recurso que no pudo borrar y del estado residual real", async () => {
    const world = createWorld({
      commit: new Error("commit rechazado"),
      commitAppliesFirst: true,
      deleteError: (path) =>
        path.startsWith("activationTokens/") ? new Error("permission denied") : null,
    });

    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.status).toBe("failed");
    const resources = result.cleanup.failed.map((item) => item.resource);
    expect(resources).toEqual([expect.stringMatching(/^activationTokens\//)]);
    expect(result.cleanup.failed[0].error).toContain("permission denied");

    // Lo que de verdad importa: la relectura lo confirma.
    expect(result.cleanup.residual).toEqual([
      { resource: expect.stringMatching(/^activationTokens\//), state: "sigue existiendo" },
    ]);

    // El resto sí se limpió: la ficha, el usuario y la reserva no están.
    expect(world.users.size).toBe(0);
    expect(world.docs.has(`usernames/${USERNAME}`)).toBe(false);
  });

  it("no declara limpio lo que no pudo comprobar", async () => {
    const world = createWorld({
      setClaims: new Error("boom"),
      deleteUser: new Error("red caída"),
    });
    const result = asFailed(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));

    expect(result.cleanup.failed.map((item) => item.resource)).toEqual([
      expect.stringMatching(/^auth:/),
    ]);
    expect(result.cleanup.residual).toEqual([
      { resource: expect.stringMatching(/^auth:/), state: "sigue existiendo" },
    ]);
  });

  it("un fallo de reserva no intenta limpiar nada que no creó", async () => {
    const world = createWorld();

    const result = await rollbackProvisioned({
      deps: world.deps,
      username: USERNAME,
      uid: null,
      tokenHash: null,
      reservationCreated: false,
    });
    expect(result).toEqual({ cleaned: [], failed: [], residual: [] });
  });
});

// ---------------------------------------------------------------------------
// Concurrencia
// ---------------------------------------------------------------------------

describe("concurrencia y reservas de nombre", () => {
  it("una reserva tomada se informa como omitida, no como fallo", async () => {
    const world = createWorld();
    world.preReserve(USERNAME);

    const result = asSkipped(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("reservado");
    expect(world.users.size).toBe(0);
  });

  it("un nombre en conflicto no impide crear el siguiente", async () => {
    const world = createWorld();
    world.preReserve("rol1.ocupado");

    const report = await runBootstrap({
      usernames: ["rol1.ocupado", "rol2.libre"],
      deps: world.deps,
      now: NOW,
    });

    expect(report.skipped.map((item: { username: string }) => item.username)).toEqual(["rol1.ocupado"]);
    expect(report.created.map((item: { username: string }) => item.username)).toEqual(["rol2.libre"]);
    expect(report.failed).toEqual([]);
    expect(world.docs.has("accounts/uid-0001")).toBe(true);
  });

  it("si el correo ya existe en Auth, se retira la reserva y se omite", async () => {
    const world = createWorld({
      createUser: Object.assign(new Error("The email address is already in use."), {
        code: "auth/email-already-exists",
      }),
    });

    const result = asSkipped(await provisionAdmin({ username: USERNAME, deps: world.deps, now: NOW }));
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("correo");
    expect(world.docs.has(`usernames/${USERNAME}`)).toBe(false);
  });

  it("reconoce los códigos de conflicto de gRPC y de Auth", () => {
    expect(isConcurrencyConflict(Object.assign(new Error("x"), { code: 6 }))).toBe(true);
    expect(isConcurrencyConflict(Object.assign(new Error("x"), { code: 10 }))).toBe(true);
    expect(isConcurrencyConflict(Object.assign(new Error("x"), { code: "auth/email-already-exists" }))).toBe(true);
    expect(isConcurrencyConflict(new Error("permission denied"))).toBe(false);
    expect(isConcurrencyConflict(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

describe("auditoría", () => {
  it("registra nombres y estados, sin ningún código", async () => {
    const world = createWorld();
    const report = await runBootstrap({ usernames: [USERNAME], deps: world.deps, now: NOW });

    await writeBootstrapAudit({ deps: world.deps, report, at: NOW.toISOString() });

    expect(world.audits).toHaveLength(1);
    const audit = world.audits[0];
    expect(audit.type).toBe("bootstrap_admins");
    expect(audit.usernames).toEqual([USERNAME]);
    expect(audit.severity).toBe("warning");
    expect(JSON.stringify(audit)).not.toContain(report.created[0].token);
  });

  it("provisionar NO escribe la auditoría: los códigos existen antes de auditarla", async () => {
    const world = createWorld();
    const report = await runBootstrap({ usernames: [USERNAME], deps: world.deps, now: NOW });

    expect(world.audits).toEqual([]);
    expect(report.created[0].token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("si la auditoría falla, los códigos siguen en el informe y el error se propaga", async () => {
    const world = createWorld({ audit: new Error("falta firestore.databases.get") });
    const report = await runBootstrap({ usernames: [USERNAME], deps: world.deps, now: NOW });

    await expect(
      writeBootstrapAudit({ deps: world.deps, report, at: NOW.toISOString() }),
    ).rejects.toThrow("falta firestore.databases.get");

    // Lo que el operador ya tiene impreso no se pierde.
    expect(report.created).toHaveLength(1);
    expect(report.created[0].token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Y la cuenta está creada, con su código, aunque no haya auditoría.
    expect(world.docs.has(`activationTokens/${hashActivationToken(report.created[0].token)}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contrato del propio script
// ---------------------------------------------------------------------------

describe("contrato de scripts/bootstrap-admins.mjs", () => {
  const cli = readFileSync(new URL("../../scripts/bootstrap-admins.mjs", import.meta.url), "utf8");

  it("no escribe tokens en ficheros ni oculta errores de limpieza", () => {
    expect(cli).not.toMatch(/writeFile|appendFile|createWriteStream/);
    expect(cli).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    expect(cli).toContain("describeCleanup");
    expect(cli).toContain("estado residual");
  });

  it("imprime los códigos antes de escribir la auditoría", () => {
    const printAt = cli.indexOf("Códigos de activación");
    const auditAt = cli.indexOf("writeBootstrapAudit(");
    expect(printAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(-1);
    expect(printAt).toBeLessThan(auditAt);
  });

  it("comprueba el dominio de correo antes de permitir el alta", () => {
    const domainCheckAt = cli.indexOf("checkEmailDomains(process.env)");
    const bootstrapAt = cli.indexOf("await runBootstrap(");
    expect(domainCheckAt).toBeGreaterThan(-1);
    expect(domainCheckAt).toBeLessThan(bootstrapAt);
    expect(cli).toContain("Dominio de correo interno incoherente");
  });

  it("no trae dependencias de red fuera de firebase-admin", () => {
    const imports = [...cli.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "./lib/bootstrap-admin-core.mjs",
      "firebase-admin/app",
      "firebase-admin/auth",
      "firebase-admin/firestore",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Utilidades exportadas
// ---------------------------------------------------------------------------

describe("utilidades", () => {
  it("el token generado cumple el formato que exige la activación", () => {
    const token = generateActivationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashActivationToken(token)).toHaveLength(64);
  });
});
