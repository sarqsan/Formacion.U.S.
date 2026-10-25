"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/domain/text";
import {
  draftSavedRedirect,
  draftStartedRedirect,
  parseDraftStructureForm,
} from "@/server/courses/draft-form";
import { parseDraftQuizForm, quizSavedRedirect } from "@/server/courses/quiz-form";
import type { ImportPreview } from "@/domain/people/import-rows";
import { DEMO_COOKIE, getUiSession } from "@/demo/session";
import { demoAccountByUid, resetDemoState } from "@/demo/store";
import { groupPasswordForReading } from "@/server/auth/tokens";
import {
  accounts as listAllAccounts,
  adminCreateCourse,
  adminCreatePerson,
  adminDeleteCourse,
  adminDisableAccount,
  adminDraftEditor,
  adminEnableAccount,
  adminEnroll,
  adminEnrollMany,
  adminEnrollments,
  adminPublish,
  adminResetPassword,
  adminReissueActivationCode,
  adminRevokeEnrollment,
  adminSaveDraftAssessments,
  adminSaveDraftStructure,
  adminStartDraft,
  previewImport,
  readPage,
  readTopicScreen,
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
  if (error instanceof DomainError) {
    // Varios problemas a la vez (estructura del borrador, publicación): se
    // muestran todos, no solo el primero.
    const details = error.details as { issues?: Array<{ message?: string }> } | undefined;
    const messages = (details?.issues ?? [])
      .map((issue) => issue.message)
      .filter((message): message is string => Boolean(message));
    if (messages.length > 1) return messages.join(" · ");
    return error.message;
  }
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

/**
 * «Leído, continuar» en las pantallas de estudio de un tema.
 *
 * Igual que el lector de PDF: avanzar es una acción del servidor, que comprueba
 * la secuencia y guarda el progreso. Si la petición se sale del orden, vuelve a
 * la pantalla con el aviso en lugar de guardar nada.
 */
export async function readTopicScreenAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  const courseId = String(formData.get("courseId") ?? "");
  const topicId = String(formData.get("topicId") ?? "");
  const screen = Number(formData.get("screen") ?? "1");

  if (!actor) redirect("/login");

  const base = `/cursos/${encodeURIComponent(courseId)}/temas/${encodeURIComponent(topicId)}/pantallas`;
  let finished = false;
  let failure: string | null = null;

  try {
    const result = await readTopicScreen(actor, { courseId, topicId, screen });
    finished = result.finished;
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure) {
    redirect(`${base}?error=${encodeURIComponent(failure)}`);
  }

  revalidatePath(`/cursos/${courseId}`, "layout");

  if (finished) {
    redirect(`/cursos/${encodeURIComponent(courseId)}/temas/${encodeURIComponent(topicId)}?lectura=completa`);
  }

  redirect(`${base}?pantalla=${screen + 1}`);
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

/**
 * Crea un curso vacío (sin versiones).
 *
 * No crea ningún borrador ni publica: el curso existe y nada más. Si el
 * servidor rechaza la operación (identificador repetido o no válido), se
 * vuelve al formulario con el mensaje del servicio; no se informa de un alta
 * que no ha ocurrido.
 */
export async function createCourseAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  let failure: string | null = null;
  let created: { courseId: string } | null = null;
  try {
    created = await adminCreateCourse(actor, {
      courseId,
      title,
      ...(description ? { description } : {}),
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/cursos");
  revalidatePath("/admin");

  if (failure || !created) {
    redirect(
      `/admin/cursos/nuevo?error=${encodeURIComponent(failure ?? "No se pudo crear el curso.")}`,
    );
  }

  redirect(`/admin/cursos/${encodeURIComponent(created.courseId)}?ok=creado`);
}

/**
 * Elimina un curso en borrador.
 *
 * Exige escribir el identificador del curso: es la única operación del panel
 * que borra datos y un botón «eliminar» se pulsa sin querer. Si el curso tiene
 * algo colgando (versión publicada, matrículas, progreso, certificados) el
 * servicio lo rechaza y el mensaje vuelve a la ficha del curso.
 */
export async function deleteCourseAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const confirmation = String(formData.get("confirmation") ?? "");

  let failure: string | null = null;
  let deleted: { courseId: string; versions: number; documents: number } | null = null;
  try {
    deleted = await adminDeleteCourse(actor, { courseId, confirmation });
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/cursos");
  revalidatePath("/admin");
  revalidatePath("/panel", "layout");

  if (failure || !deleted) {
    redirect(
      `/admin/cursos/${encodeURIComponent(courseId)}?error=${encodeURIComponent(
        failure ?? "No se pudo eliminar el curso.",
      )}`,
    );
  }

  redirect(
    `/admin/cursos?ok=eliminado&curso=${encodeURIComponent(deleted.courseId)}&versiones=${
      deleted.versions
    }&documentos=${deleted.documents}`,
  );
}

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

/**
 * Abre el borrador del curso (lo crea si no existe) y lleva al editor.
 *
 * No publica, no exige contenido y no toca la versión publicada: si el curso ya
 * estaba publicado, el borrador es una copia profunda de esa versión.
 */
export async function startDraftAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const coursePath = `/admin/cursos/${encodeURIComponent(courseId)}`;

  let failure: string | null = null;
  let opened: Awaited<ReturnType<typeof adminStartDraft>> | null = null;
  try {
    opened = await adminStartDraft(actor, courseId);
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/cursos");
  revalidatePath(coursePath);

  if (failure || !opened) {
    redirect(`${coursePath}?error=${encodeURIComponent(failure ?? "No se pudo abrir el borrador.")}`);
  }

  redirect(
    draftStartedRedirect({ courseId, version: opened.version, created: opened.created }),
  );
}

/**
 * Guarda la estructura del borrador: título, descripción y temas.
 *
 * Acepta borradores incompletos (sin temas, sin cuestionarios, sin examen):
 * solo rechaza lo que rompe la estructura. La revisión viaja en el formulario y
 * el servicio la exige, de modo que dos pestañas no se pisan en silencio.
 *
 * Si el servidor rechaza el guardado, la persona vuelve al editor con el error:
 * nunca con un mensaje de éxito.
 */
export async function saveDraftAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const version = Number(formData.get("version") ?? "0");
  const expectedRevision = Number(formData.get("expectedRevision") ?? "0");
  const coursePath = `/admin/cursos/${encodeURIComponent(courseId)}`;

  if (!Number.isInteger(version) || version < 1) {
    redirect(`${coursePath}?error=${encodeURIComponent("No se indicó qué borrador guardar.")}`);
  }

  let failure: string | null = null;
  try {
    const view = await adminDraftEditor(actor, courseId, version);
    if (!view) {
      throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
    }

    const { structure } = parseDraftStructureForm(formData, view.topics);
    await adminSaveDraftStructure(actor, {
      courseId,
      version,
      expectedRevision: Number.isFinite(expectedRevision) ? expectedRevision : 0,
      structure,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath(`/admin/cursos/${encodeURIComponent(courseId)}/editar`);
  revalidatePath(coursePath);
  revalidatePath("/admin/cursos");

  // Un único punto de salida: sin confirmación del servicio, nunca hay «ok».
  redirect(draftSavedRedirect({ courseId, version, failure }));
}

/**
 * Guarda los cuestionarios de los temas y el examen final del borrador.
 *
 * Las preguntas se leen del almacén (no del formulario) y el formulario solo
 * aporta los cambios: así un campo manipulado no puede introducir una pregunta
 * que no existe. Las claves de corrección no viajan al navegador del alumnado,
 * pero sí a este formulario de administración, que es la única vía de edición.
 */
export async function saveQuizAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const version = Number(formData.get("version") ?? "0");
  const expectedRevision = Number(formData.get("expectedRevision") ?? "0");
  const coursePath = `/admin/cursos/${encodeURIComponent(courseId)}`;

  if (!Number.isInteger(version) || version < 1) {
    redirect(`${coursePath}?error=${encodeURIComponent("No se indicó qué borrador guardar.")}`);
  }

  let failure: string | null = null;
  try {
    const view = await adminDraftEditor(actor, courseId, version);
    if (!view) {
      throw new DomainError("VERSION_NOT_FOUND", "El borrador no existe.", 404);
    }

    const parsed = parseDraftQuizForm(formData, {
      topics: view.topics.map((topic) => ({ id: topic.id, quiz: topic.quiz })),
      finalExam: view.finalExam,
    });

    await adminSaveDraftAssessments(actor, {
      courseId,
      version,
      expectedRevision: Number.isFinite(expectedRevision) ? expectedRevision : 0,
      topicQuizzes: parsed.topicQuizzes,
      finalExam: parsed.finalExam,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath(`/admin/cursos/${encodeURIComponent(courseId)}/editar`);
  revalidatePath(coursePath);
  revalidatePath("/admin/cursos");

  redirect(quizSavedRedirect({ courseId, version, failure }));
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

// ---------------------------------------------------------------------------
// Administración de cuentas (bloque 09)
// ---------------------------------------------------------------------------

/**
 * Deshabilitar o reactivar una cuenta.
 *
 * Redirección con mensaje en lugar de estado: son operaciones de una sola vez y
 * la página tiene que volver a leer la ficha. El motivo es opcional y se guarda
 * en la auditoría; nunca se pide ni se muestra nada del código de activación.
 */
async function changeAccountStatus(
  formData: FormData,
  operation: "disable" | "enable",
): Promise<never> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const uid = String(formData.get("uid") ?? "").trim();
  const target = `/admin/personas/${encodeURIComponent(uid)}`;

  try {
    if (operation === "disable") {
      const reason = String(formData.get("reason") ?? "").trim();
      await adminDisableAccount(actor, uid, reason || null);
    } else {
      await adminEnableAccount(actor, uid);
    }
  } catch (error) {
    revalidatePath("/admin");
    revalidatePath("/admin/personas");
    redirect(`${target}?error=${encodeURIComponent(errorMessage(error))}`);
  }

  revalidatePath("/admin");
  revalidatePath("/admin/personas");
  revalidatePath(target);
  redirect(`${target}?ok=${operation === "disable" ? "deshabilitada" : "reactivada"}`);
}

export async function disableAccountAction(formData: FormData): Promise<void> {
  await changeAccountStatus(formData, "disable");
}

export async function enableAccountAction(formData: FormData): Promise<void> {
  await changeAccountStatus(formData, "enable");
}

export interface ReissueActivationState extends ActionResult {
  username?: string;
  /** El código, una sola vez. Se muestra aquí y no viaja en la URL. */
  token?: string;
  expiresAt?: string;
  revokedPrevious?: number;
}

/**
 * Reemite el código de activación de una cuenta pendiente.
 *
 * Devuelve el token en el estado de la acción (no en la URL ni en una cookie):
 * así no queda en el historial del navegador, en los registros del servidor ni
 * en un enlace que alguien pueda reenviar sin querer. El servicio guarda solo
 * el hash.
 */
export async function reissueActivationAction(
  _previous: ReissueActivationState,
  formData: FormData,
): Promise<ReissueActivationState> {
  const actor = await actorOrNull();
  if (!actor) {
    return { status: "error", message: "La sesión ha caducado. Vuelve a entrar." };
  }

  const uid = String(formData.get("uid") ?? "").trim();

  try {
    const reissued = await adminReissueActivationCode(actor, uid);
    revalidatePath("/admin");
    revalidatePath(`/admin/personas/${encodeURIComponent(uid)}`);
    return {
      status: "ok",
      username: reissued.username,
      token: reissued.token,
      expiresAt: reissued.expiresAt,
      revokedPrevious: reissued.revokedPrevious,
      message:
        reissued.revokedPrevious > 0
          ? `Código nuevo emitido; se anularon ${reissued.revokedPrevious} anterior(es).`
          : "Código nuevo emitido.",
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// P1: operaciones de administración sin terminal
// ---------------------------------------------------------------------------

export interface ResetPasswordState extends ActionResult {
  username?: string;
  /** La contraseña temporal, UNA vez. No viaja en la URL ni se guarda. */
  password?: string;
  /** La misma, agrupada para dictarla: `abcd-efgh-ijkl-mnop`. */
  passwordGrouped?: string;
  changedAt?: string;
}

/**
 * Restablece la contraseña de otra persona, generada por el servidor.
 *
 * Devuelve la contraseña en el estado de la acción (como el código de
 * activación), no en la URL: así no queda en el historial del navegador ni en
 * los registros del servidor. Quien administra la entrega en mano y la persona
 * la cambia en «Mi cuenta» la primera vez que entre.
 */
export async function resetPasswordAction(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const actor = await actorOrNull();
  if (!actor) {
    return { status: "error", message: "La sesión ha caducado. Vuelve a entrar." };
  }

  const uid = String(formData.get("uid") ?? "").trim();
  try {
    const result = await adminResetPassword(actor, uid);
    revalidatePath(`/admin/personas/${uid}`);
    return {
      status: "ok",
      username: result.username,
      password: result.password,
      passwordGrouped: groupPasswordForReading(result.password),
      changedAt: result.changedAt,
      message: "Contraseña restablecida. Las sesiones abiertas de esa cuenta se han cerrado.",
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export interface CreatePersonState extends ActionResult {
  username?: string;
  /** El código de activación, UNA vez. No se guarda en claro. */
  token?: string;
  expiresAt?: string;
}

/**
 * Da de alta a una persona suelta.
 *
 * El usuario lo calcula el servidor a partir del apellido y el rol, igual que
 * en la importación. La cuenta nace `pending_activation` y con rol `learner`:
 * este formulario no puede crear administradores.
 */
export async function createPersonAction(
  _previous: CreatePersonState,
  formData: FormData,
): Promise<CreatePersonState> {
  const actor = await actorOrNull();
  if (!actor) {
    return { status: "error", message: "La sesión ha caducado. Vuelve a entrar." };
  }

  const apellido = String(formData.get("apellido") ?? "").trim();
  const rol = String(formData.get("rol") ?? "").trim();

  try {
    const created = await adminCreatePerson(actor, { apellido, rol });
    revalidatePath("/admin/personas");
    return {
      status: "ok",
      username: created.username,
      token: created.activationToken,
      expiresAt: created.activationExpiresAt,
      message: "Cuenta creada. Todavía no puede entrar hasta que use el código.",
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Matricula en un curso a todo el alumnado activo que aún no lo esté.
 *
 * La lista **no se recibe del navegador**: se recalcula aquí a partir de las
 * cuentas y las matrículas reales. Un formulario manipulado no puede matricular
 * a quien no debe ni a una cuenta deshabilitada.
 */
export async function bulkEnrollAction(formData: FormData): Promise<void> {
  const actor = await actorOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  if (!courseId) redirect("/admin/matriculas?error=Indica%20el%20curso.");

  let failure: string | null = null;
  let summary = "";
  try {
    const [accounts, enrollments] = await Promise.all([
      listAllAccounts(actor),
      adminEnrollments(actor),
    ]);

    const already = new Set(
      enrollments
        .filter((row) => row.courseId === courseId && row.status === "active")
        .map((row) => row.uid),
    );
    const targetUids = accounts
      .filter((account) => account.role === "learner" && account.status === "active")
      .map((account) => account.uid)
      .filter((uid) => !already.has(uid));

    if (targetUids.length === 0) {
      summary = "No había nadie pendiente: todo el alumnado activo ya estaba matriculado.";
    } else {
      const result = await adminEnrollMany(actor, courseId, targetUids);
      summary =
        `${result.enrolled.length} matrícula(s) nueva(s)` +
        (result.failed.length > 0
          ? ` · ${result.failed.length} con error: ${result.failed[0]?.message ?? ""}`
          : "");
    }
  } catch (error) {
    failure = errorMessage(error);
  }

  revalidatePath("/admin/matriculas");
  revalidatePath("/admin");

  const message = failure ?? summary;
  redirect(`/admin/matriculas?${failure ? "error" : "ok"}=${encodeURIComponent(message)}`);
}
