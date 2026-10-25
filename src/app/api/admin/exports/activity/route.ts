import { toErrorResponse } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { adminActivity } from "@/server/portal";
import { assertAdmin } from "@/domain/auth/authorization";
import { csvFilename } from "@/domain/exports/csv";
import { ACTIVITY_MAX_LIMIT } from "@/server/audit/activity";
import { activityCsv, csvHeaders } from "@/server/exports/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/exports/activity
 *
 * Descarga el registro de auditoría. Solo administración.
 *
 * El tope de filas es el mismo que el del servicio (`ACTIVITY_MAX_LIMIT`): una
 * exportación no puede convertirse en una consulta sin límite a la colección
 * entera. Lo que no cabe en el registro tampoco cabe en el fichero.
 */
export async function GET() {
  try {
    const actor = await requirePortalActor();
    assertAdmin(actor);

    const entries = await adminActivity(actor, ACTIVITY_MAX_LIMIT);

    return new Response(activityCsv(entries), {
      status: 200,
      headers: csvHeaders(csvFilename("actividad", new Date())),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
