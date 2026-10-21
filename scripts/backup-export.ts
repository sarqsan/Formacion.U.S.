#!/usr/bin/env node
/**
 * EXPORTACIÓN CIFRADA DE LA BASE DE DATOS
 * =======================================
 *
 *   BACKUP_PASSPHRASE='frase larga y secreta' npm run backup:export -- --out backups/2026-10-21.fbak
 *
 * Requiere credenciales de Firebase Admin en el entorno (o `FIRESTORE_EMULATOR_HOST`
 * para el emulador). La copia va cifrada con AES-256-GCM; la contraseña **no**
 * se guarda en el archivo, en el manifiesto ni en los logs.
 *
 * Al terminar imprime: ruta, tamaño, número de documentos por colección y la
 * huella del archivo. Esa huella (y la contraseña) son lo que hay que guardar
 * por separado.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256Hex } from "../src/server/backup/crypto";
import { exportBackup } from "../src/server/backup/export";
import { FirestoreBackupSource } from "../src/server/firebase/backup-store";
import { readFileSync } from "node:fs";

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
  const out = argument("--out");
  const isEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

  if (!out) fail("Indica el destino con --out (por ejemplo --out backups/copia.fbak).");
  if (!passphrase) fail("Define BACKUP_PASSPHRASE con una contraseña de al menos 12 caracteres.");

  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });

  console.log("\n=== Exportación de la base de datos de Formación ===");
  console.log(`Proyecto: ${process.env.FIREBASE_PROJECT_ID ?? "(sin definir)"}`);
  console.log(`Modo:     ${isEmulator ? `emulador (${process.env.FIRESTORE_EMULATOR_HOST})` : "Firebase real"}`);
  console.log(`Destino:  ${target}\n`);

  const db = getFirestore(buildApp());

  try {
    await db.listCollections();
  } catch (error) {
    fail(
      `No se puede hablar con Firestore: ${error instanceof Error ? error.message.split("\n")[0] : "error desconocido"}`,
    );
  }

  const result = await exportBackup({
    source: new FirestoreBackupSource(db),
    passphrase,
    outPath: target,
  });

  const digest = sha256Hex(readFileSync(target));

  console.log("Documentos exportados por colección:");
  for (const [name, count] of Object.entries(result.byCollection)) {
    console.log(`  · ${name.padEnd(28)} ${String(count).padStart(6)}`);
  }
  console.log(`\nTotal:      ${result.manifest.records} documentos`);
  console.log(`Tamaño:     ${(result.bytes / (1024 * 1024)).toFixed(2)} MiB`);
  console.log(`Esquema:    v${String(result.manifest.schemaVersion)}`);
  console.log(`Creado:     ${result.manifest.createdAt}`);
  console.log(`SHA-256:    ${digest}`);
  console.log("\nGuarda la contraseña y esta huella por separado del archivo.\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
