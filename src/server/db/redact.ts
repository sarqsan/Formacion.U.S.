/**
 * REDACCIÓN DE IDENTIFICADORES PARA LA AUDITORÍA (puro)
 * ====================================================
 *
 * `scripts/db-check.ts --redact` imprime el informe en un sitio que puede ser
 * público (registro de GitHub Actions de un repositorio público). Antes de
 * imprimir, los identificadores personales se sustituyen aquí por etiquetas
 * estables (`usuario#1`, `uid#2`, `origen#3`).
 *
 * Reglas de diseño:
 *   - La redacción ocurre EN EL VERIFICADOR, antes de escribir en la salida.
 *     No hay ningún paso posterior que "limpie" un registro ya contaminado.
 *   - Solo se sustituyen valores, nunca la estructura: se conservan niveles,
 *     códigos, recuentos y el número de referencias de cada hallazgo.
 *   - La misma etiqueta para el mismo valor permite correlacionar hallazgos
 *     dentro de un mismo informe sin revelar la identidad.
 *   - La redacción no es anonimización en origen: los datos siguen existiendo
 *     en Firestore; esto solo controla lo que se imprime.
 *   - `summarize()` se calcula sobre los hallazgos originales: redactar no
 *     puede cambiar el veredicto de la comprobación.
 *
 * Este módulo no hace E/S y no importa nada del entorno: se puede probar.
 */

import type { Finding } from "./checks";

export type RedactionKind = "usuario" | "uid" | "origen";

export interface RedactionIndex {
  /** Valores a sustituir, ordenados de más largo a más corto. */
  readonly entries: ReadonlyArray<{ value: string; label: string }>;
}

/**
 * Valores técnicos que no identifican a nadie y que hay que poder leer tal
 * cual: distinguen el procedimiento de arranque de cualquier otro origen.
 */
const TECHNICAL_LITERALS = new Set(["bootstrap-script"]);

/** Longitud mínima para sustituir un valor: evita destrozar texto legítimo. */
const MIN_VALUE_LENGTH = 3;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const KNOWN_TOKEN_PATTERN = /\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g;
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9_+/=-]{40,}={0,2}/g;

function allocate(kind: RedactionKind, values: Iterable<string | undefined>, into: Map<string, string>) {
  const clean = [...new Set([...values].filter((value): value is string => typeof value === "string"))]
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_VALUE_LENGTH && !TECHNICAL_LITERALS.has(value))
    .sort();
  let counter = 0;
  for (const value of clean) {
    if (into.has(value)) continue;
    counter += 1;
    into.set(value, `${kind}#${counter}`);
  }
}

/**
 * Construye el índice con los datos reales leídos de la base de datos.
 * Se numeran por orden alfabético para que la etiqueta de un valor no dependa
 * del orden en que Firestore devolvió los documentos.
 */
export function buildRedactionIndex(
  accounts: ReadonlyArray<{ uid?: string; username?: string; createdBy?: string }>,
): RedactionIndex {
  const labels = new Map<string, string>();
  allocate("uid", accounts.map((account) => account.uid), labels);
  allocate("usuario", accounts.map((account) => account.username), labels);
  allocate("origen", accounts.map((account) => account.createdBy), labels);

  const entries = [...labels.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => right.value.length - left.value.length);

  return { entries };
}

function replaceLiteral(text: string, value: string, replacement: string): string {
  return text.split(value).join(replacement);
}

/**
 * Filtro genérico: no depende de conocer los datos, así que también se puede
 * aplicar a un error inesperado en el que la lectura ni siquiera llegó a hacer.
 */
export function redactGeneric(text: string): string {
  return text
    .replace(PRIVATE_KEY_PATTERN, "[clave privada omitida]")
    .replace(EMAIL_PATTERN, "[correo omitido]")
    .replace(KNOWN_TOKEN_PATTERN, "[token omitido]")
    .replace(LONG_OPAQUE_PATTERN, "[cadena larga omitida]");
}

/**
 * Redacta un texto: primero los valores conocidos, después el filtro genérico
 * y al final una comprobación de que no queda ningún valor conocido.
 */
