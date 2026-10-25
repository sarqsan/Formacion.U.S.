import { describe, expect, it } from "vitest";
import { parseScreensForm, screensSavedRedirect } from "@/server/courses/screens-form";

/**
 * FORMULARIO DE PANTALLAS
 * =======================
 *
 * Lo que se lee del formulario tiene que ser exactamente lo que la persona ha
 * escrito, y los identificadores **no pueden cambiar**: forman parte del
 * progreso del alumnado. Estas pruebas fijan eso, además de dos fallos típicos
 * de formulario: páginas escritas mal y un tema que no venía en el formulario
 * (no se toca).
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

const existing = {
  id: "tema-uno",
  screens: [
    { id: "pantalla-1", title: "Uno", paragraphs: ["Texto uno"], bullets: [], pages: [1] },
    { id: "pantalla-2", title: "Dos", paragraphs: ["Texto dos"], bullets: [], pages: [2] },
  ],
};

describe("parseScreensForm", () => {
  it("conserva los identificadores y lee párrafos, viñetas y páginas", () => {
    const result = parseScreensForm(
      form({
        "pantallas:tema-uno:count": "2",
        "pantallas:tema-uno:0:id": "pantalla-1",
        "pantallas:tema-uno:0:title": "Qué es el riesgo",
        "pantallas:tema-uno:0:paragraphs": "Primer párrafo.\n\nSegundo párrafo.",
        "pantallas:tema-uno:0:bullets": "- Identificar\n- Valorar",
        "pantallas:tema-uno:0:pages": "3, 4,4",
        "pantallas:tema-uno:1:id": "pantalla-2",
        "pantallas:tema-uno:1:title": "Cómo se evalúa",
        "pantallas:tema-uno:1:paragraphs": "Solo uno.",
      }),
      { topics: [existing] },
    );

    expect(result["tema-uno"]).toEqual([
      {
        id: "pantalla-1",
        title: "Qué es el riesgo",
        paragraphs: ["Primer párrafo.", "Segundo párrafo."],
        bullets: ["Identificar", "Valorar"],
        pages: [3, 4],
      },
      {
        id: "pantalla-2",
        title: "Cómo se evalúa",
        paragraphs: ["Solo uno."],
        bullets: [],
        pages: [],
      },
    ]);
  });

  it("no toca los temas que no vienen en el formulario", () => {
    const result = parseScreensForm(form({}), { topics: [existing] });
    expect(result).toEqual({});
  });

  it("quita una pantalla marcada y añade una nueva con identificador libre", () => {
    const result = parseScreensForm(
      form({
        "pantallas:tema-uno:count": "2",
        "pantallas:tema-uno:0:title": "Sigue",
        "pantallas:tema-uno:1:delete": "on",
        "pantallas:tema-uno:newTitle": "Nueva pantalla",
        "pantallas:tema-uno:newParagraphs": "Texto nuevo",
        "pantallas:tema-uno:newPages": "5",
      }),
      { topics: [existing] },
    );

    expect(result["tema-uno"].map((screen) => screen.id)).toEqual(["pantalla-1", "pantalla-3"]);
    expect(result["tema-uno"][1].title).toBe("Nueva pantalla");
    expect(result["tema-uno"][1].pages).toEqual([5]);
  });

  it("rechaza una página que no es un número", () => {
    expect(() =>
      parseScreensForm(
        form({
          "pantallas:tema-uno:count": "1",
          "pantallas:tema-uno:0:title": "Uno",
          "pantallas:tema-uno:0:pages": "3, cuatro",
        }),
        { topics: [existing] },
      ),
    ).toThrowError(/no es un número de página/);
  });

  it("genera un destino que vuelve al paso 3 con el resumen", () => {
    expect(
      screensSavedRedirect({ courseId: "curso-a", version: 2, topics: 3, total: 12 }),
    ).toBe("/admin/cursos/curso-a/ia?v=2&paso=3&ok=pantallas-3-12");
  });
});
