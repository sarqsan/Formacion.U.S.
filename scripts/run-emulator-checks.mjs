#!/usr/bin/env node
/**
 * PRUEBAS QUE NECESITAN EL EMULADOR DE FIRESTORE
 * ==============================================
 *
 *   npm run test:rules       # 57 pruebas de reglas
 *   npm run test:firestore   # 9 pruebas de integración (transacción real y histórico)
 *   npm run test:emulator    # las dos cosas en la misma sesión del emulador
 *
 * Este envoltorio **nunca deja que una prueba se omita en silencio**:
 *
 *   · arranca el emulador con `firebase emulators:exec`;
 *   · exporta `REQUIRE_FIRESTORE_EMULATOR=1`, así que las pruebas de
 *     integración fallan de forma explícita si el emulador no está;
 *   · clasifica el resultado en PASSED / FAILED / BLOCKED y devuelve
 *     0 / 1 / 2 respectivamente.
 *
 * Diferencia que importa:
 *   FAILED   el emulador arrancó y las pruebas fallaron (hay un defecto real).
 *   BLOCKED  el emulador no pudo arrancar: no se ha probado nada.
 */

import { spawn } from "node:child_process";
import { checkEnvironment, exitCodeFor, printReport } from "./lib/env-checks.mjs";

const mode = process.argv[2] ?? "rules";
const PROJECT = process.env.FIREBASE_PROJECT_ID_FOR_TESTS ?? "demo-formacion";

const COMMANDS = {
  rules: 'vitest run --config vitest.rules.config.mts',
  firestore: "vitest run tests/integration",
  all: 'vitest run --config vitest.rules.config.mts && vitest run tests/integration',
};

if (!COMMANDS[mode]) {
  console.error(`\n✖ Modo no reconocido: ${mode}. Usa rules | firestore | all.\n`);
  process.exit(64);
}

/** Señales de bloqueo externo, no de fallo de las pruebas. */
const BLOCKED_PATTERNS = [
  "Failed to make request to https://storage.googleapis.com",
  "Could not spawn `java -version`",
  "Could not download",
  "ENOTFOUND",
  "ECONNRESET",
  "SSL_ERROR_SYSCALL",
  "Timed out waiting for the emulator",
  "Could not start Firestore Emulator",
  "BLOCKED:",
];

function classify(output, code) {
  if (code === 0) return "PASSED";
  const blocked = BLOCKED_PATTERNS.find((pattern) => output.includes(pattern));
  return blocked ? "BLOCKED" : "FAILED";
}

function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, REQUIRE_FIRESTORE_EMULATOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const forward = (chunk, stream) => {
      const text = chunk.toString();
      output += text;
      stream.write(text);
    };

    child.stdout.on("data", (chunk) => forward(chunk, process.stdout));
    child.stderr.on("data", (chunk) => forward(chunk, process.stderr));
    child.on("error", (error) => {
      output += String(error);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const environment = await checkEnvironment();
printReport(environment);

const fatal = environment.checks.filter(
  (check) => !check.optional && check.status === "FAILED" && check.id !== "emulator-running",
);
if (fatal.length > 0) {
  console.log("\nRESULTADO: FAILED (faltan requisitos locales; ver arriba)\n");
  process.exit(exitCodeFor("FAILED"));
}

const command = `npx firebase emulators:exec --only firestore --project ${PROJECT} "${COMMANDS[mode]}"`;
console.log(`\n▶ ${command}\n`);

const { code, output } = await run(command);
const status = classify(output, code);

console.log(`\nRESULTADO: ${status}`);
if (status === "BLOCKED") {
  console.log("El emulador no pudo arrancar: no se ha ejecutado ninguna prueba.");
  console.log("Requisitos y cómo obtener el jar: docs/ENTORNO-PRUEBAS.md");
} else if (status === "FAILED") {
  console.log("El emulador arrancó y hay pruebas que fallan: revisa la salida de arriba.");
} else {
  console.log("Todas las pruebas del modo solicitado han pasado.");
}
console.log("");

process.exit(exitCodeFor(status));
