import { DomainError } from "@/domain/text";
import { canonicalJson } from "@/server/backup/codec";
import { assertPassphrase, deriveKey } from "@/server/backup/crypto";
import {
  readCollectionRecords,
  readManifest,
  type BackupManifest,
  type CollectionManifest,
} from "@/server/backup/archive";
import { assertRecordPath } from "@/server/backup/export";
import type { BackupRecord, BackupTarget } from "@/server/backup/store";

/**
 * RESTAURACIÓN DE UNA COPIA
 * =========================
 *
 * Reglas duras:
 *   · **no** se escribe en un destino que ya tenga datos, salvo `force`;
 *   · cada bloque se descifra y se verifica (GCM + SHA-256) antes de escribir
 *     nada de ese bloque;
 *   · los documentos se escriben por lotes pequeños (400 documentos y ~6 MiB)
 *     para no acercarse al límite de 10 MiB por petición de Firestore;
 *   · `dryRun` recorre y valida todo sin escribir.
 *
 * Límite de consistencia: la copia es un recorrido de colecciones sin
 * transacción global. Si alguien escribe mientras se exporta, la copia puede
 * mezclar dos instantes (documento A antes, documento B después). Para una
 * copia coherente hay que hacerla con la aplicación parada o en solo lectura.
 */

export interface RestoreOptions {
  inPath: string;
  passphrase: string;
  target: BackupTarget;
  /** Permite restaurar sobre un destino que ya tiene datos. */
  force?: boolean;
  /** Valida y cuenta sin escribir nada. */
  dryRun?: boolean;
  /** Tamaño máximo de lote (documentos). */
  batchRecords?: number;
  /** Tamaño máximo de lote (bytes de JSON canónico). */
  batchBytes?: number;
}

export interface RestoreResult {
  manifest: BackupManifest;
  dryRun: boolean;
  records: number;
  collections: Record<string, number>;
  totalInTargetAfter: number;
}

export const DEFAULT_BATCH_RECORDS = 400;
export const DEFAULT_BATCH_BYTES = 6 * 1024 * 1024;

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  assertPassphrase(options.passphrase);

  const manifest = await readManifest(options.inPath);
  const dryRun = options.dryRun === true;
  // scrypt una sola vez para todo el archivo (la sal es única).
  const key = deriveKey(options.passphrase, Buffer.from(manifest.salt, "base64"));
  const batchRecords = options.batchRecords ?? DEFAULT_BATCH_RECORDS;
  const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;

  if (batchRecords < 1 || batchRecords > 500) {
    throw new DomainError(
      "BACKUP_BATCH_INVALID",
      "El lote debe estar entre 1 y 500 documentos (límite de escrituras por lote de Firestore).",
      400,
    );
  }

  if (!dryRun) {
    const empty = await options.target.isEmpty();
    if (!empty && !options.force) {
      throw new DomainError(
        "BACKUP_TARGET_NOT_EMPTY",
        "El destino ya tiene datos. Restaurar encima puede mezclar dos estados; usa --force si es lo que quieres.",
        409,
      );
    }
  }

  const counts: Record<string, number> = {};
  let records = 0;

  for (const collection of manifest.collections) {
    counts[collection.name] = await restoreCollection({
      options,
      manifest,
      collection,
      key,
      dryRun,
      batchRecords,
      batchBytes,
    });
    records += counts[collection.name];
  }

  if (records !== manifest.records) {
    throw new DomainError(
      "BACKUP_COUNT_MISMATCH",
      `La copia declara ${manifest.records} documentos y se han leído ${records}. No se da por buena la restauración.`,
      422,
    );
  }

  const totalInTargetAfter = dryRun ? 0 : await options.target.count();

  if (!dryRun && totalInTargetAfter < records) {
    throw new DomainError(
      "BACKUP_RESTORE_INCOMPLETE",
      `Tras restaurar hay ${totalInTargetAfter} documentos en el destino y deberían ser al menos ${records}.`,
      500,
    );
  }

  return { manifest, dryRun, records, collections: counts, totalInTargetAfter };
}

async function restoreCollection(input: {
  options: RestoreOptions;
  manifest: BackupManifest;
  collection: CollectionManifest;
  key: Buffer;
  dryRun: boolean;
  batchRecords: number;
  batchBytes: number;
}): Promise<number> {
  const { options, manifest, collection, key, dryRun, batchRecords, batchBytes } = input;

  let batch: BackupRecord[] = [];
  let batchSize = 0;
  let count = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    if (!dryRun) await options.target.write(batch);
    count += batch.length;
    batch = [];
    batchSize = 0;
  };

  for await (const record of readCollectionRecords(
    options.inPath,
    manifest,
    collection,
    key,
  )) {
    assertRecordPath(record.path, collection.name);

    const size = Buffer.byteLength(canonicalJson(record.data), "utf8");
    if (size > batchBytes) {
      throw new DomainError(
        "BACKUP_DOCUMENT_TOO_LARGE",
        `El documento «${record.path}» ocupa ${size} bytes: no cabe en un lote de escritura.`,
        500,
      );
    }

    if (batch.length > 0 && (batch.length >= batchRecords || batchSize + size > batchBytes)) {
      await flush();
    }

    batch.push(record);
    batchSize += size;
  }

  await flush();
  return count;
}
