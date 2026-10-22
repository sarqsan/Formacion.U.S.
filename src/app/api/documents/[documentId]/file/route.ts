import { toErrorResponse } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { documentFile } from "@/server/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/documents/{documentId}/file
 * PDF **completo** para el visor nativo del navegador.
 *
 * Es la puerta del alumnado y no se fía de la URL: el servicio comprueba la
 * cuenta, la matrícula activa, la versión publicada del curso y que el
 * documento esté **referenciado expresamente** en esa versión; después lee los
 * fragmentos, verifica el SHA-256 y solo entonces responde.
 *
 * Cabeceras pensadas para un fichero privado:
 *   · `application/pdf` y `Content-Disposition: inline` → el navegador lo abre
 *     con su visor (Android incluido) en lugar de descargarlo como binario;
 *   · `Cache-Control: no-store, private` → ni cachés compartidas ni disco;
 *   · `nosniff` y `Referrer-Policy: no-referrer` → sin adivinar el tipo ni
 *     filtrar la ruta al salir de la página;
 *   · ni huellas, ni rutas de almacén, ni metadatos internos en las cabeceras.
 *
 * Los errores son JSON seguros (`DOCUMENT_NOT_FOUND`, `COURSE_NOT_AUTHORIZED`,
 * `DOCUMENT_CORRUPTED`): no distinguen «no existe» de «no te corresponde».
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await context.params;
    const actor = await requirePortalActor();
    const file = await documentFile(actor, documentId);

    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `inline; filename="${file.filename}"`,
        "Cache-Control": "no-store, max-age=0, private",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
