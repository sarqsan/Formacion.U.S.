import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import {
  analyzeImportRows,
  assertValidResolutions,
  type ImportPreview,
  type RawPersonRow,
} from "@/domain/people/import-rows";
import type { PersonRol } from "@/domain/roles";
import { buildClaims } from "@/domain/auth/activation";
import {
  ACTIVATION_TOKEN_BYTES,
  activationExpiry,
  generateActivationToken,
  generateUnusablePassword,
  hashActivationToken,
} from "@/server/auth/tokens";

/**
 * SERVICIO DE IMPORTACIÓN (servidor)
 * ==================================
 *
 * Reglas que se aplican aquí y no en el cliente:
 * - Solo un administrador activo puede importar.
 * - El servidor RECALCULA la vista previa: los nombres de usuario que envíe el
 *   cliente se ignoran por completo. Así no se puede inyectar `admin` ni
 *   reasignar usuarios existentes.
 * - De cada fila se toma únicamente `personRol` (dato descriptivo) y el
 *   apellido. El rol de cuenta es SIEMPRE `learner` y el estado SIEMPRE
 *   `pending_activation`. No existe ningún camino por el que una fila de Excel
 *   produzca un administrador.
 * - Las cuentas se crean con una contraseña aleatoria que no se entrega a
 *   nadie; el acceso real exige el token de activación de un solo uso.
 * - Si algo falla a mitad, se deshacen las cuentas ya creadas (rollback) para
 *   no dejar usuarios a medio provisionar.
 */

export interface AccountProvisionInput {
  username: string;
  authEmail: string;
  apellido: string;
  personRol: PersonRol;
  /** Siempre "learner". Se incluye explícitamente para que quede auditable. */
  role: "learner";
  status: "pending_activation";
  claims: Record<string, unknown>;
  activationTokenHash: string;
  activationExpiresAt: string;
  createdAt: string;
  createdBy: string;
  randomPassword: string;
}

export interface ProvisionedAccount {
  uid: string;
}

/** Puerto hacia Firebase Authentication + Firestore (implementación real aparte). */
export interface AccountProvisioner {
  createAccount(input: AccountProvisionInput): Promise<ProvisionedAccount>;
  /** Compensación: deshabilita/elimina una cuenta recién creada. */
  rollbackAccount(uid: string, reason: string): Promise<void>;
}

/** Puerto de lectura de usuarios existentes. */
export interface PersonDirectory {
  listTakenUsernames(): Promise<ReadonlySet<string>>;
  isUsernameTaken(username: string): Promise<boolean>;
}

/** Registro de auditoría (Firestore en producción). */
export type ImportAuditEvent =
  | {
      type: "people_import";
      actorUid: string;
      at: string;
      createdUsernames: string[];
      skippedRows: number[];
    }
  | {
      /** Alta individual desde el panel: una persona, no un fichero. */
      type: "person_created";
      actorUid: string;
      at: string;
      uid: string;
      username: string;
      personRol: PersonRol;
    };

export interface AuditLog {
  record(event: ImportAuditEvent): Promise<void>;
}

export interface ImportDependencies {
  directory: PersonDirectory;
  provisioner: AccountProvisioner;
  audit: AuditLog;
  authEmailDomain: string;
  activationTtlHours: number;
  now?: () => Date;
}

export interface ImportPreviewResult {
  preview: ImportPreview;
}

export interface ImportConfirmResult {
  preview: ImportPreview;
  created: Array<{
    username: string;
    uid: string;
    /** Se devuelve UNA sola vez al administrador. No se guarda en claro. */
    activationToken: string;
    activationExpiresAt: string;
  }>;
}

function authEmailFor(username: string, domain: string): string {
  const clean = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
    throw new DomainError(
      "AUTH_EMAIL_DOMAIN_INVALID",
      "El dominio de correo interno no está configurado correctamente.",
      503,
    );
  }
  return `${username}@${clean}`;
}

export async function buildImportPreview(
  input: { rows: readonly RawPersonRow[]; resolutions?: unknown; actor: Actor },
  deps: ImportDependencies,
): Promise<ImportPreviewResult> {
  assertAdmin(input.actor);

  const resolutions = assertValidResolutions(input.resolutions, input.rows);
  const takenUsernames = await deps.directory.listTakenUsernames();

  const preview = analyzeImportRows(input.rows, { takenUsernames, resolutions });

  return { preview };
}

