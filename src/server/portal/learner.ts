import { DomainError } from "@/domain/text";
import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import { completionPercent, isFinalExamUnlocked } from "@/domain/progress/course-progress";
import { isEnrollmentActive, type Enrollment } from "@/domain/courses/enrollment";
import type {
  CourseCatalogStore,
  CourseVersionDocument,
  PublicDocument,
  PublicQuestion,
  PublicTopic,
} from "@/server/courses/catalog";
import { mandatoryTopicsOf } from "@/server/courses/catalog";
import type { EnrollmentStore } from "@/server/enrollments/store";
import type { LearningStore, StoredProgress } from "@/server/learning/store";
import { loadOrInitProgress } from "@/server/learning/progress-loader";
import { assertCourseAccess } from "@/server/enrollments/service";

/**
 * VISTAS DEL ALUMNO (lógica compartida)
 * =====================================
 *
 * Esta capa no sabe dónde están los datos: recibe los tres almacenes por
 * parámetro. La usan igual el portal de Firestore y el de la demostración, de
 * modo que el alumno ve exactamente el mismo cálculo de progreso en los dos.
 *
 * Nada de aquí escribe: `loadOrInitProgress` calcula, el servicio que llama
 * decide si persiste.
 */

export interface LearnerDependencies {
  catalog: CourseCatalogStore;
  enrollments: EnrollmentStore;
  learning: LearningStore;
  now?: () => Date;
}

export interface CourseCard {
  courseId: string;
  title: string;
  description: string | null;
  version: number;
  percent: number;
  completed: boolean;
  topicsTotal: number;
  topicsPassed: number;
  nextStep: string;
}

export interface DocumentView {
  id: string;
  title: string;
  totalPages: number;
  lastPageViewed: number;
  read: boolean;
}

export interface TopicView {
  id: string;
  title: string;
  order: number;
  mandatory: boolean;
  documents: DocumentView[];
  questions: PublicQuestion[];
  readComplete: boolean;
  quizAvailable: boolean;
  quizPassed: boolean;
  attempts: number;
  bestScore: number;
  passedAt: string | null;
}

export interface CourseView {
  courseId: string;
  title: string;
  description: string | null;
  version: number;
  percent: number;
  completed: boolean;
  topics: TopicView[];
  finalExam: {
    unlocked: boolean;
    passed: boolean;
    attempts: number;
    bestScore: number;
    passedAt: string | null;
    questions: PublicQuestion[];
  };
  enrollment: Enrollment;
  progress: StoredProgress;
}

export interface PublishedDocumentLocation {
  course: { courseId: string; title: string; publishedVersion: number };
  version: CourseVersionDocument;
  topic: PublicTopic;
  document: PublicDocument;
  enrollment: Enrollment | null;
  progress: StoredProgress;
}

export async function coursesForLearner(
  deps: LearnerDependencies,
  actor: Actor,
): Promise<CourseCard[]> {
  const active = assertActiveAccount(actor);
  const enrollments = await deps.enrollments.listByUser(active.uid);
  const cards: CourseCard[] = [];
  const at = (deps.now?.() ?? new Date()).toISOString();

  for (const enrollment of enrollments) {
    if (!isEnrollmentActive(enrollment)) continue;

    const course = await deps.catalog.getCourse(enrollment.courseId);
    if (!course || course.publishedVersion === null) continue;

    const version = await deps.catalog.getVersion(course.courseId, course.publishedVersion);
    if (!version) continue;

    const { progress } = await loadOrInitProgress({
      learning: deps.learning,
      uid: active.uid,
      courseId: course.courseId,
      publishedVersion: course.publishedVersion,
      mandatoryTopicIds: mandatoryTopicsOf(version),
      at,
    });

    const topicsTotal = progress.mandatoryTopicIds.length;
    const topicsPassed = progress.mandatoryTopicIds.filter(
      (topicId) => progress.topics[topicId]?.passed,
    ).length;

    const nextStep = progress.finalExam.passed
      ? "Curso completado"
      : isFinalExamUnlocked(progress)
        ? "Examen final disponible"
        : `Siguiente: ${version.topics.find((topic) => !progress.topics[topic.id]?.passed)?.title ?? "tema pendiente"}`;

    cards.push({
      courseId: course.courseId,
      title: version.title,
      description: version.description,
      version: course.publishedVersion,
      percent: completionPercent(progress),
      completed: progress.completedAt !== null,
      topicsTotal,
      topicsPassed,
      nextStep,
    });
  }

  return cards;
}

