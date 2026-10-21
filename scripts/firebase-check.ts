#!/usr/bin/env node
/**
 * COMPROBACIÓN DE LA CONEXIÓN CON FIREBASE
 * ========================================
 *
 *   npm run check:firebase
 *   npm run check:firebase -- --json
 *   npm run check:firebase -- --timeout=15000
 *   npm run check:web                (equivale a --config-only: sin red)
 *
 * Responde a una sola pregunta: **¿puede este proceso hablar con el proyecto
 * Firebase `formacionus-63555` y leer su Firestore?**
 *
 * SOLO LECTURA. Este script no escribe:
 *
 *   · no crea, modifica ni borra documentos (no aparecen `.set`, `.add`,
 *     `.update`, `.delete`, `.create`, lotes ni transacciones);
 *   · no crea usuarios ni cambia claims (`listUsers` solo lee);
 *   · no publica reglas, ni índices, ni ejecuta `db:init`, ni despliega nada.
 *
 * Comprobado además por `tests/server/firebase-check.test.ts`, que lee este
 * fichero y falla si alguien introduce una operación de escritura.
 *
 * Qué hace:
 *   1. valida las variables (sin imprimir valores secretos) y la forma de la
 *      configuración pública del SDK web (`checkPublicFirebaseConfig`);
 *   2. comprueba que la clave privada sea un PEM utilizable;
 *   3. lee: `listCollections`, `meta/schema`, recuentos de colecciones y
 *      `listUsers(1)`.
 *
 * Código de salida:
 *   0  PASSED   configuración correcta y Firestore/Auth responden
 *   2  FAILED   falta configuración o es inválida
 *   3  BLOCKED  configuración presente pero el servicio no responde o la
 *               cuenta de servicio no tiene permiso de lectura
 */

import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnvFiles } from "../src/server/firebase/env-file";
import { checkPublicFirebaseConfig } from "../src/server/firebase/public-config";

const EXPECTED_PROJECT = "formacionus-63555";
const json = process.argv.includes("--json");

/**
 * `--config-only` valida **solo** la configuración web y no toca la red: sirve
 * para comprobar los cuatro valores recién pegados antes de que existan las
 * credenciales de servidor.
 */
const configOnly = process.argv.includes("--config-only");

// Next.js carga `.env.local` al arrancar; este script es un proceso aparte y
// tiene que hacerlo también, o diría «no configurado» con el fichero lleno.
const envFiles = loadEnvFiles(process.cwd());

/**
 * Las librerías de Google reintentan solas ante un error de red y pueden
 * quedarse minutos esperando. Un diagnóstico que no termina no sirve: cada
 * lectura lleva su propio plazo (10 s por defecto).
 */
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout="));
const TIMEOUT_MS = Number(timeoutArg?.split("=")[1] ?? 10_000);

type Status = "PASSED" | "FAILED" | "BLOCKED";

interface Result {
  id: string;
  title: string;
  status: Status;
  detail: string;
  fix?: string | null;
}

const results: Result[] = [];

function record(
  id: string,
  title: string,
  status: Status,
  detail: string,
  fix: string | null = null,
): void {
  results.push({ id, title, status, detail, fix });
}

function envValue(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

function normalizeKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guarded = promise.catch(() => undefined);
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        guarded.catch(() => undefined);
        reject(new Error(`tiempo de espera agotado (${label}, ${TIMEOUT_MS} ms)`));
      }, TIMEOUT_MS);
    }),
  ]);
}

function describeError(error: unknown): string {
  const candidate = error as { code?: string; message?: string; errorInfo?: { code?: string } };
  const code = candidate?.code ?? candidate?.errorInfo?.code ?? "";
  const message = candidate?.message ?? "error desconocido";
  return code ? `${code}: ${message}` : message;
}

// ---------------------------------------------------------------------------
// 1. Configuración (sin tocar la red)
// ---------------------------------------------------------------------------

const projectId = envValue("FIREBASE_PROJECT_ID");
const clientEmail = envValue("FIREBASE_CLIENT_EMAIL");
const privateKey = envValue("FIREBASE_PRIVATE_KEY");
const authEmulator = envValue("FIREBASE_AUTH_EMULATOR_HOST");
const firestoreEmulator = envValue("FIRESTORE_EMULATOR_HOST");
const usingEmulator = Boolean(authEmulator || firestoreEmulator);