type ReadyRow = Extract<ImportPreview["rows"][number], { status: "ok" }>;

/**
 * Crea las cuentas de las filas ya validadas y devuelve sus códigos en claro.
 *
 * Está aparte porque lo usan dos entradas distintas —la importación de un
 * fichero y el alta de una persona suelta— y la parte delicada (comprobar otra
 * vez el usuario, generar el código, deshacer si algo falla) debe ser **una
 * sola**: duplicarla sería duplicar la forma de dejarla a medias.
 */
async function provisionReadyRows(
  rows: readonly ReadyRow[],
  admin: Actor,
  deps: ImportDependencies,
  createdAt: string,
  /** Código y mensaje del fallo inesperado, según quién haya llamado. */
  failure: { code: string; message: string },
): Promise<ImportConfirmResult["created"]> {
  const now = new Date(createdAt);
  const created: ImportConfirmResult["created"] = [];
  const createdUids: string[] = [];

  try {
    for (const row of rows) {
      // Revalidar ocupación justo antes de crear (evita carreras entre la
      // vista previa y la confirmación).
      if (await deps.directory.isUsernameTaken(row.username)) {
        throw new DomainError(
          "USERNAME_CONFLICT",
          `El usuario «${row.username}» se ha ocupado mientras revisabas los datos. Vuelve a intentarlo.`,
          409,
        );
      }

      const activationToken = generateActivationToken();
      const activationExpiresAt = activationExpiry(now, deps.activationTtlHours).toISOString();

      const provisionInput: AccountProvisionInput = {
        username: row.username,
        authEmail: authEmailFor(row.username, deps.authEmailDomain),
        apellido: row.apellido,
        personRol: row.rol,
        role: "learner",
        status: "pending_activation",
        claims: buildClaims({
          role: "learner",
          status: "pending_activation",
          personRol: row.rol,
          claimsVersion: 1,
        }),
        activationTokenHash: hashActivationToken(activationToken),
        activationExpiresAt,
        createdAt,
        createdBy: admin.uid,
        randomPassword: generateUnusablePassword(),
      };

      const provisioned = await deps.provisioner.createAccount(provisionInput);
      createdUids.push(provisioned.uid);
      created.push({
        username: row.username,
        uid: provisioned.uid,
        activationToken,
        activationExpiresAt,
      });
    }
  } catch (error) {
    // Rollback: no dejar cuentas a medio crear.
    await Promise.allSettled(
      createdUids.map((uid) => deps.provisioner.rollbackAccount(uid, "import_failed")),
    );

    // Un error de negocio (usuario ocupado, por ejemplo) se propaga tal cual; lo
    // que no esperamos se convierte en un fallo explícito de la operación.
    if (error instanceof DomainError) throw error;
    throw new DomainError(failure.code, failure.message, 500);
  }

  return created;
}

export async function confirmImport(
  input: {
    rows: readonly RawPersonRow[];
    resolutions?: unknown;
    actor: Actor;
  },
  deps: ImportDependencies,
): Promise<ImportConfirmResult> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();

  // 1. Recalcular SIEMPRE en servidor con el estado actual de la base de datos.
  const resolutions = assertValidResolutions(input.resolutions, input.rows);
  const takenUsernames = await deps.directory.listTakenUsernames();
  const preview = analyzeImportRows(input.rows, { takenUsernames, resolutions });

  if (!preview.summary.confirmable) {
    throw new DomainError(
      "IMPORT_NOT_CONFIRMABLE",
      "La importación tiene filas con errores o duplicados sin resolver.",
      409,
      {
        invalid: preview.summary.invalid,
        duplicatesPending: preview.summary.duplicatesPending,
      },
    );
  }

  const readyRows = preview.rows.filter(
    (row): row is Extract<ImportPreview["rows"][number], { status: "ok" }> => row.status === "ok",
  );

  if (readyRows.length === 0) {
    throw new DomainError("IMPORT_NOTHING_TO_DO", "No hay ninguna fila que importar.", 409);
  }

  const createdAt = now.toISOString();
  const created = await provisionReadyRows(readyRows, admin, deps, createdAt, {
    code: "IMPORT_FAILED",
    message: "No se ha podido completar la importación. No se ha creado ninguna cuenta.",
  });

  await deps.audit.record({
    type: "people_import",
    actorUid: admin.uid,
    at: createdAt,
    createdUsernames: created.map((item) => item.username),
    skippedRows: preview.rows
      .filter((row) => row.status === "duplicate" && row.resolution === "skip")
      .map((row) => row.rowNumber),
  });

  return { preview, created };
}

