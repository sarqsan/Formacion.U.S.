"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DomainError } from "@/domain/text";
import { getUiSession } from "@/demo/session";
import { issueCertificateFor } from "@/server/portal";

/**
 * EMISIÓN DE CERTIFICADOS (acción de servidor)
 * ============================================
 *
 * Un botón, un formulario, ninguna lógica de permisos aquí: el servicio
 * (`issueCertificate`) comprueba la sesión, que se pida lo propio o que quien
 * pide sea administración y que el curso esté realmente completado. Esta acción
 * solo traduce eso a una redirección legible.
 *
 * Se usa una acción y no un `GET` que emita: un enlace o una recarga del
 * navegador no deben crear documentos. La **descarga** del PDF sí es un `GET`,
 * porque el certificado ya existe.
 */

/** Solo rutas internas: evita que un campo del formulario lleve a otro dominio. */
function safeReturnPath(value: string | null, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

export async function issueCertificateAction(formData: FormData): Promise<void> {
  const session = await getUiSession();
  if (session.mode === "unconfigured" || !session.actor) redirect("/login");

  const actor = session.actor;
  const courseId = String(formData.get("courseId") ?? "");
  const uid = String(formData.get("uid") ?? actor.uid);
  const back = safeReturnPath(
    formData.get("volver") === null ? null : String(formData.get("volver")),
    actor.role === "admin" ? "/admin/progreso" : "/panel",
  );

  let code: string | null = null;
  let failure: string | null = null;

  try {
    const { record } = await issueCertificateFor(actor, { uid, courseId });
    code = record.code;
  } catch (error) {
    failure =
      error instanceof DomainError
        ? error.message
        : "No se ha podido emitir el certificado. Inténtalo de nuevo.";
  }

  // `redirect` lanza una excepción de control: fuera del `try`, para que el
  // `catch` de arriba no la confunda con un error del servicio.
  if (failure || !code) {
    redirect(`${back}?certificado=error&motivo=${encodeURIComponent(failure ?? "Error")}`);
  }

  revalidatePath(back);
  redirect(`/certificado/${code}`);
}
