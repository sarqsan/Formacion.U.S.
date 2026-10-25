import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { aiProposeTopicBatch } from "@/server/portal";
import { readAiBatchBody } from "@/server/courses/ai-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/courses/{courseId}/ai/topics/batch
 *
 * Procesa **una** tanda del temario: una llamada al modelo, sin guardar nada.
 * Devuelve los temas encontrados en ese tramo y cuánto hay que esperar antes de
 * pedir el siguiente (la cuota se mide por minuto).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();
    const { courseId } = await context.params;
    const body = await readAiBatchBody(request, "batch");

    const result = await aiProposeTopicBatch(actor, {
      courseId,
      version: body.version,
      from: body.from,
      to: body.to,
    });

    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
