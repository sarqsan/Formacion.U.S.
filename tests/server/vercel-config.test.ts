import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DESPLIEGUE EN VERCEL: QUE SE PUBLIQUE LA APLICACIÓN, NO SOLO `public/`
 * =====================================================================
 *
 * Incidencia real (23/10/2026): `https://formacionus.vercel.app/` devolvía un
 * 404 de **infraestructura** de Vercel (`NOT_FOUND`), no un 404 de Next.js. La
 * prueba que lo delató: el único fichero de `public/` se servía con 200
 * (`/demo/personas-sinteticas.xlsx`) mientras `/`, `/login`, `/activar`,
 * `/panel`, `/api/health` y hasta `/favicon.ico` —una ruta que genera Next, no
 * un fichero de `public/`— daban 404.
 *
 * Eso solo ocurre cuando Vercel publica el repositorio como **sitio estático**:
 * con el preset de framework «Other», el directorio de salida es `public/` si
 * existe, y solo se sirve su contenido; la aplicación Next nunca se publica.
 * El build termina «Listo» porque `next build` sí se ejecuta: el problema es
 * qué se publica después, no si compila.
 *
 * `vercel.json` fija el preset a `nextjs`, que es la única palanca que hay
 * desde el repositorio: la documentación de Vercel indica que `framework`
 * «overrides the Framework in Project Settings» y que `outputDirectory` puede
 * fijarse por despliegue. Sin esto, cualquier cambio en el panel puede volver a
 * dejar el sitio sirviendo solo `public/`, y el síntoma (404 de Vercel en todas
 * las rutas) no se parece en nada a un error de la aplicación.
 *
 * Estas pruebas no hablan con Vercel: comprueban la configuración versionada y
 * que las rutas que deben servirse existen en el árbol.
 */

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8"));
}

const vercel = readJson("vercel.json");

describe("vercel.json fija el despliegue como aplicación Next.js", () => {
  it("existe y es JSON válido", () => {
    expect(vercel).toBeTypeOf("object");
    expect(vercel.$schema).toBe("https://openapi.vercel.sh/vercel.json");
  });

  it("fija el framework en Next.js (impide publicar como sitio estático)", () => {
    expect(vercel.framework).toBe("nextjs");
  });

  it("publica la salida de Next, no la carpeta public", () => {
    // El fallo original: outputDirectory = public ⇒ solo se sirven los ficheros
    // estáticos y ninguna ruta de la aplicación.
    expect(vercel.outputDirectory).toBe(".next");
    expect(vercel.outputDirectory).not.toBe("public");
  });

  it("construye con el script del repositorio", () => {
    expect(vercel.buildCommand).toBe("npm run build");
  });
});

describe("el árbol tiene la aplicación que debe publicarse", () => {
  const routes = [
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/login/page.tsx",
    "src/app/activar/page.tsx",
    "src/app/panel/page.tsx",
    "src/app/api/health/route.ts",
  ];

  it("las rutas servidas por la aplicación están en src/app", () => {
    for (const route of routes) {
      expect(existsSync(fileURLToPath(new URL(`../../${route}`, import.meta.url))), route).toBe(true);
    }
  });

  it("no hay un app/ ni un pages/ en la raíz que confundan la detección", () => {
    for (const folder of ["app", "pages"]) {
      expect(existsSync(fileURLToPath(new URL(`../../${folder}`, import.meta.url))), folder).toBe(
        false,
      );
    }
  });

  it("la aplicación es Next.js y no un sitio estático", () => {
    const pkg = readJson("package.json") as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.dependencies?.next).toBeTruthy();
    expect(pkg.scripts?.build).toContain("next build");
  });
});
