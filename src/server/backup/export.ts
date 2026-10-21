import { DomainError } from "@/domain/text";
import { encodeValue, type BackupValue } from "@/server/backup/codec";
import { assertPassphrase } from "@/server/backup/crypto";
import { writeBackupArchive, type BackupManifest, type ExportBlock } from "@/server/backup/archive";
import type { BackupRecord, BackupSource } from "@/server/backup/store";
import { SCHEMA_VERSION } from "@/server/db/schema.constants";

/**
 * EXPORTACIÓN DE LA BASE DE DATOS
 * ===============================
 *
 * Recorre todas las colecciones (incluidas las subcolecciones de las versiones
 * de curso), codifica cada documento y escribe un archivo cifrado.
 *
 * Qué incluye: cuentas, nombres de usuario, tokens de activación (solo su
 * hash), auditoría, cursos y versiones, claves de corrección, matrículas,
 * progreso y su histórico, intentos, metadatos de PDF, fragmentos binarios de
 * los PDF y la configuración de cuotas (`meta/storage`, `meta/schema`). Sin
 * esos datos el sistema no se puede reconstruir.
 *
 * Qué NO incluye: nada de Firebase Authentication (usuarios, contraseñas). No
 * es un olvido: las contraseñas no son legibles y cada usuario las cambia en la
 * activación. Tras una restauración hay que volver a crear las cuentas de Auth
 * o pedir a los usuarios que se activen de nuevo. Está documentado en
 * `docs/INFORME-FASE-7.md` como límite de consistencia.
 */

export interface ExportOptions {
  source: BackupSource;
  passphrase: string;
  outPath: string;
  createdAt?: Date;
}

export interface ExportResult {
  manifest: BackupManifest;
  bytes: number;
  outPath: string;
  byCollection: Record<string, number>;
}

export async function exportBackup(options: ExportOptions): Promise<ExportResult> {
  assertPassphrase(options.passphrase);

  const names = await options.source.collections();
  if (names.length === 0) {
    throw new DomainError(
      "BACKUP_EMPTY_SOURCE",
      "No hay ninguna colección que exportar: ¿está bien configurado el proyecto?",
      409,
    );
  }

  const blocks = encodeBlocks(options.source, names);

  const { manifest, bytes } = await writeBackupArchive({
    outPath: options.outPath,
    passphrase: options.passphrase,
    schemaVersion: SCHEMA_VERSION,
    createdAt: options.createdAt ?? new Date(),
    blocks,
  });

  const byCollection: Record<string, number> = {};
  for (const collection of manifest.collections) {
    byCollection[collection.name] = collection.records;
  }

  return { manifest, bytes, outPath: options.outPath, byCollection };
}

async function* encodeBlocks(
  source: BackupSource,
  names: string[],
): AsyncIterable<ExportBlock> {
  // Orden estable: dos copias del mismo estado producen el mismo orden de
  // bloques, lo que hace comparables los manifiestos.
  for (const name of [...names].sort()) {
    yield { name, lines: encodeRecords(source.read(name), name) };
  }
}

async function* encodeRecords(
  records: AsyncIterable<BackupRecord>,
  collection: string,
): AsyncGenerator<BackupRecord> {
  for await (const record of records) {
    assertRecordPath(record.path, collection);
    const data: Record<string, BackupValue> = {};

    for (const [key, value] of Object.entries(record.data)) {
      data[key] = encodeValue(value, `${record.path}.${key}`);
    }

    yield { path: record.path, data };
  }
}

/**
 * La ruta debe pertenecer a la colección que se está exportando. Evita que una
 * consulta mal hecha meta documentos de otra colección en el lugar equivocado
 * (y que la restauración los escriba donde no toca).
 */
export function assertRecordPath(path: string, collection: string): void {
  const segments = path.split("/");
  const valid =
    path.startsWith(`${collection}/`) &&
    segments.length % 2 === 0 &&
    segments.every((segment) => segment.length > 0 && !segment.includes("\\"));

  if (!valid) {
    throw new DomainError(
      "BACKUP_INVALID_PATH",
      `Ruta de documento no válida en la copia: «${path}» no pertenece a «${collection}».`,
      500,
    );
  }
}
