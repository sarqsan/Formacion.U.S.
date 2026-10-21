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
export function definitionFromDocuments(
  version: CourseVersionDocument,
  keys: AnswerKeysDocument,
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
        keys.quizByTopic[topic.id]?.find((key) => key.id === question.id)?.correctOptionIds ?? [],
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
        keys.finalExam.find((key) => key.id === question.id)?.correctOptionIds ?? [],
    })),
  };
}
