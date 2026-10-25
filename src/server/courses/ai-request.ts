import { z } from "zod";
import { DomainError } from "@/domain/text";
import { readJsonBody } from "@/server/http";

/**
 * CUERPO DE LAS PETICIONES DE «TEMAS POR TANDAS»
 * =============================================
 *
 * Tres acciones (`plan`, `batch` y `save`) comparten la misma forma básica:
 * qué borrador. Solo se aceptan los campos declarados aquí; cualquier otra cosa
 * que envíe el cliente se ignora.
 *
 * Los límites son deliberadamente estrechos: una petición no puede pedir un
 * rango de 10 000 páginas ni un plan de 5 000 temas. Si el cliente se equivoca,
 * el error es suyo y se ve en la respuesta, no en una función colgada.
 */

const courseKey = z.object({
  version: z.number().int().positive().max(10_000),
});

const batchKey = courseKey.extend({
  from: z.number().int().min(1).max(10_000),
  to: z.number().int().min(1).max(10_000),
});

const saveBody = courseKey.extend({
  expectedRevision: z.number().int().min(0).max(1_000_000),
  topics: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        pages: z.array(z.number().int().min(1).max(10_000)).max(10_000).optional(),
        summary: z.string().max(800).nullish(),
      }),
    )
    .max(400),
  notes: z.string().max(800).nullish(),
});

export interface AiPlanBody {
  version: number;
}

export interface AiBatchBody {
  version: number;
  from: number;
  to: number;
}

export interface AiSaveBody {
  version: number;
  expectedRevision: number;
  topics: unknown;
  notes?: string | null;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DomainError(
      "AI_REQUEST_INVALID",
      `La petición para ${what} no es válida${issue ? `: ${issue.path.join(".") || issue.code}` : ""}.`,
      400,
    );
  }
  return result.data;
}

export async function readAiBatchBody(
  request: Request,
  kind: "plan",
): Promise<AiPlanBody>;
export async function readAiBatchBody(
  request: Request,
  kind: "batch",
): Promise<AiBatchBody>;
export async function readAiBatchBody(
  request: Request,
  kind: "save",
): Promise<AiSaveBody>;
export async function readAiBatchBody(
  request: Request,
  kind: "plan" | "batch" | "save",
): Promise<AiPlanBody | AiBatchBody | AiSaveBody> {
  const body = await readJsonBody(request);

  if (kind === "plan") return parse(courseKey, body, "planificar las tandas");
  if (kind === "batch") {
    const parsed = parse(batchKey, body, "procesar una tanda");
    if (parsed.to < parsed.from) {
      throw new DomainError(
        "AI_REQUEST_INVALID",
        "El tramo pedido termina antes de empezar.",
        400,
      );
    }
    return parsed;
  }

  const parsed = parse(saveBody, body, "guardar los temas");
  return {
    version: parsed.version,
    expectedRevision: parsed.expectedRevision,
    topics: parsed.topics,
    notes: parsed.notes ?? null,
  };
}
