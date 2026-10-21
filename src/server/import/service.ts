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
export interface AuditLog {
  record(event: {
    type: "people_import";
    actorUid: string;
    at: string;
    createdUsernames: string[];
    skippedRows: number[];
  }): Promise<void>;
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
  const created: ImportConfirmResult["created"] = [];
  const createdUids: string[] = [];

  try {
    for (const row of readyRows) {
      // 2. Revalidar ocupación justo antes de crear (evita carreras entre
      //    vista previa y confirmación).
      if (await deps.directory.isUsernameTaken(row.username)) {
        throw new DomainError(
          "USERNAME_CONFLICT",
          `El usuario «${row.username}» se ha ocupado mientras revisabas la importación. Vuelve a cargar la vista previa.`,
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
    // 3. Rollback: no dejar cuentas a medio crear.
    await Promise.allSettled(
      createdUids.map((uid) => deps.provisioner.rollbackAccount(uid, "import_failed")),
    );

    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "IMPORT_FAILED",
      "No se ha podido completar la importación. No se ha creado ninguna cuenta.",
      500,
    );
  }

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
