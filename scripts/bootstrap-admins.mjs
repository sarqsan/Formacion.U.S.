#!/usr/bin/env node
/**
 * ALTA DE ADMINISTRADORES INICIALES
 * =================================
 *
 * Uso:
 *   node scripts/bootstrap-admins.mjs --dry-run
 *   BOOTSTRAP_CONFIRM=yes node scripts/bootstrap-admins.mjs
 *
 * Requisitos:
 *   - Variables FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *     (o emulador con FIREBASE_AUTH_EMULATOR_HOST).
 *   - BOOTSTRAP_ADMIN_USERNAMES="rol1.apellido,rol1.otro"
 *   - AUTH_EMAIL_DOMAIN y NEXT_PUBLIC_AUTH_EMAIL_DOMAIN con el mismo valor.
 *
 * Qué hace:
 *   1. Comprueba credenciales, confirmación explícita y que los dos dominios de
 *      correo coinciden (si no, el usuario existiría pero el login no podría
 *      entrar: ver `checkEmailDomains` en scripts/lib/bootstrap-admin-core.mjs).
 *   2. Calcula el plan (crear/omitir) sin escribir nada.
 *   3. Crea cada administrador como cuenta `pending_activation` con token de
 *      activación de un solo uso (igual que la importación): nunca hay
 *      contraseñas compartidas ni cuentas con contraseña conocida.
 *   4. **Imprime los códigos** (una vez) y **después** escribe la auditoría, de
 *      modo que un fallo de auditoría no pueda dejar códigos sin entregar.
 *   5. Si algo falla a mitad, limpia lo creado e informa de lo que no pudo
 *      limpiar y de lo que sigue existiendo.
 *
 * Los códigos solo salen por la salida estándar. No se escriben en ficheros ni
 * en Firestore (allí solo el SHA-256), y no se registran en logs.
 *
 * La lógica probada está en `scripts/lib/bootstrap-admin-core.mjs`; las pruebas
 * de los caminos de fallo, en `tests/server/bootstrap-admins.test.ts`.
 */

import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

import {
  MAX_BOOTSTRAP_ADMINS,
  checkEmailDomains,
  parseAdminList,
  planAdminUsernames,
  runBootstrap,
  writeBootstrapAudit,
} from "./lib/bootstrap-admin-core.mjs";

const dryRun = process.argv.includes("--dry-run");
const confirmed = process.env.BOOTSTRAP_CONFIRM === "yes";
const usingEmulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
const hasCredentials = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY,
);

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!hasCredentials && !usingEmulator) {
  fail("Faltan credenciales de Firebase Admin (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
}

const requested = parseAdminList(process.env.BOOTSTRAP_ADMIN_USERNAMES);
if (requested.length === 0) fail("Define BOOTSTRAP_ADMIN_USERNAMES con al menos un usuario.");
if (requested.length > MAX_BOOTSTRAP_ADMINS) {
  fail(`Como máximo ${MAX_BOOTSTRAP_ADMINS} administradores por ejecución.`);
}

const { create, invalid } = planAdminUsernames(requested);
if (invalid.length > 0) {
  console.error("Usuarios no válidos (se ignoran):");
  for (const item of invalid) console.error(`  - ${item.username}: ${item.reason}`);
}

if (!dryRun && !confirmed) {
  fail("Simula primero con --dry-run y después ejecuta con BOOTSTRAP_CONFIRM=yes.");
}

// -------------------------------------------------------------------------
// Dominio de correo: antes de permitir el alta.
// -------------------------------------------------------------------------
const emailDomains = checkEmailDomains(process.env);

if (!emailDomains.ok && !dryRun) {
  fail(`Dominio de correo interno incoherente: ${emailDomains.reason}`);
}

const app =
  getApps().length > 0
    ? getApps()[0]
    : usingEmulator
      ? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || "demo-formacion" })
      : initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID,
          credential: hasCredentials
            ? cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
              })
            : applicationDefault(),
        });

const auth = getAuth(app);
const db = getFirestore(app);
const deps = { db, auth, emailDomain: emailDomains.server };

function describeCleanup(cleanup) {
  if (!cleanup) return;
  const { cleaned = [], failed = [], residual = [] } = cleanup;
  if (cleaned.length > 0) console.error(`    limpiado:      ${cleaned.join(", ")}`);
  for (const item of failed) {
    console.error(`    ✖ no se pudo borrar: ${item.resource} → ${item.error}`);
  }
  for (const item of residual) {
    console.error(`    ⚠ queda en el sistema: ${item.resource} (${item.state})`);
  }
  if (failed.length === 0 && residual.length === 0) {
    console.error("    estado residual: ninguno");
  }
}

