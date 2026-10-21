import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { DomainError } from "@/domain/text";
import { canonicalJson, decodeValue, type BackupValue } from "@/server/backup/codec";
import {
  CIPHER,
  KDF,
  createDecryptor,
  createEncryptor,
  deriveKey,
  equalHex,
  newSalt,
} from "@/server/backup/crypto";
import type { BackupRecord } from "@/server/backup/store";

/**
 * FORMATO DEL ARCHIVO DE COPIA (`.fbak`, versión 1)
 * ================================================
 *
 *   "FORMACION-BACKUP-1\n"    19 bytes de firma
 *   uint32 BE                 desplazamiento del manifiesto
 *   <bloques cifrados>        un bloque por colección, concatenados
 *   <manifiesto JSON>         hasta el final del archivo
 *
 * El manifiesto va al final para poder escribirlo cuando ya se conocen los
 * tamaños, sin reescribir el archivo ni cargarlo en memoria.
 *
 * Cada bloque es NDJSON (una línea = un documento `{path, data}`) cifrado con
 * AES-256-GCM y su propia sal, IV y etiqueta. El manifiesto **no** contiene
 * datos: solo nombres de colección, número de documentos, tamaños, parámetros
 * criptográficos y el SHA-256 del texto plano de cada bloque.
 */

export const MAGIC = "FORMACION-BACKUP-1\n";
export const FORMAT = "formacion-backup";
export const FORMAT_VERSION = 1;

export interface CollectionManifest {
  name: string;
  records: number;
  /** Bytes de texto cifrado (con GCM coincide con el tamaño en claro). */
  bytes: number;
  iv: string;
  tag: string;
  /** SHA-256 del NDJSON en claro: permite comprobar la integridad al restaurar. */
  sha256: string;
  plainBytes: number;
}

export interface BackupManifest {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  /** Versión del esquema de datos en el momento de la copia. */
  schemaVersion: number | string;
  records: number;
  collections: CollectionManifest[];
  cipher: string;
  kdf: typeof KDF;
  /** Sal única del archivo (la clave se deriva una sola vez). */
  salt: string;
  notice: string;
}

export interface ExportBlock {
  name: string;
  lines: AsyncIterable<BackupRecord>;
}

/** Serializa un registro a una línea NDJSON (valores ya codificados). */
export function serializeRecord(record: BackupRecord): string {
  return canonicalJson(record);
}

/** Convierte una línea NDJSON en un registro con valores descodificados. */
export function deserializeRecord(line: string): BackupRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DomainError("BACKUP_CORRUPT", "Una línea de la copia no es JSON válido.", 422);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as BackupRecord).path !== "string" ||
    typeof (parsed as BackupRecord).data !== "object"
  ) {
    throw new DomainError("BACKUP_CORRUPT", "Un registro de la copia no tiene «path» y «data».", 422);
  }

  const record = parsed as { path: string; data: Record<string, BackupValue> };
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.data)) {
    data[key] = decodeValue(value, `${record.path}.${key}`);
  }

  return { path: record.path, data };
}

/** Escribe el archivo completo. Devuelve el manifiesto (nunca la contraseña). */
export async function writeBackupArchive(input: {
  outPath: string;
  passphrase: string;
  schemaVersion: number | string;
  createdAt: Date;
  blocks: AsyncIterable<ExportBlock>;
}): Promise<{ manifest: BackupManifest; bytes: number }> {
  const handle = await open(input.outPath, "w");
  const collections: CollectionManifest[] = [];
  let records = 0;

  // scrypt una sola vez por archivo (~100 ms en lugar de una vez por colección).
  const salt = newSalt();
  const key = deriveKey(input.passphrase, salt);

  try {
    await handle.write(Buffer.from(MAGIC, "utf8"));
    await handle.write(Buffer.alloc(4)); // hueco para el desplazamiento

    for await (const block of input.blocks) {
      const { encryptor, settings } = createEncryptor(key);
      let cipherBytes = 0;
      let count = 0;

      for await (const record of block.lines) {
        const plain = Buffer.from(`${serializeRecord(record)}\n`, "utf8");
        const cipher = encryptor.update(plain);
        cipherBytes += cipher.length;
        await handle.write(cipher);
        count += 1;
      }

      const end = encryptor.final();
      cipherBytes += end.trailing.length;
      await handle.write(end.trailing);

      collections.push({
        name: block.name,
        records: count,
        bytes: cipherBytes,
        iv: settings.iv,
        tag: end.tag.toString("base64"),
        sha256: end.sha256,
        plainBytes: end.plainBytes,
      });
      records += count;
    }

    const manifest: BackupManifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      createdAt: input.createdAt.toISOString(),
      schemaVersion: input.schemaVersion,
      records,
      collections,
      cipher: CIPHER,
      kdf: KDF,
      salt: salt.toString("base64"),
      notice:
        "Copia cifrada de Formación U.G.–U.S. Contiene datos personales y claves de corrección: no la subas a servicios de terceros.",
    };

    const manifestJson = Buffer.from(canonicalJson(manifest), "utf8");
    const manifestOffset = (await handle.stat()).size;
    await handle.write(manifestJson);

    const header = Buffer.alloc(4);
    header.writeUInt32BE(manifestOffset, 0);
    await handle.write(header, 0, 4, MAGIC.length);

    const total = (await handle.stat()).size;
    return { manifest, bytes: total };
  } finally {
    await handle.close();
  }
}

