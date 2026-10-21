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
 *
 * Qué hace:
 *   1. Comprueba credenciales y confirmación explícita.
 *   2. Calcula el plan (crear/omitir) sin escribir nada.
 *   3. Crea cada administrador como cuenta `pending_activation` con token de
 *      activación de un solo uso (igual que la importación): nunca hay
 *      contraseñas compartidas ni cuentas con contraseña conocida.
 *   4. Imprime los códigos UNA vez. No los guarda.
 *
 * La especificación probada de las reglas de este plan está en
 * src/server/admin/bootstrap-plan.ts (tests/server/bootstrap-plan.test.ts).
 * Este script es intencionadamente autónomo para poder ejecutarse con `node`
 * sin compilar TypeScript ni resolver alias.
 *
 * NO se ejecuta en esta fase: no hay proyecto Firebase conectado.
 */

import { createHash, randomBytes } from "node:crypto";
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const RESERVED = new Set(["admin", "root", "sistema", "system", "soporte", "seguridad"]);
const MAX_ADMINS = 20;
const TOKEN_TTL_HOURS = 72;

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

function parseList(raw) {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function plan(requested) {
  const create = [];
  const invalid = [];
  for (const username of requested) {
    if (username.length < 4 || username.length > 60) {
      invalid.push({ username, reason: "longitud no válida" });
      continue;
    }
    if (!USERNAME_PATTERN.test(username)) {
      invalid.push({ username, reason: "caracteres no válidos" });
      continue;
    }
    if (RESERVED.has(username)) {
      invalid.push({ username, reason: "nombre reservado" });
      continue;
    }
    create.push(username);
  }
  return { create, invalid };
}

if (!hasCredentials && !usingEmulator) {
  fail("Faltan credenciales de Firebase Admin (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
}

const requested = parseList(process.env.BOOTSTRAP_ADMIN_USERNAMES);
if (requested.length === 0) fail("Define BOOTSTRAP_ADMIN_USERNAMES con al menos un usuario.");
if (requested.length > MAX_ADMINS) fail(`Como máximo ${MAX_ADMINS} administradores por ejecución.`);

const { create, invalid } = plan(requested);
if (invalid.length > 0) {
  console.error("Usuarios no válidos (se ignoran):");
  for (const item of invalid) console.error(`  - ${item.username}: ${item.reason}`);
}

if (!dryRun && !confirmed) {
  fail("Simula primero con --dry-run y después ejecuta con BOOTSTRAP_CONFIRM=yes.");
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
const emailDomain = (process.env.AUTH_EMAIL_DOMAIN || "formacion.invalid").trim().toLowerCase();

function generateToken() {
  return randomBytes(32).toString("base64url");
}

async function main() {
  console.log(`\nModo: ${dryRun ? "SIMULACIÓN (no escribe)" : "APLICAR CAMBIOS"}`);
  console.log(`Emulador: ${usingEmulator ? "sí" : "no"}\n`);

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
    return;
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  const results = [];

  for (const username of toCreate) {
    const authEmail = `${username}@${emailDomain}`;

    const reservation = db.collection("usernames").doc(username);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservation);
      if (snapshot.exists) throw new Error(`El usuario ${username} ya existe.`);
      transaction.create(reservation, { uid: null, reservedAt: createdAt, reservedBy: "bootstrap" });
    });

    let uid = null;
    try {
      const user = await auth.createUser({
        email: authEmail,
        password: randomBytes(48).toString("base64url"),
        displayName: `${username} (administrador)`,
        disabled: false,
      });
      uid = user.uid;

      await auth.setCustomUserClaims(uid, {
        role: "admin",
        status: "pending_activation",
        claimsVersion: 1,
      });

      const token = generateToken();
      const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

      const batch = db.batch();
      batch.create(db.collection("accounts").doc(uid), {
        uid,
        username,
        authEmail,
        apellido: null,
        personRol: null,
        role: "admin",
        status: "pending_activation",
        claimsVersion: 1,
        createdAt,
        createdBy: "bootstrap-script",
        activatedAt: null,
        disabledAt: null,
      });
      batch.create(db.collection("activationTokens").doc(tokenHash), {
        uid,
        createdAt,
        expiresAt,
        usedAt: null,
        revokedAt: null,
      });
      batch.update(reservation, { uid });
      await batch.commit();

      results.push({ username, token, expiresAt });
    } catch (error) {
      if (uid) {
        await db.collection("accounts").doc(uid).delete().catch(() => {});
        await auth.deleteUser(uid).catch(() => {});
      }
      await reservation.delete().catch(() => {});
      console.error(`✖ ${username}: ${error instanceof Error ? error.message : "error"}`);
    }
  }

  await db.collection("audits").add({
    type: "bootstrap_admins",
    at: createdAt,
    actorUid: "bootstrap-script",
    usernames: results.map((item) => item.username),
    severity: "warning",
  });

  console.log("\nCódigos de activación (se muestran UNA vez, no se guardan):\n");
  for (const item of results) {
    console.log(`  ${item.username};${item.token}`);
  }
  console.log(`\nCaducan el ${expiresAt}. Entrega cada código a su titular por un canal interno.\n`);
}

main().catch((error) => {
  console.error("\n✖ Error inesperado:", error instanceof Error ? error.message : error);
  process.exit(1);
});
