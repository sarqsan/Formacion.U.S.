import type { CourseVersionDefinition, TopicDefinition } from "@/domain/courses/content";
import type { AnswerKeysDocument, CourseVersionDocument } from "@/server/courses/catalog";

/**
 * RECONSTRUIR LA DEFINICIÓN EDITABLE
 * ==================================
 *
 * El contenido publicado se guarda en dos documentos: la versión (sin
 * respuestas) y las claves de corrección (solo servidor). Para editar un
 * borrador hay que volver a juntarlos.
 *
 * Esta función es pura y la comparten el almacén de demostración y el de
 * Firestore, para que un borrador se reconstruya igual en los dos.
 */
/**
 * Claves vacías: un borrador recién creado todavía no tiene cuestionarios, así
 * que no hay ninguna clave que guardar. No se escribe documento de claves
 * (generarlas es trabajo del editor de cuestionarios).
 */
export function emptyAnswerKeys(
  courseId: string,
  version: number,
  createdAt: string,
): AnswerKeysDocument {
  return { courseId, version, quizByTopic: {}, finalExam: [], createdAt };
}

/**
 * Reconstruye la definición editable.
 *
 * `keys` puede ser `null`: un borrador sin cuestionarios no tiene documento de
 * claves y aun así debe poder abrirse y editarse su estructura.
 */
export function definitionFromDocuments(
  version: CourseVersionDocument,
  keys: AnswerKeysDocument | null,
): CourseVersionDefinition {
  const topics: TopicDefinition[] = version.topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    order: topic.order,
    mandatory: topic.mandatory,
    documents: topic.documents.map((document) => ({
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
    })),
    quiz: topic.quiz.map((question) => ({
      ...question,
      correctOptionIds:
        keys?.quizByTopic[topic.id]?.find((key) => key.id === question.id)?.correctOptionIds ??
          [],
    })),
  }));

  return {
    courseId: version.courseId,
    version: version.version,
    title: version.title,
    description: version.description ?? undefined,
    topics,
    finalExam: version.finalExam.map((question) => ({
      ...question,
      correctOptionIds:
        keys?.finalExam.find((key) => key.id === question.id)?.correctOptionIds ?? [],
    })),
  };
}
