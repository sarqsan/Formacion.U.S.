#!/usr/bin/env node
/**
 * ENSAYO DE COPIA Y RESTAURACIÓN (SOLO EMULADOR, SOLO DATOS SINTÉTICOS)
 * ====================================================================
 *
 *   npm run rehearse:backup
 *
 * Requiere `FIRESTORE_EMULATOR_HOST` y `FIREBASE_PROJECT_ID` (por ejemplo
 * `demo-formacion`). Se niega a ejecutarse contra un proyecto real.
 *
 * Qué hace, en orden:
 *   1. borra el contenido del emulador y siembra el conjunto sintético;
 *   2. hace una foto del contenido (ruta → JSON canónico);
 *   3. exporta a un archivo temporal cifrado (contraseña efímera del ensayo);
 *   4. restaura en seco (`dryRun`) para comprobar que la copia se descifra y
 *      sus recuentos cuadran;
 *   5. borra el emulador y comprueba que queda vacío;
 *   6. restaura de verdad;
 *   7. vuelve a hacer la foto y la compara documento a documento con la del
 *      paso 2, incluidos los bytes de los fragmentos de PDF;
 *   8. informa PASSED / FAILED con tiempos.
 *
 * Lo que este ensayo **no** prueba: Firebase real, usuarios de Authentication
 * (no están en la copia) ni la coherencia de una copia hecha con escrituras en
 * marcha.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { exportBackup } from "../src/server/backup/export";
import { restoreBackup } from "../src/server/backup/restore";
import { canonicalJson, encodeValue } from "../src/server/backup/codec";
import { FirestoreBackupSource, FirestoreBackupTarget } from "../src/server/firebase/backup-store";
import { SYNTHETIC_DOCUMENTS, resetEmulatorCollections } from "./lib/synthetic-data";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulator) {
  fail("Este ensayo exige FIRESTORE_EMULATOR_HOST. No se ejecuta nunca contra un proyecto real.");
}
if (process.env.NODE_ENV === "production") {
  fail("No se hacen ensayos con NODE_ENV=production.");
}

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) fail("Falta FIREBASE_PROJECT_ID (por ejemplo demo-formacion).");

const workspace = mkdtempSync(join(tmpdir(), "formacion-ensayo-"));
const backupPath = join(workspace, "ensayo.fbak");

/** Contraseña efímera: no se imprime ni se guarda. */
const passphrase = process.env.BACKUP_PASSPHRASE ?? randomBytes(18).toString("base64");

const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);

/** Foto del contenido: ruta → JSON canónico con Bytes y Timestamps normalizados. */
async function snapshot(): Promise<Map<string, string>> {
  const source = new FirestoreBackupSource(db);
  const photo = new Map<string, string>();

  for (const collection of await source.collections()) {
    for await (const record of source.read(collection)) {
      photo.set(record.path, canonicalJson(encodeValue(record.data)));
    }
  }
  return photo;
}

function compare(a: Map<string, string>, b: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, value] of a) {
    if (!b.has(path)) problems.push(`falta en la restauración: ${path}`);
    else if (b.get(path) !== value) problems.push(`no coincide: ${path}`);
  }
  for (const path of b.keys()) {
    if (!a.has(path)) problems.push(`sobra en la restauración: ${path}`);
  }
  return problems.sort();
}

async function seed(): Promise<void> {
  const batch = db.batch();
  for (const document of SYNTHETIC_DOCUMENTS) batch.set(db.doc(document.path), document.data);
  await batch.commit();
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log("\n=== Ensayo de copia y restauración (emulador, datos sintéticos) ===");
  console.log(`Emulador: ${emulator}`);
  console.log(`Proyecto: ${projectId}`);
  console.log(`Archivo:  ${backupPath}`);
  console.log(`Contraseña: ${process.env.BACKUP_PASSPHRASE ? "la del entorno" : "efímera generada para el ensayo"}`);

  console.log("\n1. Sembrando datos sintéticos…");
  await resetEmulatorCollections(db);
  await seed();
  const original = await snapshot();
  console.log(`   ${original.size} documentos.`);

  console.log("2. Exportando…");
  const exported = await exportBackup({
    source: new FirestoreBackupSource(db),
    passphrase,
    outPath: backupPath,
  });
  console.log(
    `   ${exported.manifest.records} documentos, ${(statSync(backupPath).size / 1024).toFixed(1)} KiB cifrados, ` +
      `${exported.manifest.collections.length} colecciones.`,
  );

  console.log("3. Restauración en seco (verifica descifrado y recuentos)…");
  const dry = await restoreBackup({
    inPath: backupPath,
    passphrase,
    target: new FirestoreBackupTarget(db),
    dryRun: true,
  });
  console.log(`   ${dry.records} documentos legibles, sin escribir.`);

  console.log("4. Borrando el emulador…");
  const removed = await resetEmulatorCollections(db);
  const empty = await new FirestoreBackupTarget(db).isEmpty();
  console.log(`   ${removed} documentos borrados; vacío: ${empty ? "sí" : "NO"}`);
  if (!empty) fail("El emulador no quedó vacío: la restauración no sería comparable.");

  console.log("5. Restaurando…");
  const restored = await restoreBackup({
    inPath: backupPath,
    passphrase,
    target: new FirestoreBackupTarget(db),
  });
  console.log(
    `   ${restored.records} documentos escritos en ${Object.keys(restored.collections).length} colecciones.`,
  );

  console.log("6. Comparando con el original…");
  const after = await snapshot();
  const problems = compare(original, after);

  if (problems.length > 0) {
    console.error("\nDiferencias encontradas:");
    for (const problem of problems.slice(0, 20)) console.error(`   · ${problem}`);
    console.error(`\nRESULTADO: FAILED (${problems.length} diferencias)`);
    process.exit(1);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`   ${after.size} documentos idénticos (incluidos los bytes del PDF).`);
  console.log(`\nRESULTADO: PASSED en ${seconds} s`);
  console.log("Recuerda: ensayo sobre el emulador. La copia real de un proyecto\n" +
    "tampoco incluye usuarios de Firebase Authentication.\n");
}

main()
  .catch((error) => {
    console.error(`\nRESULTADO: FAILED — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workspace, { recursive: true, force: true });
  });
