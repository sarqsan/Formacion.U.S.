import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { accessSync, constants, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * COMPROBACIÓN DEL ENTORNO DE PRUEBAS
 * ==================================
 *
 * Un solo sitio para decidir si las pruebas que necesitan el emulador pueden
 * ejecutarse, y con qué estado:
 *
 *   PASSED   el requisito se cumple.
 *   FAILED   falta algo que se instala o arregla en la máquina (Node, Java,
 *            dependencias, CLI). Es un fallo del entorno, no un bloqueo externo.
 *   BLOCKED  el requisito no se puede cumplir desde aquí: el emulador no está
 *            descargado o no hay red hacia el servidor de descargas.
 *
 * Ninguna prueba debe "pasar" cuando falta el emulador: o se ejecuta de verdad
 * o el estado es BLOCKED/FAILED.
 */

export const MIN_NODE_MAJOR = 22;
export const MIN_JAVA_MAJOR = 17;
export const EMULATOR_FILE_PREFIX = "cloud-firestore-emulator";

function run(command, args, timeout = 20000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ? String(result.error.message) : null,
    notFound: result.error?.code === "ENOENT",
  };
}

function nodeCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "node",
    title: `Node.js ≥ ${MIN_NODE_MAJOR}`,
    status: major >= MIN_NODE_MAJOR ? "PASSED" : "FAILED",
    detail: `v${process.versions.node}`,
    fix:
      major >= MIN_NODE_MAJOR
        ? null
        : `Instala Node ${MIN_NODE_MAJOR} o superior (el proyecto usa Next 16 y Vitest 5).`,
  };
}

function dependenciesCheck() {
  const missing = [];
  for (const dependency of ["firebase-tools", "@firebase/rules-unit-testing", "vitest"]) {
    if (!existsSync(join(process.cwd(), "node_modules", dependency))) missing.push(dependency);
  }
  return {
    id: "deps",
    title: "Dependencias instaladas",
    status: missing.length === 0 ? "PASSED" : "FAILED",
    detail: missing.length === 0 ? "firebase-tools, rules-unit-testing, vitest" : `faltan: ${missing.join(", ")}`,
    fix: missing.length === 0 ? null : "Ejecuta `npm ci` (o `npm install`).",
  };
}

function javaCheck() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, "bin", "java"));
  candidates.push("java");

  for (const candidate of candidates) {
    const result = run(candidate, ["-version"]);
    if (result.notFound || (!result.ok && !result.stderr)) continue;

    const output = `${result.stderr}\n${result.stdout}`;
    const match = output.match(/version "?(\d+)(?:\.(\d+))?/);
    if (!match) continue;

    const major = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
    const version = output.split("\n")[0].trim();
    return {
      id: "java",
      title: `Java ≥ ${MIN_JAVA_MAJOR} (lo exige el emulador de Firestore)`,
      status: major >= MIN_JAVA_MAJOR ? "PASSED" : "FAILED",
      detail: version,
      fix:
        major >= MIN_JAVA_MAJOR
          ? null
          : `Instala un JDK ${MIN_JAVA_MAJOR}+ o superior y ponlo en PATH (o define JAVA_HOME).`,
    };
  }

  return {
    id: "java",
    title: `Java ≥ ${MIN_JAVA_MAJOR} (lo exige el emulador de Firestore)`,
    status: "FAILED",
    detail: "no se encuentra `java`",
    fix:
      "Instala un JDK (17, 21 o 25) y comprueba `java -version`. Alternativa sin instalar nada: `pip download jdk4py`, descomprime el wheel y añade `/…/jdk4py/java-runtime/bin` al PATH.",
  };
}

function firebaseCliCheck() {
  const local = join(process.cwd(), "node_modules", ".bin", "firebase");
  if (existsSync(local)) {
    const result = run(local, ["--version"]);
    return {
      id: "firebase-cli",
      title: "Firebase CLI",
      status: result.ok ? "PASSED" : "FAILED",
      detail: result.ok ? `local ${result.stdout}` : "no responde",
      fix: result.ok ? null : "Ejecuta `npm ci` para reinstalar firebase-tools.",
    };
  }

  const global = run("firebase", ["--version"]);
  if (global.ok) {
    return {
      id: "firebase-cli",
      title: "Firebase CLI",
      status: "PASSED",
      detail: `global ${global.stdout}`,
      fix: null,
    };
  }

  return {
    id: "firebase-cli",
    title: "Firebase CLI",
    status: "FAILED",
    detail: "no encontrada (ni local ni global)",
    fix: "Ejecuta `npm ci` (firebase-tools es dependencia de desarrollo).",
  };
}

