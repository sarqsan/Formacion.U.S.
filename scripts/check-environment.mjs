#!/usr/bin/env node
/**
 * COMPROBACIÓN DEL ENTORNO
 * ========================
 *
 *   npm run check:env
 *   npm run check:env -- --json
 *
 * Separa tres estados para no confundir "no se ha podido" con "ha fallado":
 *
 *   PASSED   todo lo necesario está disponible.
 *   FAILED   falta algo instalable en esta máquina (Node, Java, dependencias…).
 *   BLOCKED  falta algo que no depende de la máquina (emulador sin descargar,
 *            sin red hacia storage.googleapis.com).
 *
 * Código de salida: 0 PASSED · 1 FAILED · 2 BLOCKED.
 */

import { checkEnvironment, exitCodeFor, printReport } from "./lib/env-checks.mjs";

const json = process.argv.includes("--json");

const result = await checkEnvironment();
printReport(result, { json });

process.exit(exitCodeFor(result.status));
