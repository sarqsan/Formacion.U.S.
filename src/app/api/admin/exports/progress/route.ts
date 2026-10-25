import { toErrorResponse } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { adminProgress } from "@/server/portal";
import { assertAdmin } from "@/domain/auth/authorization";
import { csvFilename } from "@/domain/exports/csv";
import { csvHeaders, progressCsv, type ProgressExportRow } from "@/server/exports/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/exports/progress
 *
 * Descarga una fila por matrícula con el progreso de cada persona. Solo
 * administración: la comprobación va **antes** de leer nada.
 *
 * Es de solo lectura, no modifica estado, y no hay parámetros que permitan
 * pedir datos de otra instalación: el alcance es lo que devuelve el servicio.
 */
export async function GET() {
  try {
    const actor = await requirePortalActor();
    assertAdmin(actor);

    const rows: ProgressExportRow[] = (await adminProgress(actor)).map((row) => ({
      username: row.username,
      personRol: row.personRol,
      courseTitle: row.courseTitle,
      courseId: row.courseId,
      status: row.status,
      percent: row.percent,
      topicsPassed: row.topicsPassed,
      topicsTotal: row.topicsTotal,
      finalExamPassed: row.finalExamPassed,
      completed: row.completed,
      pending: row.pending,
      attempts: row.attempts.length,
      enrolledAt: row.enrolledAt,
    }));

    return new Response(progressCsv(rows), {
      status: 200,
      headers: csvHeaders(csvFilename("progreso", new Date())),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