function emulatorJarDirectories() {
  const directories = new Set();
  if (process.env.FIREBASE_EMULATORS_PATH) directories.add(process.env.FIREBASE_EMULATORS_PATH);
  directories.add(join(homedir(), ".cache", "firebase", "emulators"));
  return [...directories];
}

/**
 * Ficha oficial del emulador que espera el CLI instalado
 * (`firebase-tools/lib/emulator/downloadableEmulatorInfo.json`): versión,
 * tamaño y hashes. Es la referencia para decidir si una copia local sirve.
 */
export function expectedEmulator() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(
      here,
      "..",
      "..",
      "node_modules",
      "firebase-tools",
      "lib",
      "emulator",
      "downloadableEmulatorInfo.json",
    );
    const info = JSON.parse(readFileSync(file, "utf8"));
    const firestore = info.firestore;
    if (!firestore?.version) return null;
    return {
      version: firestore.version,
      fileName: `cloud-firestore-emulator-v${firestore.version}.jar`,
      expectedSize: Number(firestore.expectedSize),
      sha256: String(firestore.expectedChecksumSHA256 ?? ""),
      md5: String(firestore.expectedChecksum ?? ""),
      remoteUrl: String(firestore.remoteUrl ?? ""),
    };
  } catch {
    return null;
  }
}

/** SHA-256 de un fichero, en streaming: el jar pesa ~130 MB. */
function sha256Of(file) {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve(null));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Copia local del jar. No basta con que exista: se comprueba tamaño y SHA-256
 * contra la ficha del CLI. Un jar truncado o de otra versión no debe pasar por
 * bueno —ni presentarse como «el emulador funciona»—.
 */
async function checkJarFile(file, expected, origin) {
  const base = { id: "emulator-jar", title: "Emulador de Firestore (jar)" };

  if (!existsSync(file)) {
    return {
      ...base,
      status: "BLOCKED",
      detail: `${origin} apunta a un archivo que no existe (${file})`,
      fix: "Corrige o elimina esa ruta.",
    };
  }

  const size = statSync(file).size;
  if (!expected) {
    return {
      ...base,
      status: "FAILED",
      detail: `${file} (${(size / (1024 * 1024)).toFixed(1)} MB): no se puede leer la ficha del CLI, así que no se puede verificar`,
      fix: "Ejecuta `npm ci` para tener `firebase-tools` completo.",
    };
  }

  const name = file.split("/").at(-1) ?? file;
  if (name !== expected.fileName) {
    return {
      ...base,
      status: "FAILED",
      detail: `${file}: el CLI espera «${expected.fileName}» (v${expected.version})`,
      fix: `Renombra la copia a ${expected.fileName} o usa la versión que corresponde.`,
    };
  }

  if (size !== expected.expectedSize) {
    return {
      ...base,
      status: "FAILED",
      detail: `${file}: ${size} bytes, se esperaban ${expected.expectedSize} (copia incompleta o distinta)`,
      fix: "Sustituye el archivo por una copia íntegra; no se acepta una descarga truncada.",
    };
  }

  const digest = await sha256Of(file);
  if (!digest) {
    return {
      ...base,
      status: "FAILED",
      detail: `${file}: no se pudo calcular el SHA-256`,
      fix: "Comprueba permisos del archivo.",
    };
  }
  if (expected.sha256 && digest !== expected.sha256) {
    return {
      ...base,
      status: "FAILED",
      detail: `${file}: SHA-256 ${digest} ≠ ${expected.sha256} (no es el jar oficial)`,
      fix: "Borra el archivo: no es el emulador oficial aunque se llame igual.",
    };
  }

  return {
    ...base,
    status: "PASSED",
    detail: `${file} (${(size / (1024 * 1024)).toFixed(1)} MB, SHA-256 verificado)`,
    fix: null,
  };
}

async function emulatorJarCheck() {
  const expected = expectedEmulator();
  const override = process.env.FIRESTORE_EMULATOR_BINARY_PATH;
  if (override) return checkJarFile(override, expected, "FIRESTORE_EMULATOR_BINARY_PATH");

  for (const directory of emulatorJarDirectories()) {
    if (!existsSync(directory)) continue;
    const found = readdirSync(directory).filter(
      (file) => file.startsWith(EMULATOR_FILE_PREFIX) && file.endsWith(".jar"),
    );
    if (found.length > 0) {
      return checkJarFile(join(directory, found.sort().at(-1)), expected, directory);
    }
  }

  return {
    id: "emulator-jar",
    title: "Emulador de Firestore (jar)",
    status: "BLOCKED",
    detail: `no está en la caché de emuladores (se espera v${expected?.version ?? "?"})`,
    fix:
      `Con red hacia storage.googleapis.com, \`npm run test:rules\` lo descarga. Sin red, copia ${expected?.fileName ?? "cloud-firestore-emulator-vX.Y.Z.jar"} ` +
      `desde otra máquina a \`~/.cache/firebase/emulators/\` y compruébalo: \`sha256sum\` debe dar ${expected?.sha256 || "(hash desconocido)"} ` +
      `(el tamaño es ${expected?.expectedSize ?? "?"} bytes). \`npm run check:env\` lo verifica.`,
  };
}

