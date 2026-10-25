"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/domain/text";
import { getUiSession } from "@/demo/session";
import {
  aiConnectionStatus,
  aiGenerateFinalExam,
  aiGenerateQuiz,
  aiGenerateScreens,
  aiProposeTopics,
  aiStartCourse,
  adminDraftEditor,
  adminSaveDraftScreens,
} from "@/server/portal";
import { parseScreensForm } from "@/server/courses/screens-form";
import { MAX_AI_UPLOAD_BYTES } from "@/server/ai/config";
import type { Actor } from "@/domain/auth/authorization";

/**
 * ACCIONES DEL ASISTENTE «CREAR CURSO CON IA»
 * ===========================================
 *
 * Finas a propósito: validan la sesión, leen el formulario, llaman al servicio
 * correspondiente y vuelven a la pantalla con el resultado. Toda la decisión
 * (reglas del contenido, quién puede, qué se guarda) vive en los servicios.
 *
 * Dos invariantes que se ven aquí:
 *
 *   · `redirect()` de Next **lanza**; nunca va dentro del `try`, o el `catch`
 *     lo convertiría en un error de negocio.
 *   · ningún mensaje incluye la clave de Gemini ni el contenido del PDF.
 */

async function adminOrNull(): Promise<Actor | null> {
  const session = await getUiSession();
  if (session.mode === "unconfigured") return null;
  if (!session.actor || session.actor.role !== "admin") return null;
  return session.actor;
}

function errorMessage(error: unknown): string {
  if (error instanceof DomainError) {
    const details = error.details as { issues?: Array<{ message?: string }> } | undefined;
    const messages = (details?.issues ?? [])
      .map((issue) => issue.message)
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.join(" · ");
    return error.message;
  }
  return "No se pudo completar la operación. Inténtalo de nuevo.";
}

function back(courseId: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `/admin/cursos/${encodeURIComponent(courseId)}/ia?${search.toString()}`;
}

function fail(courseId: string, version: number, paso: string, message: string): never {
  redirect(back(courseId, { v: String(version), paso, error: message }));
}

// ---------------------------------------------------------------------------
// Estado de la conexión
// ---------------------------------------------------------------------------

export async function checkAiConnectionAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const returnTo = String(formData.get("returnTo") ?? "/admin/cursos/ia");

  let message: string;
  try {
    const status = await aiConnectionStatus({ force: true });
    message = status.message;
  } catch (error) {
    message = errorMessage(error);
  }

  const separator = returnTo.includes("?") ? "&" : "?";
  redirect(`${returnTo}${separator}comprobado=${encodeURIComponent(message)}`);
}

// ---------------------------------------------------------------------------
// Paso 1 · curso + PDF
// ---------------------------------------------------------------------------

