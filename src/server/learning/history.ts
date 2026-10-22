import { assertActiveAccount, assertCanReadProgress, type Actor } from "@/domain/auth/authorization";
import { sortHistory, summarizeArchived } from "@/domain/progress/history";
import { DomainError } from "@/domain/text";
import type { CourseCatalogStore } from "@/server/courses/catalog";
import type { ArchivedProgress, LearningStore } from "@/server/learning/store";

/**
 * HISTÓRICO DE FORMACIÓN (servicio)
 * =================================
 *
 * Une las tres piezas que ya existían por separado:
 *
 *   · `progressHistory` — el archivo que se escribe al publicar una versión
 *     nueva (ADR-010) y que hasta ahora **no leía nadie**;
 *   · `assertCanReadProgress` — la regla de quién puede mirar el progreso de
 *     quién (la suya, o cualquiera si es administración), que tampoco se usaba;
 *   · `summarizeArchived` y `sortHistory` — el resumen y el orden, puros y
 *     compartidos por demo y Firestore.
 *
 * Lo que devuelve es un resumen para leer, no el objeto de progreso completo:
 * ni documentos leídos, ni respuestas de intentos, ni claves.
 *
 * Aviso honesto: el archivo se crea de forma perezosa, la primera vez que la
 * persona toca el curso después de publicarse la versión nueva. Hasta que eso
 * ocurre, la entrada todavía no existe en `progressHistory`.
 */

export interface CourseHistoryEntry {
  courseId: string;
  /** Título de la versión archivada; si ya no está, el del curso. */
  courseTitle: string;
  version: number;
  completed: boolean;
  completedAt: string | null;
  archivedAt: string | null;
  topicsPassed: number;
  topicsTotal: number;
  finalScore: number;
  finalExamPassed: boolean;
  /** ¿Sigue habiendo una versión publicada distinta de la archivada? */
  supersededBy: number | null;
}

export interface HistoryDependencies {
  learning: LearningStore;
  catalog: CourseCatalogStore;
}

export interface HistoryResult {
  entries: CourseHistoryEntry[];
  /** Entradas archivadas que no se pudieron resolver a un curso existente. */
  unresolved: number;
}

/** Tope de entradas devueltas: una por curso y versión, no hace falta más. */
const HISTORY_LIMIT = 50;

async function resolveEntry(
  progress: ArchivedProgress,
  deps: HistoryDependencies,
): Promise<CourseHistoryEntry> {
  const summary = summarizeArchived(progress);

  const course = await deps.catalog.getCourse(progress.courseId);
  const archivedVersion = await deps.catalog.getVersion(progress.courseId, progress.version);

  return {
    ...summary,
    // El título de la versión archivada es el que la persona vio; el del curso
    // cambia con cada publicación y no debe reescribir el pasado.
    courseTitle: archivedVersion?.title ?? course?.title ?? progress.courseId,
    supersededBy:
      course?.publishedVersion != null && course.publishedVersion !== progress.version
        ? course.publishedVersion
        : null,
  };
}

async function historyOf(
  uid: string,
  deps: HistoryDependencies,
): Promise<HistoryResult> {
  const archived = await deps.learning.listArchivedProgress(uid);

  const ordered = sortHistory(
    archived.filter((item) => item.uid === uid && item.courseId && Number.isInteger(item.version)),
  ).slice(0, HISTORY_LIMIT);

  const entries: CourseHistoryEntry[] = [];
  let unresolved = 0;

  for (const progress of ordered) {
    const course = await deps.catalog.getCourse(progress.courseId);
    if (!course) {
      // Un curso eliminado del catálogo no debe romper el historial de nadie:
      // se cuenta y se sigue. El histórico no se inventa ni se rellena.
      unresolved += 1;
      continue;
    }
    entries.push(await resolveEntry(progress, deps));
  }

  return { entries, unresolved };
}

/** Historial del propio alumno. */
export async function learnerHistory(
  deps: HistoryDependencies,
  actor: Actor | null | undefined,
): Promise<HistoryResult> {
  const active = assertActiveAccount(actor);
  return historyOf(active.uid, deps);
}

/**
 * Historial de una persona concreta.
 *
 * La autorización es la del dominio: cada persona ve el suyo; administración
 * ve el de cualquiera. Un alumno que cambie el uid en la URL recibe 403.
 */
export async function accountHistory(
  deps: HistoryDependencies,
  input: { actor: Actor | null | undefined; uid: string },
): Promise<HistoryResult> {
  const active = assertActiveAccount(input.actor);
  const uid = (input.uid ?? "").trim();
  // Un uid vacío no autoriza nada: se trata como cuenta inexistente en vez de
  // dejar que una consulta ancha devuelva el archivo de todo el mundo.
  if (!uid) throw new DomainError("ACCOUNT_NOT_FOUND", "La cuenta no existe.", 404);
  assertCanReadProgress(active, uid);
  return historyOf(uid, deps);
}