function tcpProbe(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function emulatorRunningCheck() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    return {
      id: "emulator-running",
      title: "Emulador de Firestore en ejecución",
      status: "BLOCKED",
      detail: "FIRESTORE_EMULATOR_HOST no está definido",
      fix: "Las pruebas de integración lo arrancan solas con `npm run test:firestore`.",
    };
  }

  const [address, port] = host.split(":");
  const reachable = await tcpProbe(address, Number(port));
  return {
    id: "emulator-running",
    title: "Emulador de Firestore en ejecución",
    status: reachable ? "PASSED" : "BLOCKED",
    detail: `${host} ${reachable ? "acepta conexiones" : "no acepta conexiones"}`,
    fix: reachable ? null : "Arranca el emulador con `npm run emulators` o usa `npm run test:firestore`.",
  };
}

function backupsDirectoryCheck() {
  try {
    mkdirSync(join(process.cwd(), "backups"), { recursive: true });
    accessSync(join(process.cwd(), "backups"), constants.W_OK);
    return {
      id: "backups",
      title: "Directorio de copias escribible",
      status: "PASSED",
      detail: join(process.cwd(), "backups"),
      fix: null,
    };
  } catch {
    return {
      id: "backups",
      title: "Directorio de copias escribible",
      status: "FAILED",
      detail: "no se puede crear/escribir backups/",
      fix: "Revisa permisos del directorio del proyecto.",
    };
  }
}

function passphraseCheck() {
  const value = process.env.BACKUP_PASSPHRASE ?? "";
  return {
    id: "backup-passphrase",
    title: "BACKUP_PASSPHRASE definida (solo para copias)",
    status: value.length >= 12 ? "PASSED" : "BLOCKED",
    detail: value ? `${value.length} caracteres` : "no definida",
    fix: value ? null : "Solo hace falta para exportar/restaurar: `export BACKUP_PASSPHRASE='frase larga'`.",
    optional: true,
  };
}

export function summarize(checks) {
  const blocking = checks.filter((check) => !check.optional);
  if (blocking.some((check) => check.status === "FAILED")) return "FAILED";
  if (blocking.some((check) => check.status === "BLOCKED")) return "BLOCKED";
  return "PASSED";
}

export async function checkEnvironment() {
  const checks = [
    nodeCheck(),
    dependenciesCheck(),
    javaCheck(),
    firebaseCliCheck(),
    await emulatorJarCheck(),
    await emulatorRunningCheck(),
    backupsDirectoryCheck(),
    passphraseCheck(),
  ];

  return { status: summarize(checks), checks };
}

export function printReport({ status, checks }, options = {}) {
  const icon = { PASSED: "✓", FAILED: "✗", BLOCKED: "■" };

  if (options.json) {
    // A stdout solo JSON, para poder pipear sin filtrar el encabezado.
    console.log(JSON.stringify({ status, checks }, null, 2));
    return;
  }

  console.log("\nCOMPROBACIÓN DEL ENTORNO DE PRUEBAS\n");
  for (const check of checks) {
    const suffix = check.optional ? " (opcional)" : "";
    console.log(`${icon[check.status]} ${check.status.padEnd(7)} ${check.title}${suffix}`);
    console.log(`   ${check.detail}`);
    if (check.fix && check.status !== "PASSED") console.log(`   → ${check.fix}`);
  }

  console.log(`\nRESULTADO: ${status}`);
  if (status === "BLOCKED") {
    console.log("Hay requisitos que no se pueden cumplir desde este entorno (ver arriba).");
  }
  if (status === "FAILED") {
    console.log("Hay requisitos que faltan instalarse en esta máquina (ver arriba).");
  }
  if (options.json) console.log(`\n${JSON.stringify({ status, checks }, null, 2)}`);
  console.log("");
}

export function exitCodeFor(status) {
  if (status === "PASSED") return 0;
  if (status === "FAILED") return 1;
  return 2;
}