export async function courseViewForLearner(
  deps: LearnerDependencies,
  actor: Actor,
  courseId: string,
): Promise<CourseView> {
  const active = assertActiveAccount(actor);

  await assertCourseAccess(active, courseId, deps);

  const course = await deps.catalog.getCourse(courseId);
  if (!course || course.publishedVersion === null) {
    throw new DomainError("COURSE_NOT_AVAILABLE", "El curso no está publicado.", 404);
  }

  const version = await deps.catalog.getVersion(courseId, course.publishedVersion);
  if (!version) {
    throw new DomainError("VERSION_NOT_FOUND", "La versión publicada no existe.", 404);
  }

  const enrollment = await deps.enrollments.get(active.uid, courseId);
  if (!enrollment) {
    throw new DomainError("COURSE_NOT_AUTHORIZED", "No tienes matrícula en este curso.", 403);
  }

  const { progress } = await loadOrInitProgress({
    learning: deps.learning,
    uid: active.uid,
    courseId,
    publishedVersion: course.publishedVersion,
    mandatoryTopicIds: mandatoryTopicsOf(version),
    at: (deps.now?.() ?? new Date()).toISOString(),
  });

  const topics: TopicView[] = [...version.topics]
    .sort((a, b) => a.order - b.order)
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      order: topic.order,
      mandatory: topic.mandatory,
      ...topicState(topic, progress),
    }));

  return {
    courseId,
    title: version.title,
    description: version.description,
    version: course.publishedVersion,
    percent: completionPercent(progress),
    completed: progress.completedAt !== null,
    topics,
    finalExam: {
      unlocked: isFinalExamUnlocked(progress),
      passed: progress.finalExam.passed,
      attempts: progress.finalExam.attempts,
      bestScore: progress.finalExam.bestScore,
      passedAt: progress.finalExam.passedAt,
      questions: version.finalExam,
    },
    enrollment,
    progress,
  };
}

function topicState(topic: PublicTopic, progress: StoredProgress) {
  const documents: DocumentView[] = topic.documents.map((document) => {
    const stored = progress.documents[document.id];
    const lastPageViewed = stored?.lastPageViewed ?? 0;
    return {
      id: document.id,
      title: document.title,
      totalPages: document.pageCount,
      lastPageViewed,
      read: lastPageViewed >= document.pageCount,
    };
  });

  const readComplete = documents.every((document) => document.read);
  const topicProgress = progress.mandatoryTopicIds.includes(topic.id)
    ? progress.topics[topic.id]
    : undefined;

  return {
    documents,
    questions: topic.quiz,
    readComplete,
    quizAvailable: readComplete && topic.quiz.length > 0,
    quizPassed: topicProgress?.passed ?? false,
    attempts: topicProgress?.attempts ?? 0,
    bestScore: topicProgress?.bestScore ?? 0,
    passedAt: topicProgress?.passedAt ?? null,
  };
}

/**
 * Localiza un documento dentro de la versión **publicada** del curso.
 *
 * Se usa para abrir la lectura. Comprueba matrícula, publicación y que el
 * documento pertenezca a esa versión: no se puede pedir un documento de un
 * borrador ni de otra versión cambiando la URL.
 */
export async function locatePublishedDocument(
  deps: LearnerDependencies,
  actor: Actor,
  courseId: string,
  documentId: string,
): Promise<PublishedDocumentLocation> {
  const active = assertActiveAccount(actor);
  await assertCourseAccess(active, courseId, deps);

  const course = await deps.catalog.getCourse(courseId);
  if (!course || course.publishedVersion === null) {
    throw new DomainError("COURSE_NOT_AVAILABLE", "El curso no está publicado.", 404);
  }

  const version = await deps.catalog.getVersion(courseId, course.publishedVersion);
  if (!version) throw new DomainError("VERSION_NOT_FOUND", "La versión no existe.", 404);

  for (const topic of version.topics) {
    const document = topic.documents.find((item) => item.id === documentId);
    if (!document) continue;

    const enrollment = await deps.enrollments.get(active.uid, courseId);
    const { progress } = await loadOrInitProgress({
      learning: deps.learning,
      uid: active.uid,
      courseId,
      publishedVersion: course.publishedVersion,
      mandatoryTopicIds: mandatoryTopicsOf(version),
      at: (deps.now?.() ?? new Date()).toISOString(),
    });

    return {
      course: { courseId, title: course.title, publishedVersion: course.publishedVersion },
      version,
      topic,
      document,
      enrollment,
      progress,
    };
  }

  throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe en este curso.", 404);
}