export async function startAiCourseAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const pageCount = Number(formData.get("pageCount") ?? "0");
  const file = formData.get("pdf");

  const backToForm = (message: string): never =>
    redirect(`/admin/cursos/ia?error=${encodeURIComponent(message)}`);

  if (courseId === "" || title === "") backToForm("Indica el identificador y el título del curso.");
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    backToForm("Indica el número de páginas del PDF (lo muestra el lector de PDF).");
  }
  if (!(file instanceof File) || file.size === 0) backToForm("Adjunta el PDF del temario.");

  const pdf = file as File;
  // El navegador ya corta aquí: el asistente sube el PDF en una sola petición y
  // el despliegue no admite cuerpos mayores (ver `MAX_AI_UPLOAD_BYTES`). Es
  // mejor un aviso claro que un 413 del proveedor sin explicación.
  if (pdf.size > MAX_AI_UPLOAD_BYTES) {
    backToForm(
      `El PDF ocupa ${(pdf.size / (1024 * 1024)).toFixed(1)} MB y el asistente admite hasta ${Math.round(
        MAX_AI_UPLOAD_BYTES / (1024 * 1024),
      )} MB. Si el temario es mayor, prepáralo desde el editor del curso, que sube el PDF por partes.`,
    );
  }
  if (!pdf.name.toLowerCase().endsWith(".pdf")) {
    backToForm("El temario tiene que ser un archivo PDF.");
  }

  const bytes = new Uint8Array(await pdf.arrayBuffer());

  let started: Awaited<ReturnType<typeof aiStartCourse>> | null = null;
  let failure: string | null = null;
  try {
    started = await aiStartCourse(actor, {
      courseId,
      title,
      ...(description ? { description } : {}),
      pageCount,
      pdfBytes: bytes,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !started) {
    backToForm(failure ?? "No se pudo crear el curso.");
  }

  const result = started as Awaited<ReturnType<typeof aiStartCourse>>;
  revalidatePath("/admin/cursos");
  revalidatePath("/admin");

  redirect(back(result.courseId, { v: String(result.version), paso: "2", ok: "creado" }));
}

// ---------------------------------------------------------------------------
// Paso 2 · temas
// ---------------------------------------------------------------------------

export async function proposeTopicsAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const revision = Number(formData.get("revision") ?? "0");

  let failure: string | null = null;
  let proposed: Awaited<ReturnType<typeof aiProposeTopics>> | null = null;
  try {
    proposed = await aiProposeTopics(actor, { courseId, version, expectedRevision: revision });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !proposed) fail(courseId, version, "2", failure ?? "No se pudieron proponer temas.");

  const result = proposed as Awaited<ReturnType<typeof aiProposeTopics>>;
  revalidatePath(`/admin/cursos/${courseId}`);
  redirect(
    back(courseId, {
      v: String(version),
      paso: "2",
      ok: `temas-${result.topics.length}`,
      ...(result.notes ? { nota: result.notes } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Paso 3 · pantallas
// ---------------------------------------------------------------------------

export async function generateScreensAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const revision = Number(formData.get("revision") ?? "0");
  const topicId = String(formData.get("topicId") ?? "");
  const requested = Number(formData.get("requestedScreens") ?? "0");

  let failure: string | null = null;
  let generated: Awaited<ReturnType<typeof aiGenerateScreens>> | null = null;
  try {
    generated = await aiGenerateScreens(actor, {
      courseId,
      version,
      expectedRevision: revision,
      topicId,
      ...(Number.isInteger(requested) && requested > 0 ? { requestedScreens: requested } : {}),
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !generated) fail(courseId, version, "3", failure ?? "No se pudieron generar pantallas.");

  const result = generated as Awaited<ReturnType<typeof aiGenerateScreens>>;
  revalidatePath(`/admin/cursos/${courseId}`);
  redirect(back(courseId, { v: String(version), paso: "3", ok: `pantallas-${result.total}` }));
}

/** Guarda las correcciones manuales de las pantallas. */
export async function saveScreensAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const revision = Number(formData.get("revision") ?? "0");

  const editor = await adminDraftEditor(actor, courseId, version);
  if (!editor) fail(courseId, version, "3", "El borrador no existe.");

  let failure: string | null = null;
  let saved: Awaited<ReturnType<typeof adminSaveDraftScreens>> | null = null;
  try {
    const topicScreens = parseScreensForm(formData, {
      topics: editor!.topics.map((topic) => ({ id: topic.id, screens: topic.screens })),
    });
    // Las páginas citadas a mano también se comprueban contra el PDF: el tope
    // es el mayor número de páginas declarado por los documentos del borrador.
    const pageCount = editor!.topics
      .flatMap((topic) => topic.documentList.map((document) => document.pageCount))
      .reduce<number | null>((max, value) => (max === null || value > max ? value : max), null);

    saved = await adminSaveDraftScreens(actor, {
      courseId,
      version,
      expectedRevision: revision,
      topicScreens,
      pageCount,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !saved) fail(courseId, version, "3", failure ?? "No se pudieron guardar las pantallas.");

  const result = saved as Awaited<ReturnType<typeof adminSaveDraftScreens>>;
  revalidatePath(`/admin/cursos/${courseId}`);
  redirect(
    back(courseId, {
      v: String(version),
      paso: "3",
      ok: `pantallas-guardadas-${result.screens.total}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Paso 4 · cuestionarios
// ---------------------------------------------------------------------------

export async function generateQuizAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const revision = Number(formData.get("revision") ?? "0");
  const topicId = String(formData.get("topicId") ?? "");
  const questionCount = Number(formData.get("questionCount") ?? "5");
  const allowMultiple = formData.get("allowMultiple") !== null;

  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 25) {
    fail(courseId, version, "4", "El número de preguntas debe estar entre 1 y 25.");
  }

  let failure: string | null = null;
  let generated: Awaited<ReturnType<typeof aiGenerateQuiz>> | null = null;
  try {
    generated = await aiGenerateQuiz(actor, {
      courseId,
      version,
      expectedRevision: revision,
      topicId,
      questionCount,
      allowMultiple,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !generated) fail(courseId, version, "4", failure ?? "No se pudo generar el cuestionario.");

  const result = generated as Awaited<ReturnType<typeof aiGenerateQuiz>>;
  revalidatePath(`/admin/cursos/${courseId}`);
  redirect(
    back(courseId, {
      v: String(version),
      paso: "4",
      ok: `cuestionario-${result.topicId}-${result.questions.length}`,
    }),
  );
}

export async function generateFinalExamAction(formData: FormData): Promise<void> {
  const actor = await adminOrNull();
  if (!actor) redirect("/login");

  const courseId = String(formData.get("courseId") ?? "");
  const version = Number(formData.get("version") ?? "0");
  const revision = Number(formData.get("revision") ?? "0");
  const questionCount = Number(formData.get("questionCount") ?? "10");
  const allowMultiple = formData.get("allowMultiple") !== null;

  if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 25) {
    fail(courseId, version, "4", "El número de preguntas debe estar entre 1 y 25.");
  }

  let failure: string | null = null;
  let generated: Awaited<ReturnType<typeof aiGenerateFinalExam>> | null = null;
  try {
    generated = await aiGenerateFinalExam(actor, {
      courseId,
      version,
      expectedRevision: revision,
      questionCount,
      allowMultiple,
    });
  } catch (error) {
    failure = errorMessage(error);
  }

  if (failure || !generated) fail(courseId, version, "4", failure ?? "No se pudo generar el examen final.");

  const result = generated as Awaited<ReturnType<typeof aiGenerateFinalExam>>;
  revalidatePath(`/admin/cursos/${courseId}`);
  redirect(back(courseId, { v: String(version), paso: "4", ok: `examen-${result.questions.length}` }));
}
