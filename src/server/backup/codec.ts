import { DomainError } from "@/domain/text";

/**
 * CODIFICACIÓN DE VALORES PARA LA COPIA DE SEGURIDAD
 * ==================================================
 *
 * Firestore no es JSON: guarda `Bytes` (binario), `Timestamp` (segundos +
 * nanosegundos) y mapas anidados. Una copia hecha con `JSON.stringify` perdería
 * los fragmentos de los PDF y las fechas. Aquí cada valor se convierte a una
 * forma JSON con etiqueta explícita y vuelve exactamente igual.
 *
 * Decisión de diseño: **fallar cerrado**. Si aparece un tipo que no sabemos
 * representar (GeoPoint, DocumentReference, Vector…), la exportación se detiene
 * en lugar de guardar una copia incompleta que parezca buena.
 */

export type BackupValue =
  | string
  | number
  | boolean
  | null
  | BackupValue[]
  | { [key: string]: BackupValue }
  | { $bytes: string }
  | { $timestamp: { seconds: number; nanoseconds: number } };

export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
}

export function isTimestampLike(value: unknown): value is TimestampLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TimestampLike> & { toMillis?: unknown };
  return (
    typeof candidate.seconds === "number" &&
    typeof candidate.nanoseconds === "number" &&
    typeof candidate.toMillis === "function"
  );
}

/** Convierte un valor de Firestore a JSON con etiquetas. */
export function encodeValue(value: unknown, path = "documento"): BackupValue {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new DomainError(
          "BACKUP_UNSUPPORTED_VALUE",
          `Número no finito en ${path}: no se puede exportar.`,
          500,
        );
      }
      return value;
    case "undefined":
      throw new DomainError(
        "BACKUP_UNSUPPORTED_VALUE",
        `Valor indefinido en ${path}: no se puede exportar sin perder información.`,
        500,
      );
    default:
      break;
  }

  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }

  if (isTimestampLike(value)) {
    return {
      $timestamp: { seconds: value.seconds, nanoseconds: value.nanoseconds },
    };
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => encodeValue(item, `${path}[${index}]`));
  }

  if (value instanceof Date) {
    // Firestore devuelve Timestamp, no Date; si llega un Date lo convertimos.
    return { $timestamp: { seconds: Math.floor(value.getTime() / 1000), nanoseconds: 0 } };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const encoded: Record<string, BackupValue> = {};
    for (const [key, item] of Object.entries(record)) {
      encoded[key] = encodeValue(item, `${path}.${key}`);
    }
    return encoded;
  }

  throw new DomainError(
    "BACKUP_UNSUPPORTED_VALUE",
    `Tipo no soportado en ${path}: ${typeof value}. La copia se detiene para no quedar incompleta.`,
    500,
  );
}

/** Reconstruye el valor a partir de la etiqueta. */
export function decodeValue(value: BackupValue, path = "documento"): unknown {
  if (value === null) return null;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => decodeValue(item, `${path}[${index}]`));
  }

  const record = value as Record<string, BackupValue>;

  if (typeof record.$bytes === "string") {
    return Buffer.from(record.$bytes, "base64");
  }

  if (record.$timestamp) {
    const stamp = record.$timestamp as { seconds: number; nanoseconds: number };
    return { $timestamp: { seconds: stamp.seconds, nanoseconds: stamp.nanoseconds } };
  }

  const decoded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    decoded[key] = decodeValue(item, `${path}.${key}`);
  }
  return decoded;
}

/** ¿Es una marca de tiempo ya decodificada? (el adaptador la convierte a `Timestamp`). */
export function isDecodedTimestamp(value: unknown): value is {
  $timestamp: { seconds: number; nanoseconds: number };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const stamp = record.$timestamp as TimestampLike | undefined;
  return Boolean(
    stamp && typeof stamp.seconds === "number" && typeof stamp.nanoseconds === "number",
  );
}

/** Recorre un documento decodificado y convierte las marcas de tiempo. */
export function mapTimestamps(
  value: unknown,
  convert: (timestamp: TimestampLike) => unknown,
): unknown {
  if (isDecodedTimestamp(value)) return convert(value.$timestamp);

  if (Array.isArray(value)) return value.map((item) => mapTimestamps(item, convert));

  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = mapTimestamps(item, convert);
    }
    return output;
  }

  return value;
}

/**
 * JSON canónico: claves ordenadas, para que el mismo documento produzca siempre
 * la misma huella (y para que comparar dos copias no dependa del orden).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) output[key] = sortDeep(item);
    return output;
  }
  return value;
}
