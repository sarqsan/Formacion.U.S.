import { toErrorResponse } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { certificateRecordFor } from "@/server/portal";
import { certificateFile } from "@/server/certificates/file";
import { requestOrigin } from "@/server/certificates/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/certificates/{code}/file
 * PDF del certificado, para el titular o para administración.
 *
 * El código **no es una contraseña**: se puede reenviar. Por eso el PDF, que
 * lleva el nombre completo, exige sesión iniciada y que esta sea la de la
 * persona certificada (o de administración). La verificación sin sesión se hace
 * en `/verificar/{code}`, que enseña el nombre enmascarado.
 *
 * `attachment` y no `inline`: un certificado se descarga para guardarlo o
 * imprimirlo; abrirlo en una pestaña no aporta nada y deja el PDF en el
 * historial del navegador.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await context.params;
    const actor = await requirePortalActor();
    const record = await certificateRecordFor(actor, code);
    const file = certificateFile(record, { baseUrl: await requestOrigin(request) });

    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store, max-age=0, private",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
