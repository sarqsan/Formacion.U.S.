import { DomainError } from "@/domain/text";
import { normalizePersonRol, type PersonRol } from "@/domain/roles";
import { normalizeSurname } from "@/domain/people/surname";
import { allocateUsername, assertValidUsername, buildBaseUsername } from "@/domain/people/username";

export const MAX_IMPORT_ROWS = 2000;

/** Una fila tal cual sale del Excel (índice de fila 1-based, como en Excel). */
export interface RawPersonRow {
  rowNumber: number;
  rol: unknown;
  apellido: unknown;
}

export interface ImportIssue {
  code: string;
  message: string;
}

/** Decisión del administrador sobre un posible duplicado. */
export type DuplicateResolution = "skip" | "include";

export type DuplicateReason = "same_file" | "already_exists";

export type PreviewRow =
  | {
      status: "ok";
      rowNumber: number;
      rol: PersonRol;
      apellido: string;
      username: string;
      /** Presente si la fila venía de un duplicado resuelto como "persona distinta". */
      duplicateOfRow?: number;
    }
  | {
      status: "error";
      rowNumber: number;
      rolRaw: string;
      apellidoRaw: string;
      issues: ImportIssue[];
    }
  | {
      status: "duplicate";
      rowNumber: number;
      rol: PersonRol;
      apellido: string;
      /** Fila del mismo fichero con la que choca (null si ya existía en la BD). */
      duplicateOfRow: number | null;
      reason: DuplicateReason;
      /** Qué se hará con ella. `null` = pendiente de decisión del administrador. */
      resolution: DuplicateResolution | null;
      /** Si ya se decidió "omitir", indica por qué no se puede incluir. */
      includable: boolean;
    };

export interface ImportPreview {
  rows: PreviewRow[];
  summary: {
    totalRows: number;
    /** Filas listas para crear cuenta. */
    valid: number;
    invalid: number;
    /** Duplicados detectados (resueltos o no). */
    duplicates: number;
    /** Duplicados que siguen esperando decisión del administrador. */
    duplicatesPending: number;
    duplicatesSkipped: number;
    duplicatesIncluded: number;
    /** Se puede confirmar la importación. */
    confirmable: boolean;
    /** Nombres de usuario que se crearían, en orden de fila. */
    usernames: string[];
  };
}

export interface AnalyzeImportOptions {
  /** Usuarios que ya existen en la base de datos (nunca se reasignan). */
  takenUsernames: ReadonlySet<string>;
  /** Decisiones del administrador por número de fila. */
  resolutions?: Readonly<Record<number, DuplicateResolution>>;
  maxRows?: number;
}

function asDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * Analiza las filas de personas y produce una vista previa.
 *
 * Contrato:
 * - Es **puro**: no escribe nada, no llama a red, no usa reloj.
 * - La misma entrada produce siempre la misma salida.
 * - Los usuarios asignados aquí coinciden con los que creará el servidor,
 *   porque el servidor ejecuta esta misma función con el mismo estado.
 * - Un duplicado NO se omite en silencio: queda pendiente y bloquea la
 *   confirmación hasta que el administrador decida "omitir" o "es otra
 *   persona" (en ese caso se crea `rol1.garcia2`).
 * - Un usuario que ya existe en la base de datos solo se puede omitir:
 *   incluirlo duplicaría cuentas de una persona real.
 * - Las filas inválidas bloquean la confirmación.
 */
