#!/usr/bin/env node
/**
 * RESTAURACIÓN DE UNA COPIA CIFRADA
 * =================================
 *
 *   BACKUP_PASSPHRASE='…' npm run backup:restore -- --in backups/copia.fbak --dry-run
 *   BACKUP_PASSPHRASE='…' npm run backup:restore -- --in backups/copia.fbak
 *
 * Comprobaciones antes de escribir:
 *   · la copia se descifra y se verifica bloque a bloque (GCM + SHA-256);
 *   · el destino debe estar vacío salvo `--force`;
 *   · escribir en un proyecto real exige `BACKUP_ALLOW_PROD=yes`.
 *
 * `--dry-run` recorre y valida la copia sin escribir nada. Es lo primero que
 * hay que ejecutar tras una copia, incluso si se va a restaurar en otro sitio.
 *
 * Límite de consistencia: restaura documentos, no usuarios de Firebase
 * Authentication (las contraseñas no son legibles). Ver docs/INFORME-FASE-7.md.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { restoreBackup } from "../src/server/backup/restore";
import { FirestoreBackupTarget } from "../src/server/firebase/backup-store";
import { resolve } from "node:path";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function buildApp() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) fail("Falta FIREBASE_PROJECT_ID.");

  if (getApps().length > 0) return getApps()[0];

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    fail("Faltan FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (o FIRESTORE_EMULATOR_HOST).");
  }

  return initializeApp({
    projectId,
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const passphrase = process.env.BACKUP_PASSPHRASE ?? "";
  const input = argument("--in");
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

  if (!input) fail("Indica el archivo con --in (por ejemplo --in backups/copia.fbak).");
  if (!passphrase) fail("Define BACKUP_PASSPHRASE con la contraseña usada al exportar.");
  if (!dryRun && !isEmulator && process.env.BACKUP_ALLOW_PROD !== "yes") {
    fail("Esto escribiría en un proyecto Firebase real. Si es intencionado, añade BACKUP_ALLOW_PROD=yes.");
  }

  const path = resolve(input);

  console.log("\n=== Restauración de la base de datos de Formación ===");
  console.log(`Proyecto: ${process.env.FIREBASE_PROJECT_ID ?? "(sin definir)"}`);
  console.log(`Modo:     ${dryRun ? "SIMULACIÓN (no escribe)" : isEmulator ? "emulador" : "Firebase real"}`);
  console.log(`Archivo:  ${path}\n`);

  const db = getFirestore(buildApp());
  const target = new FirestoreBackupTarget(db);

  const result = await restoreBackup({
    inPath: path,
    passphrase,
    target,
    dryRun,
    force,
  });

  console.log("Documentos restaurados por colección:");
  for (const [name, count] of Object.entries(result.collections)) {
    console.log(`  · ${name.padEnd(28)} ${String(count).padStart(6)}`);
  }
  console.log(`\nTotal leído:   ${result.records} documentos`);
  console.log(`En destino:    ${result.totalInTargetAfter}`);
  console.log(`Copia creada:  ${result.manifest.createdAt}`);

  if (dryRun) {
    console.log("\n✓ Copia válida. No se ha escrito nada.\n");
  } else {
    console.log("\n✓ Restauración completada. Comprueba con `npm run db:check`.\n");
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
