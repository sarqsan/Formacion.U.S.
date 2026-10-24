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

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

import {
  AUDIT_ACTOR,
  MAX_BOOTSTRAP_ADMINS,
  checkEmailDomains,
  normalizePrivateKey,
  parseAdminList,
  planAdminUsernames,
  reissueActivationCode,
  resetAccountPassword,
  resolveAdminCredentials,
  runBootstrap,
  writeBootstrapAudit,
} from "./lib/bootstrap-admin-core.mjs";

const dryRun = process.argv.includes("--dry-run");
const reissue = process.argv.includes("--reissue");
const resetFlag = process.argv.indexOf("--reset-password");
const resetUsername = resetFlag >= 0 ? process.argv[resetFlag + 1] : null;
const confirmed = process.env.BOOTSTRAP_CONFIRM === "yes";
const usingEmulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
let credentials = null;
try {
  credentials = resolveAdminCredentials(process.env);
} catch (error) {
  console.error(`\n✖ ${error.message}\n`);
  process.exit(1);
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!credentials && !usingEmulator) {
  fail(
    "Faltan credenciales de Firebase Admin. Dos formas válidas:\n" +
      "  · FIREBASE_SERVICE_ACCOUNT_FILE=/ruta/fuera/del/repo/cuenta.json\n" +
      "  · FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY",
  );
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

if (!dryRun && !confirmed && !reissue && !resetUsername) {
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
          projectId: credentials.projectId,
          credential: cert({
            projectId: credentials.projectId,
            clientEmail: credentials.clientEmail,
            privateKey: normalizePrivateKey(credentials.privateKey),
          }),
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

/**
 * Lee una contraseña sin mostrarla en pantalla.
 *
 * Si no hay terminal interactiva (por ejemplo, un script), se lee la primera
 * línea de la entrada estándar. En ese caso queda en el historial de quien la
 * escriba: el prompt interactivo existe justo para evitarlo.
 */
async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").split("\n")[0];
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let value = "";
  await new Promise((resolve) => {
    const onData = (char) => {
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve();
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });

  return value;
}

/**
 * Contraseña nueva para una cuenta ya activa. Es el único camino cuando el
 * titular la ha olvidado: no hay buzón que reciba un enlace de restablecimiento.
 *
 * Se pide dos veces (para no dejarla mal escrita) y no se muestra en pantalla.
 */
async function runResetPassword(username) {
  console.log("\nModo: CAMBIAR CONTRASEÑA (la anterior deja de funcionar)");
  console.log(`Usuario:  ${username}`);
  console.log("La contraseña no se muestra al escribirla y no se guarda en ningún sitio.\n");

  const first = await readSecret("Contraseña nueva: ");
  const second = await readSecret("Repite la contraseña: ");

  if (first !== second) {
    console.error("\n✖ Las dos contraseñas no coinciden. No se ha cambiado nada.\n");
    return 1;
  }

  const result = await resetAccountPassword({ username, newPassword: first, deps });

  if (result.status === "reset") {
    console.log(`✔ ${result.username}: contraseña cambiada.`);
    console.log("  Las sesiones abiertas de esa cuenta ya no valen: hay que entrar de nuevo.");
    if (result.auditWarning) {
      console.error(`  ⚠ No se pudo registrar la auditoría: ${result.auditWarning}`);
      console.error("    El cambio SÍ se aplicó.");
      return 1;
    }
    return 0;
  }

  if (result.status === "not_found") {
    console.error(`\n✖ No existe ninguna cuenta con el usuario «${result.username}».\n`);
    return 1;
  }
  if (result.status === "not_applicable") {
    console.error(`\n✖ ${result.username}: ${result.reason}.\n`);
    return 1;
  }
  if (result.status === "invalid_password") {
    console.error("\n✖ La contraseña no cumple la política; no se ha cambiado nada:");
    for (const issue of result.issues) console.error(`    · ${issue.message}`);
    console.error("");
    return 1;
  }

  console.error(`\n✖ Falló el cambio: ${result.error}`);
  console.error(`  Aplicado antes del fallo: ${result.applied.length > 0 ? result.applied.join(", ") : "nada"}.`);
  if (result.passwordChanged) {
    console.error("  ⚠ La contraseña NUEVA ya está activa aunque el resto fallara.");
  } else {
    console.error("  La contraseña anterior sigue funcionando.");
  }
  console.error("");
  return 1;
}

/**
 * Reemisión: un código nuevo para cuentas que siguen pendientes. Se usa cuando
 * el alta ya se ejecutó pero el código se perdió y no hay ningún administrador
 * activo que pueda entrar al panel a emitir otro.
 */
async function runReissue() {
  console.log("\nModo: REEMITIR CÓDIGOS (los anteriores dejan de servir)");
  console.log(`Emulador: ${usingEmulator ? "sí" : "no"}`);

  let failures = 0;
  const issued = [];

  for (const username of create) {
    const result = await reissueActivationCode({ username, deps });
    if (result.status === "reissued") {
      issued.push(result);
      console.error(`✔ ${username}: código nuevo (revocados ${result.revoked}).`);
    } else if (result.status === "not_found") {
      failures += 1;
      console.error(`✖ ${username}: no existe ninguna cuenta con ese usuario.`);
    } else {
      failures += 1;
      console.error(`✖ ${username}: ${result.reason}.`);
    }
  }

  if (issued.length > 0) {
    console.log("\nCódigos de activación (se muestran UNA vez, no se guardan):\n");
    for (const item of issued) {
      console.log(`  ${item.username};${item.token}`);
    }
    console.log(`\nCaducan el ${issued[0].expiresAt}.\n`);
    try {
      await db.collection("audits").add({
        type: "activation_reissued",
        at: new Date().toISOString(),
        actorUid: AUDIT_ACTOR,
        usernames: issued.map((item) => item.username),
        severity: "warning",
      });
    } catch (error) {
      console.error(`✖ La auditoría no se pudo escribir: ${error instanceof Error ? error.message : error}`);
      console.error("  Los códigos de arriba SÍ son válidos.");
      failures += 1;
    }
  }

  return failures > 0 ? 1 : 0;
}

async function main() {
  if (resetUsername !== null) {
    if (!resetUsername || resetUsername.startsWith("--")) {
      fail("Indica el usuario: npm run bootstrap -- --reset-password nombre.apellido");
    }
    const plan = planAdminUsernames([resetUsername]);
    if (plan.create.length !== 1) {
      console.error(`\n✖ Usuario no válido: ${plan.invalid[0]?.reason ?? "formato incorrecto"}.\n`);
      return 1;
    }
    return runResetPassword(plan.create[0]);
  }

  if (reissue) return runReissue();

  console.log(`\nModo: ${dryRun ? "SIMULACIÓN (no escribe)" : "APLICAR CAMBIOS"}`);
  console.log(`Emulador: ${usingEmulator ? "sí" : "no"}`);
  console.log(
    `Credenciales: ${
      credentials
        ? credentials.source === "file"
          ? "fichero de cuenta de servicio"
          : "variables de entorno"
        : "emulador"
    }`,
  );
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
