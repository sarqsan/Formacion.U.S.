import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FIREBASE ADMIN TIENE QUE CARGAR EN EL RUNTIME DE VERCEL
 * ======================================================
 *
 * Incidencia real (23/10/2026): tras reparar el 404, la aplicación empezó a
 * responder **500 en todas las páginas** mientras `/api/health` seguía en 200.
 *
 * Causa: `firebase-admin@14` → `jwks-rsa@4` → `jose@6`, que es **ESM-only**.
 * Next externaliza `firebase-admin` (`serverExternalPackages`) y el runtime de
 * funciones de Vercel arranca Node con `--no-experimental-require-module`, así
 * que el `require("jose")` de jwks-rsa lanza `ERR_REQUIRE_ESM` **al cargar el
 * módulo**. Todo lo que importa `@/server/portal` (el layout, o sea todas las
 * páginas) muere antes de ejecutar una sola línea; las rutas de API que no
 * tocan firebase-admin siguen funcionando. Ese reparto desigual es la firma del
 * fallo.
 *
 * La corrección es un `overrides` de npm: `jwks-rsa` usa `jose@5`, que publica
 * build CommonJS. jwks-rsa solo necesita `importJWK` y `exportSPKI`, cuya API
 * no cambia entre 5 y 6.
 *
 * Estas pruebas ejecutan Node **con el mismo flag que Vercel**: sin él, Node 22
 * local resuelve `require(esm)` y el fallo pasa desapercibido hasta producción
 * (comprobado: el mismo build daba 200 sin flag y 500 con flag).
 */

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

function pkg(name: string): { version?: string; type?: string } {
  return JSON.parse(readFileSync(root(`node_modules/${name}/package.json`), "utf8")) as {
    version?: string;
    type?: string;
  };
}

describe("jose que consume jwks-rsa es CommonJS", () => {
  it("package.json fija jwks-rsa → jose 5 por overrides", () => {
    const manifest = JSON.parse(readFileSync(root("package.json"), "utf8")) as {
      overrides?: Record<string, Record<string, string>>;
    };

    expect(manifest.overrides?.["jwks-rsa"]?.jose).toBe("^5.10.0");
  });

  it("la copia anidada de jose ya no es ESM-only", () => {
    const jose = pkg("jwks-rsa/node_modules/jose");

    expect(jose.version?.startsWith("5.")).toBe(true);
    // `type: module` es exactamente lo que rompía el require() de jwks-rsa.
    expect(jose.type).not.toBe("module");
  });
});

describe("con el flag de Vercel, firebase-admin carga", () => {
  it("require('firebase-admin/auth') no lanza ERR_REQUIRE_ESM", () => {
    // Sin `--no-experimental-require-module`, Node 22 resuelve require(esm) y
    // esta prueba no detectaría nada: el flag es la diferencia entre local y
    // producción.
    const output = execFileSync(
      process.execPath,
      [
        "--no-experimental-require-module",
        "-e",
        "require('firebase-admin/auth'); require('firebase-admin/firestore'); console.log('ok')",
      ],
      { cwd: root("."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(output.trim()).toBe("ok");
  });
});
