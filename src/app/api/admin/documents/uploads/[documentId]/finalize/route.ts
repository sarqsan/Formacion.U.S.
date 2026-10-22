import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminFinalizePdfUpload } from "@/server/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents/uploads/{documentId}/finalize
 * Verifica (tamaño, partes y SHA-256) y **activa** el documento.
 *
 * Antes de esta llamada el documento está pendiente: no se sirve a nadie y solo
 * ocupa una reserva de cuota. Después, es un activo inmutable que puede
 * asociarse a un borrador.
 *
 * Es idempotente: repetir la finalización no cuenta la cuota dos veces ni
 * reescribe los bytes; devuelve `alreadyActive: true`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const { documentId } = await context.params;
    const result = await adminFinalizePdfUpload(actor, documentId);

    return jsonOk({
      alreadyActive: result.alreadyActive,
      chunks: result.chunks,
      upload: result.upload,
      usage: result.usage,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
