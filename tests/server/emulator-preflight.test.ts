import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEnvironment, expectedEmulator } from "../../scripts/lib/env-checks.mjs";

/**
 * PREFLIGHT DEL EMULADOR: NO CUALQUIER ARCHIVO VALE
 * =================================================
 *
 * Las pruebas del motor de reglas solo valen si el jar es **el oficial**. Antes,
 * `check:env` daba por bueno cualquier fichero con el nombre correcto, así que
 * una descarga truncada o un jar de otra versión podían llegar a ejecutarse y
 * producir resultados que no significan nada.
 *
 * Estas pruebas cubren la puerta: nombre, tamaño y SHA-256 contra la ficha que
 * trae `firebase-tools`. No necesitan el emulador (el jar no está).
 */

interface Check {
  id: string;
  status: string;
  detail: string;
  fix?: string | null;
}

const originalPath = process.env.FIRESTORE_EMULATOR_BINARY_PATH;
const originalCache = process.env.FIREBASE_EMULATORS_PATH;
const temporaries: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "emulador-preflight-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  if (originalPath === undefined) delete process.env.FIRESTORE_EMULATOR_BINARY_PATH;
  else process.env.FIRESTORE_EMULATOR_BINARY_PATH = originalPath;
  if (originalCache === undefined) delete process.env.FIREBASE_EMULATORS_PATH;
  else process.env.FIREBASE_EMULATORS_PATH = originalCache;

  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function jarCheck(): Promise<Check> {
  const { checks } = await checkEnvironment();
  const found = (checks as Check[]).find((check) => check.id === "emulator-jar");
  if (!found) throw new Error("check:env no informa del jar");
  return found;
}

describe("ficha oficial del emulador", () => {
  it("sale de firebase-tools y trae versión, tamaño y SHA-256", () => {
    expect(expectedEmulator()).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      expectedSize: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("jar local", () => {
  it("un archivo con el nombre correcto pero truncado sale FAILED, no PASSED", async () => {
    const directory = tempDir();
    const file = join(directory, "cloud-firestore-emulator-v1.22.0.jar");
    writeFileSync(file, Buffer.alloc(1024));
    process.env.FIRESTORE_EMULATOR_BINARY_PATH = file;

    const check = await jarCheck();

    expect(check.status).toBe("FAILED");
    expect(check.detail).toContain("1024 bytes");
    expect(check.detail).toContain("se esperaban");
  });

  it("un jar con otro nombre no se acepta aunque exista", async () => {
    const directory = tempDir();
    const file = join(directory, "cloud-firestore-emulator-v1.0.0.jar");
    writeFileSync(file, Buffer.alloc(1024));
    process.env.FIRESTORE_EMULATOR_BINARY_PATH = file;

    const check = await jarCheck();

    expect(check.status).toBe("FAILED");
    expect(check.detail).toContain("cloud-firestore-emulator-v1.22.0.jar");
  });

  it("si la ruta configurada no existe, el estado es BLOCKED y se dice", async () => {
    process.env.FIRESTORE_EMULATOR_BINARY_PATH = join(tempDir(), "no-existe.jar");

    const check = await jarCheck();

    expect(check.status).toBe("BLOCKED");
    expect(check.detail).toContain("no existe");
  });

  it("sin caché ni ruta, BLOCKED con el hash exigido en el mensaje", async () => {
    delete process.env.FIRESTORE_EMULATOR_BINARY_PATH;
    process.env.FIREBASE_EMULATORS_PATH = tempDir();

    const check = await jarCheck();
    const expected = expectedEmulator();

    expect(check.status).toBe("BLOCKED");
    expect(check.detail).toContain("no está en la caché");
    expect(check.fix ?? "").toContain(String(expected?.expectedSize));
  });
});