if (!configOnly) {
  if (!projectId) {
    record(
      "project",
      "FIREBASE_PROJECT_ID",
      "FAILED",
      "No está definido.",
      `Define FIREBASE_PROJECT_ID=${EXPECTED_PROJECT} en .env.local (sin comillas).`,
    );
  } else if (projectId === EXPECTED_PROJECT) {
    record("project", "Proyecto de Firebase", "PASSED", `FIREBASE_PROJECT_ID=${projectId}`);
  } else {
    record(
      "project",
      "Proyecto de Firebase",
      "FAILED",
      `El proyecto configurado es «${projectId}» y el previsto es «${EXPECTED_PROJECT}».`,
      "No se reutiliza el Firebase de otra aplicación: corrige FIREBASE_PROJECT_ID.",
    );
  }

  if (!usingEmulator && (!clientEmail || !privateKey)) {
    record(
      "credentials",
      "Credenciales de la cuenta de servicio",
      "FAILED",
      "Faltan FIREBASE_CLIENT_EMAIL y/o FIREBASE_PRIVATE_KEY.",
      "Consola de Firebase → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada.",
    );
  } else if (usingEmulator) {
    record(
      "credentials",
      "Credenciales de la cuenta de servicio",
      "PASSED",
      `Modo emulador (${[authEmulator, firestoreEmulator].filter(Boolean).join(", ")}).`,
    );
  } else {
    record(
      "credentials",
      "Credenciales de la cuenta de servicio",
      "PASSED",
      `Cuenta de servicio presente (${clientEmail?.split("@")[1] ?? "dominio desconocido"}).`,
    );
  }

  if (privateKey && !usingEmulator) {
    try {
      createPrivateKey(normalizeKey(privateKey));
      record("key", "Clave privada legible", "PASSED", "PEM correcto (RSA).");
    } catch {
      record(
        "key",
        "Clave privada legible",
        "FAILED",
        "FIREBASE_PRIVATE_KEY no es un PEM válido.",
        'Pega la clave entre comillas dobles conservando los \\n: FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n…".',
      );
    }
  }
}

