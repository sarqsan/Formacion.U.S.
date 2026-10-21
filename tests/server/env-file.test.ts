import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFiles, parseEnvFile } from "@/server/firebase/env-file";

/**
 * LECTURA DE `.env.local` SIN SORPRESAS
 * =====================================
 *
 * Los scripts de diagnóstico son procesos aparte: si no leen `.env.local` por
 * su cuenta, dirían «no configurado» con el fichero bien relleno. Estas pruebas
 * fijan el comportamiento que el usuario espera (el mismo de dotenv/Next):
 *
 *   · comentarios y líneas vacías fuera;
 *   · `export CLAVE=valor` aceptado;
 *   · valores entre comillas dobles con `\n` (la clave privada) y entre
 *     comillas simples literales;
 *   · un comentario al final de una línea sin comillas se descarta;
 *   · **lo exportado en el proceso manda**: el fichero no sobrescribe nada;
 *   · `.env.local` tiene prioridad sobre `.env`.
 *
 * Todo se hace sobre directorios temporales: **no se crea ningún `.env.local`
 * en el repositorio** y no se escribe ningún valor real.
 */

const temporary: string[] = [];

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "formacion-env-"));
  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseEnvFile", () => {
  it("lee pares clave=valor e ignora comentarios y líneas vacías", () => {
    const values = parseEnvFile(
      [
        "# cabecera",
        "",
        "FIREBASE_PROJECT_ID=formacionus-63555",
        "   ",
        "# NEXT_PUBLIC_FIREBASE_APP_ID=no-cuenta",
        "AUTH_EMAIL_DOMAIN=formacion.invalid",
      ].join("\n"),
    );

    expect(values).toEqual({
      FIREBASE_PROJECT_ID: "formacionus-63555",
      AUTH_EMAIL_DOMAIN: "formacion.invalid",
    });
  });

  it("acepta el prefijo export de los ficheros de shell", () => {
    expect(parseEnvFile("export CLAVE=valor")["CLAVE"]).toBe("valor");
  });

  it("interpreta \\n dentro de comillas dobles (clave privada)", () => {
    const values = parseEnvFile(
      'FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n"',
    );

    expect(values.FIREBASE_PRIVATE_KEY).toBe(
      "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
    );
  });

  it("respeta las comillas simples como texto literal", () => {
    expect(parseEnvFile("CLAVE='sin\\nescapar'")["CLAVE"]).toBe("sin\\nescapar");
  });

  it("quita comillas dobles sin escapar nada más", () => {
    expect(parseEnvFile('NEXT_PUBLIC_FIREBASE_API_KEY="AIzaSyEjemplo"')[
      "NEXT_PUBLIC_FIREBASE_API_KEY"
    ]).toBe("AIzaSyEjemplo");
  });

  it("descarta un comentario al final de un valor sin comillas", () => {
    expect(parseEnvFile("SESSION_TTL_HOURS=12 # horas")["SESSION_TTL_HOURS"]).toBe("12");
  });

  it("no confunde un # dentro de comillas con un comentario", () => {
    expect(parseEnvFile('ETIQUETA="a # b"')["ETIQUETA"]).toBe("a # b");
  });
});

describe("loadEnvFiles", () => {
  it("carga .env.local y no sobrescribe lo que ya está en el entorno", () => {
    const dir = workspace({
      ".env.local": "FIREBASE_PROJECT_ID=del-fichero\nOTRA=del-fichero\n",
    });
    const env: Record<string, string | undefined> = { FIREBASE_PROJECT_ID: "del-proceso" };

    const result = loadEnvFiles(dir, env);

    expect(env.FIREBASE_PROJECT_ID).toBe("del-proceso");
    expect(env.OTRA).toBe("del-fichero");
    expect(result.loaded).toEqual([".env.local"]);
    expect(result.present).toEqual([".env.local"]);
  });

  it("da prioridad a .env.local sobre .env", () => {
    const dir = workspace({
      ".env.local": "NEXT_PUBLIC_FIREBASE_PROJECT_ID=local\n",
      ".env": "NEXT_PUBLIC_FIREBASE_PROJECT_ID=generico\nOTRA=generico\n",
    });
    const env: Record<string, string | undefined> = {};

    loadEnvFiles(dir, env);

    expect(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("local");
    expect(env.OTRA).toBe("generico");
  });

  it("sin ficheros no inventa valores", () => {
    const dir = workspace({});
    const env: Record<string, string | undefined> = {};

    const result = loadEnvFiles(dir, env);

    expect(env).toEqual({});
    expect(result).toEqual({ loaded: [], present: [] });
  });

  it("trata un valor vacío del proceso como hueco y lo rellena del fichero", () => {
    const dir = workspace({ ".env.local": "APP_ORIGIN=http://localhost:3000\n" });
    const env: Record<string, string | undefined> = { APP_ORIGIN: "" };

    loadEnvFiles(dir, env);

    expect(env.APP_ORIGIN).toBe("http://localhost:3000");
  });
});
