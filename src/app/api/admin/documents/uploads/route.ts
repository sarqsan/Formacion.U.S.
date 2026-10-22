import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { adminCreatePdfUpload } from "@/server/portal";
import { readCreateUploadBody } from "@/server/documents/request";
import { UPLOAD_PART_BYTES } from "@/domain/storage/pdf-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents/uploads
 * Abre una subida de PDF **por partes** y reserva su cuota.
 *
 * Cuerpo JSON con lo que el administrador declara: curso, versión, tema,
 * título, tamaño, páginas y SHA-256. No lleva bytes: el fichero se envía
 * después, parte a parte, para no chocar con el límite de cuerpo de las
 * funciones desplegadas.
 *
 * El **identificador del documento lo calcula el servidor** a partir del
 * contenido y del destino. El cliente no puede elegirlo, ni fijar su autor, ni
 * saltarse la reserva de presupuesto.
 *
 * Respuesta: `{ created, upload: { documentId, partsTotal, partsReceived,
 * state, percent, … }, partBytes }`.
 */
export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();

    const body = await readCreateUploadBody(request);
    const result = await adminCreatePdfUpload(actor, body);

    return jsonOk(
      {
        created: result.created,
        partBytes: UPLOAD_PART_BYTES,
        upload: result.upload,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
