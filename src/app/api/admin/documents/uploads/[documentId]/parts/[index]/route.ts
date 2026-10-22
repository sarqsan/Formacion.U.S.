import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminPutPdfPart } from "@/server/portal";
import { readPartBytes } from "@/server/documents/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUT /api/admin/documents/uploads/{documentId}/parts/{index}
 * Guarda una parte del PDF (768 KiB como máximo, en orden).
 *
 * Los bytes van en el cuerpo como `application/octet-stream`, sin base64: el
 * navegador parte el fichero y envía cada trozo tal cual. El servidor comprueba
 * que la parte es la que toca, que mide exactamente lo esperado y —en la parte
 * 0— que el contenido empieza por `%PDF-`.
 *
 * Reenviar una parte ya guardada es idempotente si el contenido coincide; si no
 * coincide, se rechaza (`PDF_CHUNK_CONFLICT`): a mitad de una subida el fichero
 * no puede cambiar.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ documentId: string; index: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const { documentId, index } = await context.params;
    const bytes = await readPartBytes(request);
    const result = await adminPutPdfPart(actor, {
      documentId,
      index: Number(index),
      bytes,
    });

    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
