"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/domain/text";
import type { CourseVersionDefinition, TopicDefinition } from "@/domain/courses/content";
import type { ImportPreview } from "@/domain/people/import-rows";
import { DEMO_COOKIE, getUiSession } from "@/demo/session";
import { demoAccountByUid, resetDemoState } from "@/demo/store";
import {
  adminEnroll,
  adminNewDraft,
  adminPublish,
  adminRevokeEnrollment,
  adminUpdateDraft,
  definitionOf,
  previewImport,
  readPage,
  submitQuiz,
} from "@/server/portal";
import type { Actor } from "@/domain/auth/authorization";

/**
 * ACCIONES DE SERVIDOR DE LA DEMOSTRACIÓN Y DE LA APLICACIÓN
 * ========================================================
 *
 * Las mutaciones que sí tienen lógica de negocio llaman a los servicios
 * reales (`submitAssessment`, `enrollStudent`, `publishCourseVersion`…). Aquí
 * solo se valida la sesión, se traducen errores a mensajes y se refresca la
 * vista.
 *
 * En modo real (`DEMO_MODE` sin definir), estas acciones se niegan: no hay
 * ninguna forma de tocar Firestore desde la demostración.
 */

export interface ActionResult {
  status: "idle" | "ok" | "error";
  message?: string;
  details?: string[];
}

/**
 * Actor de la sesión activa, sea real o de demostración.
 *
 * Quien decide si es válido es `getActor` (Firebase) o `getDemoActor`
 * (demostración); aquí no se fabrica ninguna identidad.
 */
async function actorOrNull(): Promise<Actor | null> {
  const session = await getUiSession();
  if (session.mode === "unconfigured") return null;
  return session.actor;
}

function errorMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return "No se ha podido completar la operación. Inténtalo de nuevo.";
}

// ---------------------------------------------------------------------------
// Sesión de demostración
// ---------------------------------------------------------------------------

export async function enterDemoSession(formData: FormData): Promise<void> {
  const uid = String(formData.get("uid") ?? "");
  const account = demoAccountByUid(uid);

  if (!account || account.status !== "active") {
    redirect("/login?demo=no-valido");
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: DEMO_COOKIE,
    value: uid,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  redirect(account.role === "admin" ? "/admin" : "/panel");
}

export async function exitDemoSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(DEMO_COOKIE);
  revalidatePath("/", "layout");
  redirect("/");
}

export async function resetDemo(): Promise<void> {
  resetDemoState();
  revalidatePath("/", "layout");
  redirect("/panel");
}

// ---------------------------------------------------------------------------
// Alumno
// ---------------------------------------------------------------------------

/** Marca una pantalla como leída y avanza a la siguiente. */
export async function readScreenAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  const courseId = String(formData.get("courseId") ?? "");
  const documentId = String(formData.get("documentId") ?? "");
  const page = Number(formData.get("page") ?? "1");

  if (!actor) redirect("/login");

  let topicId = "";
  let finished = false;
  let failure: string | null = null;

  try {
    const result = await readPage(actor, { courseId, documentId, page });
    finished = result.finished;
    topicId = result.topicId;
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure) {
    redirect(
      `/cursos/${encodeURIComponent(courseId)}/documentos/${encodeURIComponent(documentId)}?error=${encodeURIComponent(failure)}`,
    );
  }

  revalidatePath(`/cursos/${courseId}`, "layout");

  if (finished) {
    redirect(`/cursos/${encodeURIComponent(courseId)}/temas/${encodeURIComponent(topicId)}?lectura=completa`);
  }

  redirect(
    `/cursos/${encodeURIComponent(courseId)}/documentos/${encodeURIComponent(documentId)}?pantalla=${page + 1}`,
  );
}

export interface QuizResult extends ActionResult {
  passed?: boolean;
  correctCount?: number;
  totalQuestions?: number;
  score?: number;
  incorrectQuestionIds?: string[];
  courseCompleted?: boolean;
  finalExamUnlocked?: boolean;
}

/**
 * Corrige un cuestionario en el servidor.
 *
 * El formulario solo envía qué opciones se marcaron; la clave vive en el
 * almacén del servidor y la corrección la hace `gradeAttempt` a través de
 * `submitAssessment`.
 */
