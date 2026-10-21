#!/usr/bin/env node
/**
 * INICIALIZACIÓN DE LA BASE DE DATOS
 * ==================================
 *
 *   npm run db:init                 # simulación: muestra qué haría (por defecto)
 *   npm run db:init -- --apply      # aplica cambios
 *
 * Requiere `DB_INIT_CONFIRM=yes` para aplicar, igual que el script de
 * administradores: así no se escribe nada por accidente.
 *
 * Qué hace (idempotente):
 *   - comprueba conectividad y detecta si es emulador;
 *   - se niega a escribir en un proyecto real sin `DB_ALLOW_PROD=yes`;
 *   - crea/actualiza `meta/schema` con la versión del esquema y la lista de
 *     colecciones previstas;
 *   - NO crea colecciones vacías (Firestore no las necesita) ni contenido de
 *     ejemplo: los cursos los publica administración con contenido real.
 *
 * No se ejecuta en esta fase: no hay proyecto Firebase conectado.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  META_DOC,
  ROOT_COLLECTIONS,
  SCHEMA_VERSION,
} from "../src/server/db/schema.constants";

const apply = process.argv.includes("--apply");
const confirmed = process.env.DB_INIT_CONFIRM === "yes";
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const allowProd = process.env.DB_ALLOW_PROD === "yes";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function buildApp() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) fail("Falta FIREBASE_PROJECT_ID.");

  if (getApps().length > 0) return getApps()[0];

  if (emulatorHost) {
    return initializeApp({ projectId });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    fail("Faltan FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.");
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

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const isEmulator = Boolean(emulatorHost);

  console.log("\n=== Inicialización de la base de datos de Formación ===");
  console.log(`Proyecto:   ${projectId ?? "(sin definir)"}`);
  console.log(`Modo:       ${isEmulator ? `emulador (${emulatorHost})` : "Firebase real"}`);
  console.log(`Acción:     ${apply ? "APLICAR" : "SIMULACIÓN (no escribe)"}`);
  console.log(`Esquema:    v${SCHEMA_VERSION}\n`);

  if (apply && !confirmed) {
    fail("Para aplicar cambios ejecuta con DB_INIT_CONFIRM=yes.");
  }

  if (apply && !isEmulator && !allowProd) {
    fail(
      "Esto escribiría en un proyecto Firebase real. Si es intencionado, añade DB_ALLOW_PROD=yes.",
    );
  }

  const app = buildApp();
  const db = getFirestore(app);

  // 1. Conectividad real (no basta con tener variables definidas).
  try {
    await db.doc(`${META_DOC.collection}/${META_DOC.id}`).get();
  } catch (error) {
    fail(
      `No se puede hablar con Firestore: ${error instanceof Error ? error.message.split("\n")[0] : "error desconocido"}`,
    );
  }
  console.log("✓ Conectividad con Firestore comprobada.");

  // 2. Estado actual del esquema.
  const metaRef = db.doc(`${META_DOC.collection}/${META_DOC.id}`);
  const metaSnap = await metaRef.get();
  const current = metaSnap.exists
    ? (metaSnap.data() as { schemaVersion?: number })
    : null;

  if (!current) {
    console.log("· No existe meta/schema: se creará.");
  } else if (typeof current.schemaVersion !== "number") {
    fail("meta/schema existe pero no tiene schemaVersion numérico. Revisión manual necesaria.");
  } else if (current.schemaVersion > SCHEMA_VERSION) {
    fail(
      `La base de datos tiene el esquema v${current.schemaVersion} y este código v${SCHEMA_VERSION}. Actualiza la aplicación en lugar de degradar el esquema.`,
    );
  } else {
    console.log(`· meta/schema ya existe en v${current.schemaVersion}.`);
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    app: "formacion-us",
    collections: ROOT_COLLECTIONS,
    updatedAt: new Date().toISOString(),
    ...(current ? {} : { initializedAt: new Date().toISOString() }),
  };

  console.log("\nDocumento que se escribiría en meta/schema:");
  console.log(JSON.stringify(payload, null, 2));

  console.log("\nColecciones previstas (se crean al escribir el primer documento):");
  for (const collection of ROOT_COLLECTIONS) {
    const snapshot = await db.collection(collection).limit(1).get().catch(() => null);
    const state = snapshot === null ? "sin comprobar" : snapshot.empty ? "vacía" : "con datos";
    console.log(`  - ${collection}: ${state}`);
  }

  if (!apply) {
    console.log("\nSimulación terminada. No se ha escrito nada.");
    console.log("Para aplicar:  DB_INIT_CONFIRM=yes npm run db:init -- --apply\n");
    return;
  }

  await metaRef.set(payload, { merge: true });
  console.log("\n✓ meta/schema escrito.");

  // Contador de cuota de PDF. Solo se crea si no existe: sobrescribirlo a 0
  // haría que la siguiente subida ignorase lo ya almacenado.
  const storageRef = db.doc(`${META_DOC.collection}/storage`);
  const storageSnap = await storageRef.get();
  if (storageSnap.exists) {
    console.log(`· meta/storage ya existe (usedBytes=${storageSnap.data()?.usedBytes ?? 0}).`);
  } else {
    await storageRef.set({ usedBytes: 0, initializedAt: new Date().toISOString() });
    console.log("✓ meta/storage creado con usedBytes=0.");
  }
  console.log("Siguiente paso:  npm run db:check\n");
}

main().catch((error) => {
  console.error("\n✖ Error inesperado:", error instanceof Error ? error.message : error);
  process.exit(1);
});
