import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminAttachDocument } from "@/server/portal";
import { readAttachBody } from "@/server/documents/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents/{documentId}/attach
 * Asocia un documento **activo** al tema de un borrador.
 *
 * El curso, la versión y el tema los aporta el propio documento (se fijaron al
 * subirlo): el cliente solo manda la revisión que tenía abierta. Asociar dos
 * veces el mismo documento es idempotente.
 *
 * Un documento pendiente no se asocia (`DOCUMENT_NOT_READY`) y una versión
 * publicada tampoco (`VERSION_NOT_EDITABLE`).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const { documentId } = await context.params;
    const body = await readAttachBody(request);
    const result = await adminAttachDocument(actor, { documentId, ...body });

    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