export function redactText(text: string, index: RedactionIndex): string {
  let result = text;
  for (const entry of index.entries) {
    result = replaceLiteral(result, entry.value, entry.label);
  }
  result = redactGeneric(result);
  for (const entry of index.entries) {
    if (result.includes(entry.value)) {
      result = replaceLiteral(result, entry.value, "[identificador omitido]");
    }
  }
  return result;
}

/** ¿Queda algún identificador conocido (o un correo) en este texto? */
export function containsPii(text: string, index: RedactionIndex): boolean {
  if (index.entries.some((entry) => text.includes(entry.value))) return true;
  EMAIL_PATTERN.lastIndex = 0;
  return EMAIL_PATTERN.test(text);
}

/**
 * Redacta una lista de hallazgos conservando orden, niveles, códigos y el
 * número de referencias de cada uno.
 */
export function redactFindings(findings: readonly Finding[], index: RedactionIndex): Finding[] {
  return findings.map((finding) => {
    const redacted: Finding = {
      level: finding.level,
      code: finding.code,
      message: redactText(finding.message, index),
    };
    if (finding.refs) {
      redacted.refs = finding.refs.map((ref) => redactText(ref, index));
    }
    return redacted;
  });
}

/**
 * Segunda capa: si una línea preparada para imprimir todavía contuviera un
 * identificador conocido, se sustituye la línea entera. Nunca se imprime.
 */
export function guardLine(line: string, index: RedactionIndex): string {
  return containsPii(line, index) ? "[línea omitida: contenía un identificador]" : line;
}

export type AuditVerdict = "NO_ADMIN" | `ADMIN_COUNT ${number}` | "ADMIN_UNKNOWN";
export type SchemaVerdict = "OK" | "AUSENTE" | "INCOMPATIBLE" | "NO COMPROBABLE";
export type IndexesVerdict = "OK" | "FALTAN" | "NO COMPROBABLE";

export interface AuditStatus {
  audit: AuditVerdict | "AUDIT_BLOCKED";
  schema: SchemaVerdict;
  indexes: IndexesVerdict;
}

/**
 * Estado técnico derivado de los códigos de los hallazgos, nunca del código de
 * salida: `NO_ADMIN` también hace salir con 1 y no es un bloqueo técnico.
 */
export function auditStatus(input: {
  findings: readonly Finding[];
  /** Número de cuentas con rol admin, o null si no se llegaron a leer. */
  adminCount: number | null;
  /** true si la ejecución se interrumpió antes de poder evaluar los datos. */
  blocked?: boolean;
}): AuditStatus {
  if (input.blocked) {
    return { audit: "AUDIT_BLOCKED", schema: "NO COMPROBABLE", indexes: "NO COMPROBABLE" };
  }

  const codes = new Set(input.findings.map((finding) => finding.code));

  let audit: AuditStatus["audit"];
  if (codes.has("NO_ADMIN") || input.adminCount === 0) {
    audit = "NO_ADMIN";
  } else if (input.adminCount === null) {
    audit = "ADMIN_UNKNOWN";
  } else {
    audit = `ADMIN_COUNT ${input.adminCount}`;
  }

  let schema: SchemaVerdict;
  if (codes.has("SCHEMA_VERSION_OK")) {
    schema = "OK";
  } else if (codes.has("SCHEMA_NOT_INITIALIZED")) {
    schema = "AUSENTE";
  } else if (
    codes.has("SCHEMA_VERSION_NEWER") ||
    codes.has("SCHEMA_VERSION_OLDER") ||
    codes.has("SCHEMA_VERSION_MISSING")
  ) {
    schema = "INCOMPATIBLE";
  } else {
    schema = "NO COMPROBABLE";
  }

  let indexes: IndexesVerdict;
  if (codes.has("MISSING_INDEXES")) {
    indexes = "FALTAN";
  } else if (codes.has("INDEXES_OK")) {
    indexes = "OK";
  } else {
    indexes = "NO COMPROBABLE";
  }

  return { audit, schema, indexes };
}

/** Una sola línea, sin datos personales, para el resumen del workflow. */
export function formatAuditStatus(status: AuditStatus): string {
  return `AUDITORÍA: ${status.audit} · ESQUEMA: ${status.schema} · ÍNDICES: ${status.indexes}`;
}