export function analyzeImportRows(
  rawRows: readonly RawPersonRow[],
  options: AnalyzeImportOptions,
): ImportPreview {
  const maxRows = options.maxRows ?? MAX_IMPORT_ROWS;
  const resolutions = options.resolutions ?? {};

  if (rawRows.length === 0) {
    throw new DomainError("IMPORT_EMPTY", "El fichero no contiene ninguna fila de datos.");
  }

  if (rawRows.length > maxRows) {
    throw new DomainError(
      "IMPORT_TOO_LARGE",
      `El fichero supera el máximo de ${maxRows} filas por importación.`,
    );
  }

  // Se distingue lo que ya existe en la BD de lo asignado en este análisis:
  // un usuario creado en esta misma vista previa NO debe hacer que otra fila
  // se marque como "ya existente" (sería un duplicado intra-fichero).
  const takenFromDatabase = new Set<string>(options.takenUsernames);
  const taken = new Set<string>(takenFromDatabase);
  const firstRowByBase = new Map<string, number>();
  const rows: PreviewRow[] = [];

  for (const raw of rawRows) {
    const issues: ImportIssue[] = [];

    const rol = normalizePersonRol(raw.rol);
    if (rol === null) {
      issues.push({
        code: "ROL_INVALID",
        message: `Rol no admitido: se esperaba «ROL 1» o «ROL 2» y se recibió «${asDisplayText(raw.rol)}».`,
      });
    }

    let surnameKey = "";
    let surnameDisplay = "";
    try {
      const surname = normalizeSurname(raw.apellido);
      surnameKey = surname.key;
      surnameDisplay = surname.display;
    } catch (error) {
      if (error instanceof DomainError) {
        issues.push({ code: error.code, message: error.message });
      } else {
        throw error;
      }
    }

    if (issues.length > 0 || rol === null) {
      rows.push({
        status: "error",
        rowNumber: raw.rowNumber,
        rolRaw: asDisplayText(raw.rol),
        apellidoRaw: asDisplayText(raw.apellido),
        issues,
      });
      continue;
    }

    const base = buildBaseUsername(rol, surnameKey);
    const duplicateOfRow = firstRowByBase.get(base) ?? null;
    const existsInDatabase = takenFromDatabase.has(base);

    if (firstRowByBase.has(base) || existsInDatabase) {
      const resolution = resolutions[raw.rowNumber] ?? null;
      rows.push({
        status: "duplicate",
        rowNumber: raw.rowNumber,
        rol,
        apellido: surnameDisplay,
        duplicateOfRow,
        reason: existsInDatabase ? "already_exists" : "same_file",
        resolution,
        includable: !existsInDatabase,
      });
      continue;
    }

    firstRowByBase.set(base, raw.rowNumber);
    rows.push({
      status: "ok",
      rowNumber: raw.rowNumber,
      rol,
      apellido: surnameDisplay,
      username: allocateUsername(base, (candidate) => taken.has(candidate)),
    });
    taken.add((rows[rows.length - 1] as Extract<PreviewRow, { status: "ok" }>).username);
  }

  // Segunda pasada: aplicar resoluciones "incluir" (persona distinta con el
  // mismo apellido y rol). Se hace después para que los sufijos no dependan de
  // decisiones aún no tomadas.
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    if (current.status !== "duplicate") continue;
    if (current.resolution !== "include") continue;

    if (!current.includable) {
      throw new DomainError(
        "DUPLICATE_CANNOT_INCLUDE",
        `La fila ${current.rowNumber} corresponde a una cuenta que ya existe: no se puede importar de nuevo.`,
        409,
      );
    }

    const surname = normalizeSurname(current.apellido);
    const base = buildBaseUsername(current.rol, surname.key);
    const username = allocateUsername(base, (candidate) => taken.has(candidate));
    taken.add(username);
    assertValidUsername(username);

    rows[index] = {
      status: "ok",
      rowNumber: current.rowNumber,
      rol: current.rol,
      apellido: current.apellido,
      username,
      duplicateOfRow: current.duplicateOfRow ?? undefined,
    };
  }

  const valid = rows.filter((row) => row.status === "ok").length;
  const invalid = rows.filter((row) => row.status === "error").length;
  const duplicateRows = rows.filter((row) => row.status === "duplicate");
  const duplicatesPending = duplicateRows.filter((row) => row.resolution === null).length;
  const duplicatesSkipped = duplicateRows.filter((row) => row.resolution === "skip").length;
  const duplicatesIncluded = Object.values(resolutions).filter((r) => r === "include").length;

  return {
    rows,
    summary: {
      totalRows: rows.length,
      valid,
      invalid,
      duplicates: duplicateRows.length + duplicatesIncluded,
      duplicatesPending,
      duplicatesSkipped,
      duplicatesIncluded,
      confirmable: invalid === 0 && duplicatesPending === 0 && valid > 0,
      usernames: rows
        .filter((row): row is Extract<PreviewRow, { status: "ok" }> => row.status === "ok")
        .map((row) => row.username),
    },
  };
}

/**
 * Comprueba que las decisiones del administrador no contienen basura
 * (número de fila inexistente, resolución desconocida). Se usa en el endpoint
 * para no confiar en el cuerpo de la petición.
 */
export function assertValidResolutions(
  resolutions: unknown,
  rawRows: readonly RawPersonRow[],
): Record<number, DuplicateResolution> {
  if (resolutions === undefined || resolutions === null) return {};
  if (typeof resolutions !== "object" || Array.isArray(resolutions)) {
    throw new DomainError("RESOLUTIONS_INVALID", "Las decisiones de duplicados no son válidas.");
  }

  const knownRows = new Set(rawRows.map((row) => row.rowNumber));
  const result: Record<number, DuplicateResolution> = {};

  for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || !knownRows.has(rowNumber)) {
      throw new DomainError(
        "RESOLUTIONS_UNKNOWN_ROW",
        `Hay una decisión para una fila que no existe (${key}).`,
      );
    }
    if (value !== "skip" && value !== "include") {
      throw new DomainError(
        "RESOLUTIONS_INVALID_VALUE",
        `Decisión no válida para la fila ${rowNumber}.`,
      );
    }
    result[rowNumber] = value;
  }

  return result;
}
