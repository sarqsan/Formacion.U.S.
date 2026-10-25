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
    ...(topic.screens && topic.screens.length > 0
      ? {
          screens: topic.screens.map((screen) => ({
            id: screen.id,
            title: screen.title,
            paragraphs: [...screen.paragraphs],
            bullets: [...screen.bullets],
            pages: [...screen.pages],
          })),
        }
      : {}),
    quiz: topic.quiz.map((question) => {
      const key = keys?.quizByTopic[topic.id]?.find((item) => item.id === question.id);
      return {
        ...question,
        correctOptionIds: key?.correctOptionIds ?? [],
        ...(key?.explanation ? { explanation: key.explanation } : {}),
      };
    }),
  }));

  return {
    courseId: version.courseId,
    version: version.version,
    title: version.title,
    description: version.description ?? undefined,
    topics,
    finalExam: version.finalExam.map((question) => {
      const key = keys?.finalExam.find((item) => item.id === question.id);
      return {
        ...question,
        correctOptionIds: key?.correctOptionIds ?? [],
        ...(key?.explanation ? { explanation: key.explanation } : {}),
      };
    }),
  };
}
