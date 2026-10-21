import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requireActor } from "@/server/auth/session";
import { importDependencies } from "@/server/deps";
import { readImportForm } from "@/server/import/request";
import { buildImportPreview } from "@/server/import/service";
import { getServerConfig } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/import/preview
 * Devuelve la vista previa (válidas, errores, duplicados pendientes).
 * No escribe nada ni genera tokens.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);
    const actor = await requireActor();

    const { rows, resolutions } = await readImportForm(request);
    const { preview } = await buildImportPreview({ rows, resolutions, actor }, importDependencies());

    return jsonOk({ preview });
  } catch (error) {
    return toErrorResponse(error);
  }
}