export async function submitQuizAction(
  _previous: QuizResult,
  formData: FormData,
): Promise<QuizResult> {
  const actor = await actorOrNull();
  if (!actor) {
    return { status: "error", message: "La sesión de demostración ha caducado. Vuelve a entrar." };
  }

  const courseId = String(formData.get("courseId") ?? "");
  const assessmentType = formData.get("assessmentType") === "final" ? "final" : "topic";
  const topicId = assessmentType === "topic" ? String(formData.get("topicId") ?? "") : undefined;
  const questionIds = formData.getAll("questionId").map(String);

  const answers = questionIds.map((questionId) => ({
    questionId,
    selectedOptionIds: formData.getAll(`q:${questionId}`).map(String),
  }));

  try {
    const result = await submitQuiz({
      actor,
      courseId,
      assessmentType,
      topicId,
      answers,
    });

    revalidatePath(`/cursos/${courseId}`, "layout");

    return {
      status: "ok",
      passed: result.passed,
      correctCount: result.correctCount,
      totalQuestions: result.totalQuestions,
      score: result.score,
      incorrectQuestionIds: result.incorrectQuestionIds,
      courseCompleted: result.courseCompleted,
      finalExamUnlocked: result.finalExamUnlocked,
      message: result.passed
        ? "Intento superado. Todas las respuestas son correctas."
        : `Todavía no: ${result.correctCount} de ${result.totalQuestions} respuestas correctas. Puedes repetirlo las veces que necesites.`,
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------

export async function enrollAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const uid = String(formData.get("uid") ?? "");
  const courseId = String(formData.get("courseId") ?? "");

  // Ojo: `redirect()` lanza una excepción propia de Next. Nunca va dentro del
  // try, o el catch la convertiría en un error de negocio.
  let failure: string | null = null;
  try {
    await adminEnroll(actor, uid, courseId);
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/matriculas");
  if (failure) redirect(`/admin/matriculas?error=${encodeURIComponent(failure)}`);
  redirect("/admin/matriculas?ok=matricula");
}

export async function revokeAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const uid = String(formData.get("uid") ?? "");
  const courseId = String(formData.get("courseId") ?? "");

  let failure: string | null = null;
  try {
    await adminRevokeEnrollment(actor, uid, courseId);
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/matriculas");
  if (failure) redirect(`/admin/matriculas?error=${encodeURIComponent(failure)}`);
  redirect("/admin/matriculas?ok=revocada");
}

/** Publica el borrador indicado (servicio real de publicación). */
export async function publishAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");

  let failure: string | null = null;
  try {
    await adminPublish(actor, courseId, version);
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/cursos");
  revalidatePath("/panel", "layout");

  if (failure) {
    redirect(`/admin/cursos/${courseId}?v=${version}&error=${encodeURIComponent(failure)}`);
  }
  redirect(`/admin/cursos/${courseId}?v=${version}&ok=publicada`);
}

/** Crea la siguiente versión (borrador) copiando la publicada. */
export async function newDraftAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const fromVersion = Number(formData.get("fromVersion") ?? "0");

  if (fromVersion <= 0) {
    redirect(`/admin/cursos/${courseId}?error=${encodeURIComponent("No se encontró la versión base.")}`);
  }

  let failure: string | null = null;
  let created: { courseId: string; version: number } | null = null;
  try {
    created = await adminNewDraft(actor, courseId, fromVersion);
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !created) {
    redirect(
      `/admin/cursos/${courseId}?error=${encodeURIComponent(failure ?? "No se pudo crear el borrador.")}`,
    );
  }

  redirect(`/admin/cursos/${courseId}?v=${created.version}&ok=borrador`);
}

/**
 * Guarda los cambios del editor de borrador.
 *
 * Solo se modifican los campos que gestiona la interfaz (título, descripción,
 * títulos y orden de temas, títulos y páginas de pantallas). Las preguntas se
 * conservan tal cual: cambiarlas cambia la clave de corrección y necesita una
 * revisión propia (ver hoja de ruta).
 */
export async function saveDraftAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const current = await definitionOf(actor, courseId, version);

  if (!current) {
    redirect(`/admin/cursos/${courseId}?error=${encodeURIComponent("La versión no existe.")}`);
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  const topics: TopicDefinition[] = current.topics.map((topic) => {
    const order = Number(formData.get(`topic:${topic.id}:order`) ?? topic.order);
    return {
      ...topic,
      title: String(formData.get(`topic:${topic.id}:title`) ?? topic.title).trim(),
      order: Number.isFinite(order) ? order : topic.order,
      documents: topic.documents.map((document) => {
        const pageCount = Number(formData.get(`doc:${document.id}:pages`) ?? document.pageCount);
        return {
          ...document,
          title: String(formData.get(`doc:${document.id}:title`) ?? document.title).trim(),
          pageCount: Number.isFinite(pageCount) ? pageCount : document.pageCount,
        };
      }),
    };
  });

  const updated: CourseVersionDefinition = {
    ...current,
    title,
    description: description || undefined,
    topics,
  };

  let failure: string | null = null;
  try {
    await adminUpdateDraft(actor, updated);
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/cursos");
  if (failure) {
    redirect(`/admin/cursos/${courseId}?v=${version}&error=${encodeURIComponent(failure)}`);
  }
  redirect(`/admin/cursos/${courseId}?v=${version}&ok=guardado`);
}

/** Comprueba el contenido de una versión y devuelve los problemas juntos. */
export async function validateDraftAction(formData: FormData): Promise<void> {
  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  redirect(`/admin/cursos/${courseId}?v=${version}&revisar=1`);
}

// ---------------------------------------------------------------------------
// Importación de Excel (vista previa)
// ---------------------------------------------------------------------------

export interface ImportPreviewState extends ActionResult {
  preview?: ImportPreview;
  skippedEmptyRows?: number;
}

/**
 * Vista previa de una importación de personas.
 *
 * Usa el lector de `.xlsx` real y el mismo análisis que la importación de
 * producción: valida Rol y Apellido, propone nombres de usuario y marca
 * duplicados. **No crea ninguna cuenta**: eso exige Firebase Authentication y
 * no forma parte de esta demostración.
 */
export async function importPreviewAction(
  _previous: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  const actor = await actorOrNull();
  if (!actor) {
    return { status: "error", message: "La sesión de demostración ha caducado. Vuelve a entrar." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Adjunta un archivo .xlsx con las columnas Rol y Apellido." };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { preview, skippedEmptyRows } = await previewImport(actor, buffer);

    return {
      status: "ok",
      preview,
      skippedEmptyRows,
      message: `${preview.summary.totalRows} filas leídas.`,
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
