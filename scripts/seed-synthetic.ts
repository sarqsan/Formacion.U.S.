#!/usr/bin/env node
/**
 * DATOS SINTÉTICOS PARA EL EMULADOR
 * =================================
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_PROJECT_ID=demo-formacion \
 *   npm run seed:synthetic -- --reset
 *
 * Escribe un conjunto **inventado** de documentos (nombres como «Alumno
 * Sintético», correo `sintetico1@example.invalid`) en el emulador.
 *
 * Salvaguardas:
 *   · se niega a ejecutarse sin `FIRESTORE_EMULATOR_HOST` (nunca contra un
 *     proyecto real);
 *   · se niega con `NODE_ENV=production`;
 *   · `--reset` borra solo las colecciones que conoce el esquema, y solo en el
 *     emulador.
 */

import { getFirestore } from "firebase-admin/firestore";
import { initializeApp, getApps } from "firebase-admin/app";
import { SYNTHETIC_DOCUMENTS, resetEmulatorCollections } from "./lib/synthetic-data";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  fail(
    "Esto escribe datos de prueba: exige FIRESTORE_EMULATOR_HOST. Nunca se ejecuta contra un proyecto real.",
  );
}
if (process.env.NODE_ENV === "production") {
  fail("No se siembran datos sintéticos con NODE_ENV=production.");
}

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId) fail("Falta FIREBASE_PROJECT_ID (por ejemplo demo-formacion).");

const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);

async function seed(): Promise<void> {
  let batch = db.batch();
  let count = 0;

  for (const document of SYNTHETIC_DOCUMENTS) {
    batch.set(db.doc(document.path), document.data);
    count += 1;
    if (count % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  await batch.commit();
}

async function main(): Promise<void> {
  console.log("\n=== Datos sintéticos para el emulador ===");
  console.log(`Emulador: ${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`Proyecto: ${projectId}`);

  if (process.argv.includes("--reset")) {
    const removed = await resetEmulatorCollections(db);
    console.log(`· Borrados ${removed} documentos previos del emulador.`);
  }

  await seed();
  console.log(`· Escritos ${SYNTHETIC_DOCUMENTS.length} documentos sintéticos.`);
  console.log("\n✓ Listo. Ningún dato real.\n");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