// Configuración pública del SDK web: forma de cada valor y coherencia entre
// cliente y servidor. No es secreta, pero un valor de otro proyecto rompe el
// inicio de sesión sin dar ninguna pista.
function checkEnvFileIgnored(): void {
  if (!existsSync(join(process.cwd(), ".env.local"))) {
    record("envfile", "Fichero .env.local", "PASSED", "Todavía no existe; no hay nada que proteger.");
    return;
  }

  try {
    execFileSync("git", ["check-ignore", "-q", ".env.local"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    record("envfile", "Fichero .env.local", "PASSED", "Existe y .gitignore lo excluye.");
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      record(
        "envfile",
        "Fichero .env.local",
        "FAILED",
        "Existe pero Git NO lo está ignorando: los valores podrían acabar en un commit.",
        "Comprueba las reglas `.env*` y `!.env.example` de .gitignore antes de seguir.",
      );
      return;
    }
    record(
      "envfile",
      "Fichero .env.local",
      "PASSED",
      "Existe; no se pudo preguntar a git (no disponible en este proceso).",
    );
  }
}

checkEnvFileIgnored();

const publicCheck = checkPublicFirebaseConfig(process.env);
for (const issue of publicCheck.issues) {
  record(issue.field, issue.field, issue.ok ? "PASSED" : "FAILED", issue.detail, issue.fix ?? null);
}

const configurationFailed = results.some((item) => item.status === "FAILED");

// ---------------------------------------------------------------------------
// 2. Conexión (solo lectura)
// ---------------------------------------------------------------------------

async function checkServices(): Promise<void> {
  if (getApps().length === 0) {
    initializeApp(
      usingEmulator
        ? { projectId: projectId ?? "demo-formacion" }
        : {
            credential: cert({
              projectId: projectId as string,
              clientEmail: clientEmail as string,
              privateKey: normalizeKey(privateKey as string),
            }),
            projectId: projectId as string,
          },
    );
  }

  const db = getFirestore();

  // `listCollections` es la lectura más barata: no recorre documentos.
  try {
    const collections = await withTimeout(db.listCollections(), "listCollections");
    const names = collections.map((collection) => collection.id).sort();
    record(
      "firestore",
      "Firestore responde",
      "PASSED",
      names.length === 0
        ? "La base existe y está vacía (aún no se ha inicializado el esquema)."
        : `Colecciones raíz: ${names.join(", ")}.`,
    );
  } catch (error) {
    record(
      "firestore",
      "Firestore responde",
      "BLOCKED",
      `No se pudo leer: ${describeError(error)}`,
      "Comprueba que Firestore está creado en modo nativo, base (default), y que la cuenta de servicio es del mismo proyecto.",
    );
    return;
  }

  const targets: Array<{ id: string; path: string[]; label: string }> = [
    { id: "schema", path: ["meta", "schema"], label: "meta/schema (versión del esquema)" },
    { id: "accounts", path: ["accounts"], label: "accounts (cuentas)" },
    { id: "courses", path: ["courses"], label: "courses (cursos)" },
    { id: "enrollments", path: ["enrollments"], label: "enrollments (matrículas)" },
    { id: "progress", path: ["progress"], label: "progress (progreso)" },
  ];

  for (const target of targets) {
    try {
      if (target.path.length === 1) {
        const snapshot = await withTimeout(
          db.collection(target.path[0]).count().get(),
          target.path[0],
        );
        record(target.id, target.label, "PASSED", `${snapshot.data().count} documentos.`);
      } else {
        const snapshot = await withTimeout(
          db.collection(target.path[0]).doc(target.path[1]).get(),
          target.path.join("/"),
        );
        record(
          target.id,
          target.label,
          snapshot.exists ? "PASSED" : "FAILED",
          snapshot.exists
            ? `Presente (versión ${String(snapshot.get("version") ?? "sin campo version")}).`
            : "No existe todavía: se crea al inicializar el esquema (paso 4 de docs/CONEXION-FIREBASE.md).",
        );
      }
    } catch (error) {
      record(target.id, target.label, "BLOCKED", `No se pudo leer: ${describeError(error)}`);
    }
  }

  try {
    const users = await withTimeout(getAuth().listUsers(1), "listUsers");
    record(
      "auth",
      "Firebase Authentication responde",
      "PASSED",
      users.users.length === 0
        ? "Responde, sin usuarios todavía."
        : `Responde; hay al menos ${users.users.length} usuario(s).`,
    );
  } catch (error) {
    record(
      "auth",
      "Firebase Authentication responde",
      "BLOCKED",
      `No se pudo consultar: ${describeError(error)}`,
      "Comprueba que Authentication está habilitado y que el proveedor Correo/contraseña está activo.",
    );
  }
}

function status(): Status {
  if (results.some((item) => item.status === "FAILED")) return "FAILED";
  if (results.some((item) => item.status === "BLOCKED")) return "BLOCKED";
  return "PASSED";
}

function exitCode(value: Status): number {
  if (value === "PASSED") return 0;
  if (value === "BLOCKED") return 3;
  return 2;
}

async function main(): Promise<void> {
  if (configurationFailed) {
    record(
      "connection",
      "Conexión con Firebase",
      "BLOCKED",
      "No se ha intentado: la configuración no es válida.",
    );
  } else if (configOnly) {
    // En modo configuración no se intenta conectar: eso es lo esperado, no un
    // problema. No se añade ningún resultado para no teñir el veredicto.
  } else {
    await checkServices();
  }

  const finalStatus = status();

  if (json) {
    console.log(
      JSON.stringify({ status: finalStatus, network: !configOnly, wrote: false, results }, null, 2),
    );
  } else {
    console.log(
      configOnly
        ? "\nConfiguración web de Firebase (SIN RED, SOLO LECTURA)\n"
        : "\nComprobación de conexión con Firebase (SOLO LECTURA)\n",
    );
    if (envFiles.loaded.length > 0) {
      console.log(`Valores cargados desde: ${envFiles.loaded.join(", ")}\n`);
    }
    for (const item of results) {
      const icon = item.status === "PASSED" ? "✓" : item.status === "FAILED" ? "✖" : "…";
      console.log(`${icon} ${item.title}: ${item.detail}`);
      if (item.fix && item.status !== "PASSED") console.log(`  → ${item.fix}`);
    }
    console.log(`\nRESULTADO: ${finalStatus}`);
    if (configOnly) {
      console.log("No se ha intentado conectar: esta comprobación no usa la red.");
    }
    console.log("No se ha escrito nada: esta comprobación no modifica datos.\n");
  }

  process.exit(exitCode(finalStatus));
}

main().catch((error: unknown) => {
  console.error("No se pudo completar la comprobación:", describeError(error));
  process.exit(1);
});
