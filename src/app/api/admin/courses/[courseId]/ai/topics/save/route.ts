import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requirePortalActor } from "@/server/portal/session";
import { configuredAppOrigin } from "@/server/config";
import { aiSaveProposedTopics } from "@/server/portal";
import { readAiBatchBody } from "@/server/courses/ai-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/courses/{courseId}/ai/topics/save
 *
 * Guarda el plan de temas completo, ya unido. Es el **único** momento en el que
 * el borrador cambia: hasta aquí, ni una escritura. El servidor sanea lo que
 * llega y lo valida con las reglas de siempre (páginas que existen, sin títulos
 * repetidos, sin pasar del máximo de temas).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    assertTrustedOrigin(request, configuredAppOrigin());
    const actor = await requirePortalActor();
    const { courseId } = await context.params;
    const body = await readAiBatchBody(request, "save");

    const result = await aiSaveProposedTopics(actor, {
      courseId,
      version: body.version,
      expectedRevision: body.expectedRevision,
      topics: body.topics,
      notes: body.notes,
    });

    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
