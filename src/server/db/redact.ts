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
 *   - El índice se construye con TODAS las fuentes de identificadores que
 *     pueden acabar impresas (`accounts` y los `uid` de `progress`/`attempts`),
 *     no solo con las cuentas: un `uid` huérfano —de una cuenta borrada o de un
 *     rollback fallido— también se redacta.
 *   - Antes de imprimir se sanean los caracteres de control (\r, \n, tab…):
 *     un dato manipulado no puede fabricar líneas nuevas, ni una línea falsa
 *     `AUDITORÍA: …` en el resumen del workflow.
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

/**
 * Caracteres de control que pueden partir una línea. U+0085, U+2028 y U+2029
 * también los interpretan como salto algunos visores de registros.
 */
const CONTROL_PATTERN = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const KNOWN_TOKEN_PATTERN = /\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g;
const LONG_OPAQUE_PATTERN = /\b[A-Za-z0-9_+/=-]{40,}={0,2}/g;
const UUID_PATTERN = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
/** UID de Firebase: 20–40 caracteres alfanuméricos con mayúsculas, minúsculas y dígitos. */
const FIREBASE_UID_PATTERN = /\b[A-Za-z0-9]{20,40}\b/g;

/**
 * Saneado de una línea: los controles se sustituyen por un carácter visible
 * (no por nada) para que se vea que el dato venía manipulado, y para que el
 * texto no pueda contener saltos de línea reales.
 */
export function sanitizeText(text: string): string {
  return text.replace(CONTROL_PATTERN, (character) => {
    if (character === "\n") return "␤";
    if (character === "\r") return "␍";
    if (character === "\t") return "␉";
    return "?";
  });
}

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
 *
 * `extraUids` son los identificadores que aparecen fuera de `accounts`
 * (`progress.uid`, `attempts.uid`). Se indexan aunque no tengan cuenta: son
 * justo los que produce un borrado de cuenta o un `rollbackAccount` fallido, y
 * `checkLearning` los imprime en el mensaje y en las referencias.
 *
 * Invariante de cobertura: el índice se construye con las MISMAS listas que se
 * pasan a `runChecks`, así que ningún valor que llegue a imprimirse puede
 * quedar fuera, aunque una lectura se trunque en `MAX_DOCS`: lo que no se leyó
 * tampoco se recorre, luego tampoco se imprime.
 */
export function buildRedactionIndex(input: {
  accounts?: ReadonlyArray<{ uid?: string; username?: string; createdBy?: string }>;
  extraUids?: ReadonlyArray<string | undefined>;
}): RedactionIndex {
  const accounts = input.accounts ?? [];
  const labels = new Map<string, string>();
  allocate(
    "uid",
    [...accounts.map((account) => account.uid), ...(input.extraUids ?? [])],
    labels,
  );
  allocate("usuario", accounts.map((account) => account.username), labels);
  allocate("origen", accounts.map((account) => account.createdBy), labels);

  // Un valor con saltos de línea se sanea antes de imprimirse, así que también
  // hay que poder reconocer su forma saneada.
  const raw = [...labels.entries()].map(([value, label]) => ({ value, label }));
  const seen = new Set<string>();
  const entries: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    for (const value of [entry.value, sanitizeText(entry.value)]) {
      if (seen.has(value)) continue;
      seen.add(value);
      entries.push({ value, label: entry.label });
    }
  }
  entries.sort((left, right) => right.value.length - left.value.length);

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
    .replace(LONG_OPAQUE_PATTERN, "[cadena larga omitida]")
    .replace(UUID_PATTERN, "[identificador omitido]")
    .replace(FIREBASE_UID_PATTERN, (candidate) =>
      // Solo se sustituye si parece un identificador (mayúsculas, minúsculas y
      // dígitos a la vez). Así no se destrozan textos técnicos ni courseId.
      /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /[0-9]/.test(candidate)
        ? "[identificador omitido]"
        : candidate,
    );
}

/**
 * Redacta un texto: primero se sanean los controles, después los valores
 * conocidos, luego el filtro genérico y al final una comprobación de que no
 * queda ningún valor conocido.
 */
export function redactText(text: string, index: RedactionIndex): string {
  let result = sanitizeText(text);
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
  if (EMAIL_PATTERN.test(text)) return true;
  // Última red: si tras redactar apareciera una forma de identificador que el
  // índice no conocía, la línea no se imprime.
  return redactGeneric(text) !== text;
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

/** Sanea un hallazgo sin redactar (modo sin `--redact`). */
export function sanitizeFinding(finding: Finding): Finding {
  const safe: Finding = {
    level: finding.level,
    code: finding.code,
    message: sanitizeText(finding.message),
  };
  if (finding.refs) safe.refs = finding.refs.map((ref) => sanitizeText(ref));
  return safe;
}

const ICONS: Record<Finding["level"], string> = {
  error: "✖",
  warning: "!",
  info: "·",
};

/**
 * Líneas que imprime el verificador para un hallazgo. Es la ÚNICA función que
 * produce la salida por hallazgo, para que lo que se prueba sea exactamente lo
 * que se imprime: saneado siempre, redacción y segunda capa si hay índice.
 */
export function formatFindingLines(finding: Finding, index: RedactionIndex | null): string[] {
  const lines = [
    `${ICONS[finding.level]} [${finding.level}] ${finding.code}: ${finding.message}`,
    ...(finding.refs ?? []).map((ref) => `      ↳ ${ref}`),
  ];
  return lines.map((line) => {
    const safe = sanitizeText(line);
    if (!index) return safe;
    return guardLine(redactText(safe, index), index);
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
