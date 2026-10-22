import { describe, expect, it } from "vitest";
import {
  draftEditorPath,
  draftSavedRedirect,
  draftStartedRedirect,
  parseDraftStructureForm,
} from "@/server/courses/draft-form";
import { saveDraftStructure, startDraft } from "@/server/courses/editor";
import { definitionFromDocuments } from "@/server/courses/definition";
import { ADMIN, FIXED_NOW, InMemoryCatalogStore } from "../helpers/db-doubles";

/**
 * FORMULARIO DEL EDITOR DE ESTRUCTURA
 * ===================================
 *
 * El formulario es HTML sin JavaScript: todo llega como `FormData`. Aquí se
 * comprueba la traducción de ese formulario a estructura guardable, que es
 * justo donde se pierden datos si se hace mal:
 *
 *   · un tema que no llega, se elimina (y solo en el borrador);
 *   · el orden se toma del número escrito, no de la posición del campo;
 *   · una casilla desmarcada es `false`, no «sin dato»;
 *   · los identificadores no se inventan ni se reutilizan.
 */

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const existing = [{ id: "tema-uno" }, { id: "tema-dos" }];

describe("parseDraftStructureForm", () => {
  it("lee título, descripción y temas existentes", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "Curso de prevención",
        description: "Descripción breve",
        "topic:tema-uno:title": "Primero",
        "topic:tema-uno:order": "1",
        "topic:tema-uno:mandatory": "on",
        "topic:tema-dos:title": "Segundo",
        "topic:tema-dos:order": "2",
      }),
      existing,
    );

    expect(parsed.structure).toEqual({
      title: "Curso de prevención",
      description: "Descripción breve",
      topics: [
        { id: "tema-uno", title: "Primero", order: 1, mandatory: true },
        // Sin casilla marcada: opcional, no «desconocido».
        { id: "tema-dos", title: "Segundo", order: 2, mandatory: false },
      ],
    });
    expect(parsed.addedTopicId).toBeNull();
  });

  it("reordena según el número escrito, no según la posición del campo", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "Curso",
        "topic:tema-uno:title": "Primero",
        "topic:tema-uno:order": "2",
        "topic:tema-dos:title": "Segundo",
        "topic:tema-dos:order": "1",
      }),
      existing,
    );

    expect(parsed.structure.topics.map((topic) => [topic.id, topic.order])).toEqual([
      ["tema-uno", 2],
      ["tema-dos", 1],
    ]);
  });

  it("un orden vacío o inválido cae en la posición del formulario, sin romper el guardado", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "Curso",
        "topic:tema-uno:title": "Primero",
        "topic:tema-uno:order": "",
        "topic:tema-dos:title": "Segundo",
        "topic:tema-dos:order": "0",
      }),
      existing,
    );

    expect(parsed.structure.topics.map((topic) => topic.order)).toEqual([1, 2]);
  });

  it("elimina el tema marcado para borrar y conserva el resto", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "Curso",
        "topic:tema-uno:title": "Primero",
        "topic:tema-uno:order": "1",
        "delete:tema-uno": "on",
        "topic:tema-dos:title": "Segundo",
        "topic:tema-dos:order": "2",
      }),
      existing,
    );

    expect(parsed.structure.topics.map((topic) => topic.id)).toEqual(["tema-dos"]);
  });

  it("permite dejar el borrador sin temas", () => {
    const parsed = parseDraftStructureForm(form({ title: "Curso vacío" }), existing);

    expect(parsed.structure).toEqual({ title: "Curso vacío", description: "", topics: [] });
  });

  it("añade un tema nuevo al final y lo identifica", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "Curso",
        "topic:tema-uno:title": "Primero",
        "topic:tema-uno:order": "1",
        newTopicId: "tema-nuevo",
        newTopicTitle: "Tema nuevo",
        newTopicMandatory: "on",
      }),
      existing,
    );

    expect(parsed.addedTopicId).toBe("tema-nuevo");
    expect(parsed.structure.topics.at(-1)).toEqual({
      id: "tema-nuevo",
      title: "Tema nuevo",
      order: 2,
      mandatory: true,
    });
  });

  it("rechaza un tema nuevo con identificador repetido, sin inventarse otro", () => {
    expect(() =>
      parseDraftStructureForm(
        form({ title: "Curso", newTopicId: "tema-uno", newTopicTitle: "Repetido" }),
        existing,
      ),
    ).toThrowError(/Ya existe un tema/);
  });

  it("rechaza un tema nuevo a medias (sin identificador o sin título)", () => {
    expect(() =>
      parseDraftStructureForm(form({ title: "Curso", newTopicId: "tema-x" }), existing),
    ).toThrowError(/identificador y título/);
    expect(() =>
      parseDraftStructureForm(form({ title: "Curso", newTopicTitle: "Solo título" }), existing),
    ).toThrowError(/identificador y título/);
  });

  it("recorta espacios de los textos", () => {
    const parsed = parseDraftStructureForm(
      form({
        title: "  Curso  ",
        description: "  ",
        "topic:tema-uno:title": "  Tema  ",
        "topic:tema-uno:order": "1",
      }),
      [{ id: "tema-uno" }],
    );

    expect(parsed.structure.title).toBe("Curso");
    expect(parsed.structure.description).toBe("");
    expect(parsed.structure.topics[0].title).toBe("Tema");
  });
});

