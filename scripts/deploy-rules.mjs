#!/usr/bin/env node
/**
 * PUBLICAR LAS REGLAS DE FIRESTORE (CON PERMISO Y CON PRUEBAS)
 * ===========================================================
 *
 *   npm run rules:deploy -- --dry-run     # enseña el plan, no publica
 *   npm run rules:deploy -- --yes         # ejecuta las pruebas y publica
 *
 * Por qué existe: la política del proyecto dice que no se publican reglas sin
 * probarlas, y `firebase deploy` a mano no lo comprueba. Este script:
 *
 *   1. lanza `npm run test:rules` (57 pruebas contra el emulador);
 *   2. si el resultado es BLOCKED —no había emulador, no se probó nada— o
 *      FAILED, **no publica** y dice qué falta;
 *   3. si es PASSED y hay `--yes` y el proyecto es el esperado, publica
 *      `firestore.rules` y nada más.
 *
 * Nunca publica índices, ni borra colecciones, ni toca datos. No usa claves de
 * servicio del proyecto: `firebase` pedirá el inicio de sesión que ya uses.
 *
 * Salida: 0 si se publicó o si el plan es correcto en simulación; 3 si se niega.
 */

import { spawn } from "node:child_process";
import {
  RULES_DEPLOY_EXIT,
  classifyRulesTestExit,
  decideRulesDeploy,
  EXPECTED_RULES_PROJECT,
} from "./lib/rules-deploy-core.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirm = args.has("--yes");

console.log("\nPUBLICAR REGLAS DE FIRESTORE");
console.log("============================\n");

let testExitCode = null;

if (dryRun) {
  console.log("Simulación: no se ejecutan las pruebas ni se publica nada.\n");
} else if (confirm) {
  console.log("▶ Ejecutando las pruebas de reglas contra el emulador…\n");
  testExitCode = await runTests();
  const verdict = classifyRulesTestExit(testExitCode);
  console.log(`\nResultado de las pruebas: ${verdict} (código ${testExitCode}).\n`);
} else {
  console.log("Sin --yes no se ejecuta nada todavía; se muestra la decisión.\n");
}

const decision = decideRulesDeploy({
  testExitCode,
  projectId: process.env.FIREBASE_PROJECT_ID ?? EXPECTED_RULES_PROJECT,
  confirm,
  dryRun,
});

for (const step of decision.steps) console.log(`✔ ${step}`);
for (const blocker of decision.blockers) console.log(`✖ ${blocker}`);

if (!decision.allowed) {
  console.log("\nNO SE HA PUBLICADO NADA.\n");
  process.exit(decision.exitCode);
}

if (dryRun) {
  console.log("\nPlan correcto. Nada publicado (simulación).\n");
  process.exit(RULES_DEPLOY_EXIT.READY);
}

console.log("\n▶ firebase deploy --only firestore:rules\n");
const code = await run("npx firebase deploy --only firestore:rules");
process.exit(code);

function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function runTests() {
  return run("npm run test:rules");
}
