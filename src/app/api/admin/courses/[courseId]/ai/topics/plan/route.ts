import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { aiTopicBatchPlan } from "@/server/portal";
import { readAiBatchBody } from "@/server/courses/ai-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/courses/{courseId}/ai/topics/plan
 *
 * Prepara la propuesta de temas **por tandas**: extrae el texto del PDF del
 * borrador, lo parte en trozos que quepan en una llamada y devuelve el plan.
 * No llama a la IA, así que no gasta cuota ni tarda.
 *
 * El navegador pide después una tanda por petición (`…/batch`) y, al terminar,
 * guarda el plan completo (`…/save`).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();
    const { courseId } = await context.params;
    const body = await readAiBatchBody(request, "plan");

    const plan = await aiTopicBatchPlan(actor, {
      courseId,
      version: body.version,
    });

    return jsonOk(plan);
  } catch (error) {
    return toErrorResponse(error);
  }
}