describe("del formulario al almacén", () => {
  it("guarda exactamente lo que el formulario describía, y se recupera igual", async () => {
    const store = new InMemoryCatalogStore();
    store.courses.set("curso-form", {
      courseId: "curso-form",
      title: "Curso",
      publishedVersion: null,
      lastDraftVersion: null,
    });
    const deps = { store, now: () => FIXED_NOW };
    const opened = await startDraft({ actor: ADMIN, courseId: "curso-form" }, deps);

    // Segundo guardado: el editor ya tiene un tema y añade otro.
    const first = parseDraftStructureForm(
      form({
        title: "Curso desde formulario",
        description: "Con dos temas",
        "topic:tema-uno:title": "Uno",
        "topic:tema-uno:order": "2",
        "topic:tema-uno:mandatory": "on",
        "topic:tema-dos:title": "Dos",
        "topic:tema-dos:order": "1",
        newTopicId: "tema-tres",
        newTopicTitle: "Tres",
        "topic:tema-tres:order": "3",
      }),
      [{ id: "tema-uno" }, { id: "tema-dos" }],
    );

    await saveDraftStructure(
      {
        actor: ADMIN,
        courseId: "curso-form",
        version: opened.version,
        expectedRevision: opened.revision,
        structure: first.structure,
      },
      deps,
    );

    const stored = await store.getVersion("curso-form", opened.version);
    const definition = definitionFromDocuments(stored!, null);

    expect(definition.title).toBe("Curso desde formulario");
    expect(definition.description).toBe("Con dos temas");
    // `saveDraftStructure` normaliza el orden a 1..n respetando lo pedido.
    expect(definition.topics.map((topic) => [topic.id, topic.order, topic.mandatory])).toEqual([
      ["tema-dos", 1, false],
      ["tema-uno", 2, true],
      ["tema-tres", 3, false],
    ]);
  });
});

describe("rutas de las acciones", () => {
  it("codifica el identificador del curso en la ruta del editor", () => {
    expect(draftEditorPath("curso a/b", 3)).toBe("/admin/cursos/curso%20a%2Fb/editar?v=3");
  });

  it("distingue borrador creado de borrador reanudado", () => {
    expect(draftStartedRedirect({ courseId: "c", version: 1, created: true })).toBe(
      "/admin/cursos/c/editar?v=1&ok=borrador",
    );
    expect(draftStartedRedirect({ courseId: "c", version: 1, created: false })).toBe(
      "/admin/cursos/c/editar?v=1&ok=reanudado",
    );
  });

  it("nunca devuelve éxito cuando hay error", () => {
    const url = draftSavedRedirect({ courseId: "c", version: 2, failure: "DRAFT_STALE" });
    expect(url).toBe("/admin/cursos/c/editar?v=2&error=DRAFT_STALE");
    expect(url).not.toContain("ok=");
  });
});
