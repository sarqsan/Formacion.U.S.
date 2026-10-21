import { toErrorResponse } from "@/server/http";
import { requireActor } from "@/server/auth/session";
import { documentDependencies } from "@/server/deps";
import { readPagesQuery } from "@/server/documents/request";
import { readDocumentPages } from "@/server/documents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/documents/{documentId}/pages?from=&to=
 *
 * Única forma de obtener bytes de un PDF. No hay Storage, no hay URL firmada y
 * no hay enlace público.
 *
 * Barreras (todas en servidor, ninguna delegada al cliente):
 *   1. sesión válida y cuenta activa;
 *   2. documento existente y no archivado;
 *   3. **matrícula activa** en el curso (publicar no da acceso);
 *   4. versión publicada (un alumno no lee borradores; un administrador sí);
 *   5. secuencia: `from` es exactamente la página siguiente a la última vista;
 *   6. rango ≤ 20 páginas y dentro del documento;
 *   7. límite de peticiones por usuario y global (coste = páginas pedidas).
 *
 * La respuesta va con `Cache-Control: no-store`, `nosniff` y tamaño exacto: ni
 * el navegador ni un proxy intermedio deben guardar el contenido.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await context.params;
    const actor = await requireActor();
    const { from, to } = readPagesQuery(request);

    const result = await readDocumentPages(
      { actor, documentId, from, to },
      documentDependencies(),
    );

    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.bytes.length),
        "Cache-Control": "no-store, max-age=0, private",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "X-Pdf-Pages-From": String(result.from),
        "X-Pdf-Pages-To": String(result.to),
        "X-Pdf-Total-Pages": String(result.totalPages),
        "X-Pdf-Next-Page": String(result.nextPage),
        "X-Pdf-Sha256": result.sha256,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
