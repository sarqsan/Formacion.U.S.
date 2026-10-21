/**
 * LECTURA DE `.env.local` PARA LOS DIAGNÓSTICOS
 * =============================================
 *
 * Next.js carga `.env.local` por su cuenta al arrancar, pero los scripts de
 * diagnóstico (`npm run check:firebase`, `npm run check:web`) son procesos
 * aparte: sin esto, comprobarían un entorno vacío y dirían «no configurado»
 * aunque el fichero esté bien relleno.
 *
 * Reglas (las mismas que usa dotenv y que el usuario espera):
 *
 *   · `CLAVE=valor` en una línea; se ignoran líneas vacías y comentarios `#`;
 *   · se acepta el prefijo `export ` por costumbre de los ficheros de shell;
 *   · los valores entre comillas dobles admiten `\n` (necesario para la clave
 *     privada de Firebase) y `\"`; los valores entre comillas simples son
 *     literales;
 *   · en un valor sin comillas, un `#` precedido de espacio inicia un comentario;
 *   · **lo que ya existe en el entorno NO se sobrescribe**: una variable
 *     exportada en el proceso manda sobre el fichero, igual que en Next.js.
 *
 * Esta función **solo lee**. No escribe, no crea y no imprime valores.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type EnvRecord = Record<string, string | undefined>;

export interface EnvFileLoad {
  /** Ficheros que existen y se han aplicado, en orden. */
  loaded: string[];
  /** Ficheros que existen (aunque no hayan aportado ninguna clave nueva). */
  present: string[];
}

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();

  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1);
  }

  // Sin comillas: se corta en el primer ` #` (comentario al final de línea).
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = LINE.exec(trimmed);
    if (!match) continue;

    const [, key, raw] = match;
    values[key] = unquote(raw);
  }

  return values;
}

/**
 * Aplica `.env.local` y `.env` (en ese orden) sobre `env` sin sobrescribir lo
 * que ya estuviera definido. En este proyecto `.env.local` es el único sitio
 * previsto para valores reales; `.env` se admite por convención de Next.js.
 */
export function loadEnvFiles(
  dir: string,
  env: EnvRecord = process.env,
  files: readonly string[] = [".env.local", ".env"],
): EnvFileLoad {
  const loaded: string[] = [];
  const present: string[] = [];

  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    present.push(file);

    const values = parseEnvFile(readFileSync(path, "utf8"));
    let applied = false;

    for (const [key, value] of Object.entries(values)) {
      const current = env[key];
      if (current !== undefined && current !== "") continue;
      env[key] = value;
      applied = true;
    }

    if (applied) loaded.push(file);
  }

  return { loaded, present };
}