export const IMPORT_LIMITS = {
  maxRows: 2000,
  activationTokenBytes: ACTIVATION_TOKEN_BYTES,
} as const;

/**
 * Alta de UNA persona desde el panel.
 *
 * La importación de Excel resolvía el caso de «40 personas de golpe», pero dar
 * de alta a una sola obligaba a fabricar un fichero de una fila. Esto es el
 * mismo camino —misma validación, mismo usuario, mismo código de un solo uso—
 * con una entrada distinta: no una segunda forma de crear cuentas.
 *
 * Reglas que se mantienen intactas:
 *   · solo un administrador activo;
 *   · el rol de cuenta es SIEMPRE `learner` y el estado SIEMPRE
 *     `pending_activation`: una fila escrita a mano no puede producir un
 *     administrador;
 *   · el usuario lo calcula el servidor (nunca se acepta del cliente);
 *   · si el usuario ya existe, **no se crea nada** y se dice con qué usuario
 *     choca. El dominio considera que el par rol + apellido identifica a una
 *     persona: no se inventa un `rol1.garcia2` para una cuenta que ya existe
 *     (eso convertiría un duplicado en una cuenta nueva de la misma persona).
 */
export interface CreatePersonInput {
  actor: Actor;
  apellido: unknown;
  rol: unknown;
}

export interface CreatedPerson {
  uid: string;
  username: string;
  personRol: PersonRol;
  activationToken: string;
  activationExpiresAt: string;
}

export async function createPerson(
  input: CreatePersonInput,
  deps: ImportDependencies,
): Promise<CreatedPerson> {
  const admin = assertAdmin(input.actor);
  const now = deps.now?.() ?? new Date();
  const createdAt = now.toISOString();

  const rows: RawPersonRow[] = [{ rowNumber: 1, apellido: input.apellido, rol: input.rol }];
  const takenUsernames = await deps.directory.listTakenUsernames();

  const preview = analyzeImportRows(rows, { takenUsernames });
  const row = preview.rows[0];

  if (row.status === "error") {
    throw new DomainError(
      "PERSON_INVALID",
      row.issues[0]?.message ?? "Los datos de la persona no son válidos.",
      400,
      { issues: row.issues.map((issue) => issue.code) },
    );
  }

  if (row.status === "duplicate") {
    // El dominio identifica a la persona por rol + apellido: si el usuario base
    // ya existe, es esa persona. No se crea una segunda cuenta con sufijo.
    throw new DomainError(
      "PERSON_ALREADY_EXISTS",
      "Ya hay una cuenta con ese apellido y ese rol. Búscala en «Personas»: si es la misma persona, no hay que darla de alta otra vez.",
      409,
      { reason: row.reason },
    );
  }

  const created = await provisionReadyRows([row], admin, deps, createdAt, {
    code: "PROVISION_FAILED",
    message: "No se ha podido crear la cuenta. No se ha dejado ninguna a medias.",
  });
  const account = created[0];
  if (!account) {
    throw new DomainError(
      "PROVISION_FAILED",
      "No se ha podido crear la cuenta. No se ha dejado ninguna a medias.",
      500,
    );
  }

  await deps.audit.record({
    type: "person_created",
    actorUid: admin.uid,
    at: createdAt,
    uid: account.uid,
    username: account.username,
    personRol: row.rol,
  });

  return {
    uid: account.uid,
    username: account.username,
    personRol: row.rol,
    activationToken: account.activationToken,
    activationExpiresAt: account.activationExpiresAt,
  };
}
