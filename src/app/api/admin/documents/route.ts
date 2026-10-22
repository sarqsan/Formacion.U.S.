import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminPdfStorage, adminUploadPdfDocument } from "@/server/portal";
import { readPdfUploadForm } from "@/server/documents/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents
 * Subida de un PDF en **una sola petición** (ficheros pequeños, hasta 8 MiB).
 *
 * No es una segunda vía de escritura: internamente abre la misma subida por
 * partes, reserva cuota, escribe los fragmentos, verifica el SHA-256 y activa
 * el documento. Si algo falla, cancela la subida para no dejar la reserva
 * colgada.
 *
 * La interfaz de administración usa la subida por partes (límite de cuerpo de
 * las funciones desplegadas); este endpoint queda para herramientas y pruebas.
 *
 * El identificador del documento lo calcula el servidor: cualquier
 * `documentId` que llegue en el formulario se ignora.
 */
export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const form = await readPdfUploadForm(request);
    const result = await adminUploadPdfDocument(actor, form);
    const usage = await adminPdfStorage(actor);

    return jsonOk({
      documentId: result.documentId,
      bytes: result.bytes,
      chunks: result.chunks,
      sha256: result.sha256,
      usage: {
        usedBytes: usage.usedBytes,
        reservedBytes: usage.reservedBytes,
        budgetBytes: usage.budgetBytes,
        percent: usage.percent,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * GET /api/admin/documents
 * Uso de la cuota de PDF: en uso, reservado por subidas pendientes y libre.
 *
 * La cuota es información de administración: no se muestra a un alumno y no
 * expone rutas ni fragmentos.
 */
export async function GET() {
  try {
    const usage = await adminPdfStorage(await requirePortalActor());
    return jsonOk({
      usedBytes: usage.usedBytes,
      reservedBytes: usage.reservedBytes,
      budgetBytes: usage.budgetBytes,
      freeBytes: usage.freeBytes,
      percent: usage.percent,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
