/**
 * PUBLICAR LAS REGLAS DE FIRESTORE: LA DECISIÓN
 * =============================================
 *
 * La política del proyecto es explícita: **no se publican reglas que no hayan
 * pasado sus pruebas**. Hasta ahora eso era una frase en la documentación y
 * dependía de que alguien se acordara; con `firebase deploy` a mano, el despliegue
 * sale igual aunque las pruebas estén BLOCKED (es decir, aunque no se haya
 * probado nada).
 *
 * Este módulo decide si se puede publicar, y dice exactamente por qué no. Es puro
 * (sin red, sin ficheros, sin proceso): el script que lo usa solo ejecuta la
 * orden al final, y las pruebas comprueban la matriz de decisión.
 *
 * Reglas, en orden:
 *   1. Hace falta `--yes`: publicar reglas cambia el acceso a los datos de todo
 *      el mundo y no debe ocurrir por un `npm run` distraído.
 *   2. Las pruebas de reglas deben haber terminado en PASSED (código 0). Si
 *      están BLOCKED (no hay emulador) o FAILED, no se publica.
 *   3. Hay que saber a qué proyecto se publica, y debe ser el esperado: un
 *      `FIREBASE_PROJECT_ID` de otro proyecto publicaría las reglas en el sitio
 *      equivocado.
 *   4. `--dry-run` enseña el plan y no publica nada.
 */

export const RULES_DEPLOY_EXIT = {
  /** Se puede publicar (o el plan es correcto en dry-run). */
  READY: 0,
  /** No se publica: falta un requisito. */
  REFUSED: 3,
};

export const EXPECTED_RULES_PROJECT = "formacionus-63555";

/**
 * @param {{
 *   testExitCode: number | null,
 *   projectId?: string | null,
 *   expectedProject?: string,
 *   confirm?: boolean,
 *   dryRun?: boolean,
 * }} input
 * @returns {{ allowed: boolean, exitCode: number, steps: string[], blockers: string[] }}
 */
export function decideRulesDeploy(input) {
  const expectedProject = input.expectedProject ?? EXPECTED_RULES_PROJECT;
  const steps = [];
  const blockers = [];

  // En simulación no hace falta `--yes`: no se publica nada. En cambio, para
  // publicar de verdad sí, porque cambia el acceso a los datos de todos.
  if (!input.dryRun && !input.confirm) {
    blockers.push(
      "Falta confirmación explícita: vuelve a ejecutar con --yes. Publicar reglas cambia el acceso a los datos de toda la aplicación.",
    );
  }

  if (input.dryRun) {
    steps.push(
      "Simulación: se ejecutarían las pruebas de reglas y, solo si pasan, se publicaría firestore.rules. No se ejecuta ni se publica nada.",
    );
  } else if (input.testExitCode === null || input.testExitCode === undefined) {
    blockers.push("No se han ejecutado las pruebas de reglas: no hay resultado que valga.");
  } else if (input.testExitCode === 2) {
    blockers.push(
      "Las pruebas de reglas están BLOCKED (no hay emulador): no se ha probado nada, así que no se publica.",
    );
  } else if (input.testExitCode !== 0) {
    blockers.push(
      `Las pruebas de reglas han fallado (código ${input.testExitCode}): publicar ahora dejaría la base con reglas sin probar.`,
    );
  } else {
    steps.push("Pruebas de reglas: PASSED.");
  }

  const projectId = (input.projectId ?? "").trim();
  if (!projectId) {
    blockers.push("Falta FIREBASE_PROJECT_ID: no se sabe en qué proyecto se publicaría.");
  } else if (projectId !== expectedProject) {
    blockers.push(
      `El proyecto configurado es «${projectId}» y el esperado «${expectedProject}». No se publica en un proyecto distinto.`,
    );
  } else {
    steps.push(`Proyecto: ${expectedProject}.`);
  }

  if (blockers.length === 0 && !input.dryRun) {
    steps.push("Se publicará firestore.rules con `firebase deploy --only firestore:rules`.");
  }

  return {
    allowed: blockers.length === 0,
    exitCode: blockers.length === 0 ? RULES_DEPLOY_EXIT.READY : RULES_DEPLOY_EXIT.REFUSED,
    steps,
    blockers,
  };
}

/**
 * Traduce el código de salida de `npm run test:rules` a la decisión.
 *
 * `run-emulator-checks.mjs` devuelve 0 PASSED, 1 FAILED y 2 BLOCKED; se mantiene
 * la distinción porque «no se ha probado» no es lo mismo que «está roto».
 */
export function classifyRulesTestExit(code) {
  if (code === 0) return "PASSED";
  if (code === 2) return "BLOCKED";
  if (code === null || code === undefined) return "NOT_RUN";
  return "FAILED";
}
