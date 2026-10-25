import { DomainError } from "@/domain/text";
import type { StudyScreen } from "@/domain/courses/screens";

/**
 * FORMULARIO DE PANTALLAS DE ESTUDIO
 * ==================================
 *
 * Las pantallas no se editan como un JSON en un `<textarea>`: el administrador
 * ve el mismo contenido que verá el alumnado, campo a campo, y el servidor lee
 * exactamente esos campos. Mismo criterio que el formulario de cuestionarios
 * (`quiz-form.ts`): **lo que no llega, no existe**; lo que llega a medias, es
 * un error de formulario y no se guarda.
 *
 * Los identificadores viajan en campos ocultos porque forman parte del progreso
 * del alumnado: reescribir una pantalla no puede cambiar su identidad y hacer
 * que alguien pierda lo ya estudiado.
 *
 * Formato (por tema y posición):
 *
 *   pantallas:<temaId>:count                 número de pantallas existentes
 *   pantallas:<temaId>:<pos>:id              identificador actual
 *   pantallas:<temaId>:<pos>:title           título
 *   pantallas:<temaId>:<pos>:paragraphs      párrafos, uno por línea en blanco
 *   pantallas:<temaId>:<pos>:bullets         viñetas, una por línea
 *   pantallas:<temaId>:<pos>:pages           páginas separadas por comas
 *   pantallas:<temaId>:<pos>:delete          casilla para quitar la pantalla
 *   pantallas:<temaId>:newTitle              pantalla nueva (opcional)
 */

const PREFIX = "pantallas";

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) !== null;
}

/** Párrafos: se separan por línea en blanco; si no hay, una línea = un párrafo. */
function paragraphs(raw: string): string[] {
  const blocks = raw
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block !== "");
  if (blocks.length > 1) return blocks;
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function bullets(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function pages(raw: string): number[] {
  if (raw === "") return [];
  const out: number[] = [];
  for (const piece of raw.split(/[,\s;]+/)) {
    if (piece === "") continue;
    const value = Number(piece);
    if (!Number.isInteger(value) || value < 1) {
      throw new DomainError(
        "DRAFT_FORM_INVALID",
        `«${piece}» no es un número de página. Escribe las páginas separadas por comas, por ejemplo: 3, 4, 5.`,
        400,
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Siguiente identificador libre, buscando el primer hueco desde `from`.
 * Los identificadores son visibles para el alumnado en su progreso: se evita
 * reutilizar el de una pantalla que ya existe.
 */
function nextId(existing: ReadonlyArray<string>, from: number): string {
  let position = Math.max(1, from);
  while (existing.includes(`pantalla-${position}`)) position += 1;
  return `pantalla-${position}`;
}

/**
 * Lee las pantallas de los temas incluidos en el formulario.
 *
 * Solo devuelve los temas que traen el campo `count`: un formulario que no
 * incluye un tema no lo modifica (`saveDraftScreens` deja intactos los temas
 * que no aparecen).
 */
export function parseScreensForm(
  formData: FormData,
  view: { topics: ReadonlyArray<{ id: string; screens: StudyScreen[] }> },
): Record<string, StudyScreen[]> {
  const result: Record<string, StudyScreen[]> = {};

  for (const topic of view.topics) {
    const countRaw = text(formData, `${PREFIX}:${topic.id}:count`);
    if (countRaw === "") continue;

    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 0 || count > 100) {
      throw new DomainError("DRAFT_FORM_INVALID", "El número de pantallas del tema no es válido.", 400);
    }

    const kept: StudyScreen[] = [];
    const ids = topic.screens.map((screen) => screen.id);

    for (let position = 0; position < count; position += 1) {
      const base = `${PREFIX}:${topic.id}:${position}`;
      if (checked(formData, `${base}:delete`)) continue;

      const id = text(formData, `${base}:id`) || topic.screens[position]?.id || nextId(ids, position + 1);

      kept.push({
        id,
        title: text(formData, `${base}:title`),
        paragraphs: paragraphs(text(formData, `${base}:paragraphs`)),
        bullets: bullets(text(formData, `${base}:bullets`)),
        pages: pages(text(formData, `${base}:pages`)),
      });
    }

    // Pantalla nueva: si hay título, se añade al final con identificador libre.
    const newTitle = text(formData, `${PREFIX}:${topic.id}:newTitle`);
    if (newTitle !== "") {
      const known = [...ids, ...kept.map((screen) => screen.id)];
      kept.push({
        id: nextId(known, kept.length + 1),
        title: newTitle,
        paragraphs: paragraphs(text(formData, `${PREFIX}:${topic.id}:newParagraphs`)),
        bullets: bullets(text(formData, `${PREFIX}:${topic.id}:newBullets`)),
        pages: pages(text(formData, `${PREFIX}:${topic.id}:newPages`)),
      });
    }

    result[topic.id] = kept;
  }

  return result;
}

/** Destino tras guardar pantallas, conservando el paso del asistente. */
export function screensSavedRedirect(input: {
  courseId: string;
  version: number;
  topics: number;
  total: number;
}): string {
  const params = new URLSearchParams({
    v: String(input.version),
    paso: "3",
    ok: `pantallas-${input.topics}-${input.total}`,
  });
  return `/admin/cursos/${encodeURIComponent(input.courseId)}/ia?${params.toString()}`;
}