export async function readManifest(path: string): Promise<BackupManifest> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < MAGIC.length + 4) {
      throw new DomainError("BACKUP_INVALID", "El archivo no es una copia válida.", 422);
    }

    const magic = Buffer.alloc(MAGIC.length);
    await handle.read(magic, 0, MAGIC.length, 0);
    if (magic.toString("utf8") !== MAGIC) {
      throw new DomainError(
        "BACKUP_INVALID",
        "El archivo no es una copia de Formación o es de una versión no soportada.",
        422,
      );
    }

    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, MAGIC.length);
    const manifestOffset = header.readUInt32BE(0);
    if (manifestOffset < MAGIC.length + 4 || manifestOffset >= size) {
      throw new DomainError("BACKUP_INVALID", "El archivo está truncado o dañado.", 422);
    }

    const manifestBytes = Buffer.alloc(size - manifestOffset);
    await handle.read(manifestBytes, 0, manifestBytes.length, manifestOffset);

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as BackupManifest;
    } catch {
      throw new DomainError("BACKUP_INVALID", "El manifiesto de la copia no es JSON válido.", 422);
    }

    if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) {
      throw new DomainError(
        "BACKUP_VERSION_UNSUPPORTED",
        `Versión de copia no soportada (${String(manifest.version)}).`,
        422,
      );
    }

    return manifest;
  } finally {
    await handle.close();
  }
}

/** Desplazamiento del bloque de una colección dentro del archivo. */
export function blockOffset(manifest: BackupManifest, name: string): number {
  let offset = MAGIC.length + 4;
  for (const item of manifest.collections) {
    if (item.name === name) return offset;
    offset += item.bytes;
  }
  throw new DomainError(
    "BACKUP_CORRUPT",
    `El manifiesto apunta a una colección que no está en el archivo (${name}).`,
    422,
  );
}

/**
 * Recorre una colección descifrando sus líneas.
 *
 * Se lee por flujos de 1 MiB: nunca se carga el bloque entero en memoria. Al
 * terminar comprueba la etiqueta GCM (manipulación o contraseña incorrecta) y
 * el SHA-256 del texto plano (integridad del contenido).
 */
export async function* readCollectionRecords(
  path: string,
  manifest: BackupManifest,
  collection: CollectionManifest,
  key: Buffer,
): AsyncGenerator<BackupRecord> {
  const start = blockOffset(manifest, collection.name);
  if (collection.bytes === 0) return; // colección vacía: nada que descifrar

  const end = start + collection.bytes - 1;
  const decryptor = createDecryptor(key, collection);
  let pending = "";

  const stream = createReadStream(path, { start, end, highWaterMark: 1024 * 1024 });

  for await (const chunk of stream) {
    const plain = decryptor.update(chunk as Buffer);
    if (plain.length === 0) continue;
    pending += plain.toString("utf8");

    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim() !== "") yield deserializeRecord(line);
      newline = pending.indexOf("\n");
    }
  }

  if (pending.trim() !== "") yield deserializeRecord(pending);

  const { sha256 } = decryptor.final();
  if (!equalHex(sha256, collection.sha256)) {
    throw new DomainError(
      "BACKUP_CORRUPT",
      `La colección «${collection.name}» no coincide con su huella: la copia está dañada.`,
      422,
    );
  }
}
