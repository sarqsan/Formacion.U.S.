import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requireActor } from "@/server/auth/session";
import { importDependencies } from "@/server/deps";
import { readImportForm } from "@/server/import/request";
import { confirmImport } from "@/server/import/service";
import { getServerConfig } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/import/confirm
 * Recalcula la vista previa en servidor y crea las cuentas `learner`
 * pendientes de activación. Devuelve los tokens UNA sola vez.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);
    const actor = await requireActor();

    const { rows, resolutions } = await readImportForm(request);
    const result = await confirmImport({ rows, resolutions, actor }, importDependencies());

    return jsonOk({
      created: result.created,
      summary: result.preview.summary,
      notice:
        "Guarda estos códigos ahora: no se vuelven a mostrar. Se guarda solo su huella cifrada.",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
