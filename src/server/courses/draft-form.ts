import { DomainError } from "@/domain/text";
import type { DraftStructure, TopicStructure } from "@/server/courses/editor";

/**
 * LECTURA DEL FORMULARIO DEL EDITOR DE ESTRUCTURA
 * ===============================================
 *
 * El formulario es HTML sin JavaScript (mejora progresiva, como el resto de la
 * aplicación): todo llega como `FormData` y se interpreta aquí, en servidor.
 *
 * Dos reglas deliberadas:
 *   - **los temas que no llegan, se eliminan** del borrador. El editor pinta un
 *     campo por tema existente, así que solo desaparece lo que se ha marcado
 *     para borrar o lo que ya no existía;
 *   - el orden no se confía a la posición de los campos: se lee el número que
 *     ha escrito la persona y el servicio lo normaliza a 1..n. Un número
 *     repetido no rompe nada, se reajusta de forma determinista.
 *
 * No se valida contenido aquí (títulos vacíos, longitudes, identificadores):
 * eso vive en `checkDraftStructure`, para que la regla sea una sola.
 */

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

function checked(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "on" || value === "true" || value === "1";
}

export interface ParsedDraftForm {
  structure: DraftStructure;
  /** Identificador del tema añadido en este guardado, si lo hay. */
  addedTopicId: string | null;
}

/**
 * @param currentTopics temas que el editor tenía pintados, en orden.
 * @throws DomainError `DRAFT_FORM_INVALID` si el formulario es incoherente.
 */
export function parseDraftStructureForm(
  formData: FormData,
  currentTopics: ReadonlyArray<Pick<TopicStructure, "id">>,
): ParsedDraftForm {
  const title = text(formData, "title");
  const description = text(formData, "description");

  const topics: TopicStructure[] = [];
  currentTopics.forEach((topic, index) => {
    if (checked(formData, `delete:${topic.id}`)) return;

    const rawOrder = Number(formData.get(`topic:${topic.id}:order`));
    topics.push({
      id: topic.id,
      title: text(formData, `topic:${topic.id}:title`),
      order: Number.isFinite(rawOrder) && rawOrder >= 1 ? rawOrder : index + 1,
      mandatory: checked(formData, `topic:${topic.id}:mandatory`),
    });
  });

  const newTopicId = text(formData, "newTopicId");
  const newTopicTitle = text(formData, "newTopicTitle");
  let addedTopicId: string | null = null;

  if (newTopicId || newTopicTitle) {
    if (!newTopicId || !newTopicTitle) {
      throw new DomainError(
        "DRAFT_FORM_INVALID",
        "Para añadir un tema hay que indicar identificador y título.",
        400,
      );
    }
    if (currentTopics.some((topic) => topic.id === newTopicId)) {
      throw new DomainError(
        "DRAFT_FORM_INVALID",
        `Ya existe un tema con el identificador «${newTopicId}».`,
        400,
      );
    }

    const nextOrder = topics.reduce((max, topic) => Math.max(max, topic.order), 0) + 1;
    topics.push({
      id: newTopicId,
      title: newTopicTitle,
      order: nextOrder,
      mandatory: checked(formData, "newTopicMandatory"),
    });
    addedTopicId = newTopicId;
  }

  return {
    structure: { title, description, topics },
    addedTopicId,
  };
}
