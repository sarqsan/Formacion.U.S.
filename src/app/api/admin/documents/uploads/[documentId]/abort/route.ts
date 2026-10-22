import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminAbortPdfUpload } from "@/server/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents/uploads/{documentId}/abort
 * Cancela una subida incompleta y libera la cuota reservada.
 *
 * Es idempotente: cancelar dos veces no libera dos veces. Un documento ya
 * activo **no** se cancela (`UPLOAD_ALREADY_ACTIVE`): se archiva, para que no
 * se pueda borrar el contenido que el alumnado ya está usando.
 *
 * Los fragmentos se eliminan después de la transacción; la respuesta dice
 * cuántos se han borrado de verdad (`chunksDeleted`).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const { documentId } = await context.params;
    const result = await adminAbortPdfUpload(actor, documentId);

    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