async function main() {
  console.log(`\nModo: ${dryRun ? "SIMULACIÓN (no escribe)" : "APLICAR CAMBIOS"}`);
  console.log(`Emulador: ${usingEmulator ? "sí" : "no"}`);
  console.log(`Dominio de correo: ${emailDomains.server} (cliente: ${emailDomains.client})`);
  if (!emailDomains.ok) {
    console.error(`\n⚠ ${emailDomains.reason}`);
    if (dryRun) console.error("  En modo simulación se avisa; la ejecución real se negaría a empezar.\n");
  }

  // Lectura previa: solo documentos de reserva, sin escrituras.
  const existing = new Set();
  for (const username of create) {
    const doc = await db.collection("usernames").doc(username).get();
    if (doc.exists) existing.add(username);
  }

  const toCreate = create.filter((username) => !existing.has(username));

  console.log("Plan:");
  console.log(`  crear:        ${toCreate.length}${toCreate.length ? ` → ${toCreate.join(", ")}` : ""}`);
  console.log(`  ya existen:   ${existing.size}${existing.size ? ` → ${[...existing].join(", ")}` : ""}`);
  console.log(`  inválidos:    ${invalid.length}\n`);

  if (dryRun || toCreate.length === 0) {
    console.log(dryRun ? "Simulación terminada. No se ha creado nada." : "Nada que hacer.");
    return 0;
  }

  const report = await runBootstrap({
    usernames: toCreate,
    existing,
    deps,
    onEvent: (event) => {
      if (event.type === "created") {
        console.error(`✔ ${event.username}: cuenta creada en estado pending_activation.`);
      } else if (event.type === "skipped") {
        console.error(`• ${event.username}: omitido (${event.reason}).`);
      } else {
        console.error(`✖ ${event.username}: fallo en «${event.stage}» → ${event.error}`);
      }
    },
  });

  // -----------------------------------------------------------------------
  // 1) Códigos ANTES de cualquier escritura posterior.
  //    Si el proceso muere justo después de imprimirlos, los titulares ya los
  //    tienen; si muriera antes, no se habría escrito la auditoría pero
  //    tampoco se habría entregado nada.
  // -----------------------------------------------------------------------
  if (report.created.length > 0) {
    console.log("\nCódigos de activación (se muestran UNA vez, no se guardan):\n");
    for (const item of report.created) {
      console.log(`  ${item.username};${item.token}`);
    }
    console.log(`\nCaducan el ${report.expiresAt}. Entrega cada código a su titular por un canal interno.\n`);
  }

  // -----------------------------------------------------------------------
  // 2) Auditoría, ya con los códigos entregados. Un fallo aquí NO pierde
  //    códigos: se informa y la ejecución termina en error para que no pase
  //    inadvertido.
  // -----------------------------------------------------------------------
  let auditError = null;
  try {
    await writeBootstrapAudit({ deps, report, at: new Date().toISOString() });
  } catch (error) {
    auditError = error instanceof Error ? error.message : String(error);
    console.error(`\n✖ La auditoría no se pudo escribir: ${auditError}`);
    console.error(
      "  Los códigos de arriba SÍ son válidos y ya se han mostrado; lo único que falta " +
        "es el registro `audits/bootstrap_admins`. Anótalo a mano o vuelve a ejecutar " +
        "cuando se resuelva el permiso (la reserva impide duplicar cuentas).",
    );
  }

  // -----------------------------------------------------------------------
  // 3) Resumen y estado residual.
  // -----------------------------------------------------------------------
  console.log("\nResumen:");
  console.log(`  creados:  ${report.created.length}${report.created.length ? ` → ${report.created.map((i) => i.username).join(", ")}` : ""}`);
  console.log(`  omitidos: ${report.skipped.length}${report.skipped.length ? ` → ${report.skipped.map((i) => i.username).join(", ")}` : ""}`);
  console.log(`  fallidos: ${report.failed.length}${report.failed.length ? ` → ${report.failed.map((i) => i.username).join(", ")}` : ""}`);

  let residualCount = 0;
  for (const item of report.failed) {
    console.error(`\n✖ ${item.username} (etapa «${item.stage}»): ${item.error}`);
    describeCleanup(item.cleanup);
    residualCount += (item.cleanup?.residual?.length ?? 0) + (item.cleanup?.failed?.length ?? 0);
  }

  if (residualCount > 0) {
    console.error(
      "\n⚠ Hay recursos sin limpiar. Revisa a mano los elementos marcados antes de reintentar; " +
        "un `activationTokens` que sobreviva es un código válido hasta su caducidad.\n",
    );
  }

  if (report.failed.length > 0 || residualCount > 0 || auditError) {
    console.error("\nLa ejecución NO se completó limpiamente.\n");
    return 1;
  }

  console.log("");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("\n✖ Error inesperado:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
