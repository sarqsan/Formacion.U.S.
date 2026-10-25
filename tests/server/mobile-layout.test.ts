import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CABECERA UTILIZABLE EN EL MÓVIL
 * ===============================
 *
 * Incidencia real (25/10/2026): en un teléfono la cabecera ocupaba **media
 * pantalla** y el formulario de alta de curso no cabía. Dos causas, las dos en
 * CSS, y las dos invisibles en una prueba de servicios:
 *
 *   1. `.nav` fijaba `display: flex`, que gana a la utilidad `.hidden` de
 *      Tailwind (misma especificidad, aparece después). La navegación de
 *      escritorio (`hidden sm:flex`) se veía en el móvil y envolvía en tres
 *      filas.
 *   2. `.site-header` era `position: sticky`: aun con una sola fila, se quedaba
 *      pegada arriba y robaba alto al contenido.
 *
 * Estas pruebas leen el CSS y la cabecera versionados; no abren un navegador.
 * Sirven para que un cambio de estilos no reintroduzca el problema sin que
 * nadie se dé cuenta.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const css = readFileSync(`${root}src/app/globals.css`, "utf8");
const header = readFileSync(`${root}src/app/components/site-header.tsx`, "utf8");
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

function rule(selector: string): string {
  const match = new RegExp(`\\n${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `No se encontró la regla ${selector} en globals.css`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("cabecera en el móvil", () => {
  it("no fija el display de .nav: lo decide la utilidad de Tailwind", () => {
    // Si `.nav` vuelve a declarar `display`, `hidden` deja de ocultar la
    // navegación de escritorio en pantallas pequeñas.
    expect(rule(".nav")).not.toMatch(/display\s*:/);
    expect(header).toContain("nav hidden sm:flex");
  });

  it("deja la cabecera sin fijar por debajo de 640 px", () => {
    const media = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(media).toBeTruthy();
    const block = media?.[1] ?? "";
    expect(block).toMatch(/\.site-header\s*\{[^}]*position:\s*static/);
  });

  it("la navegación móvil es una sola fila desplazable, no un bloque que envuelve", () => {
    expect(header).toContain("flex-nowrap");
    expect(header).toContain("overflow-x-auto");
    expect(header).toContain('aria-label="Principal móvil"');
  });
});

describe("dónde se entra a «Crear curso con IA»", () => {
  /**
   * Incidencia real (25/10/2026): el enlace solo existía dentro de «Cursos», y
   * quien llegaba por «Nuevo curso» no lo encontraba. Ahora está en los cuatro
   * sitios por los que se pasa al preparar un curso.
   */
  const entryPoints = [
    "src/app/components/site-header.tsx",
    "src/app/admin/page.tsx",
    "src/app/admin/cursos/page.tsx",
    "src/app/admin/cursos/nuevo/page.tsx",
  ];

  for (const path of entryPoints) {
    it(`${path} enlaza a /admin/cursos/ia`, () => {
      expect(read(path)).toContain('"/admin/cursos/ia"');
    });
  }

  it("el botón dice «Crear curso con IA», no «Crear con IA»", () => {
    // El texto corto se confundía con «crear un curso a mano».
    expect(read("src/app/admin/cursos/page.tsx")).toContain("Crear curso con IA");
    expect(read("src/app/admin/page.tsx")).toContain("Crear curso con IA");
  });
});
