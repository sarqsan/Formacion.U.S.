import { approximateTokens, chunkPages, renderPages, type PdfTextPage } from "@/server/ai/text";

/**
 * REPARTO DEL TEMARIO EN TANDAS
 * =============================
 *
 * El plan gratuito de Groq permite 8 000 tokens por minuto, y una función de
 * Vercel corta a los 300 s. Por eso **una petición = una llamada al modelo**, y
 * el documento se parte en tantas tandas como haga falta.
 *
 * Ventajas de partirlo desde aquí:
 *
 *   · el tamaño del PDF deja de ser el límite: 10, 60 o 200 páginas se procesan
 *     igual, solo con más tandas;
 *   · ninguna petición se acerca al corte de Vercel, porque cada una hace una
 *     sola llamada y no espera dentro del servidor;
 *   · la espera entre tandas la hace el navegador, que puede mostrar el avance
 *     real y no deja una función dormida consumiendo tiempo.
 *
 * Lo que sigue siendo un límite (y se dice en la pantalla) es el **tiempo
 * total**: cada tanda de ~8 000 tokens ocupa un minuto de cuota.
 */

/** Tokens de salida reservados por tanda (un JSON de temas ocupa menos). */
export const TOPIC_OUTPUT_TOKENS = 1_024;

/** Margen por tanda: instrucciones, formato del esquema y etiquetas de página. */
export const TOPIC_OVERHEAD_TOKENS = 400;

export interface TopicBatch {
  /** 0, 1, 2… en el orden del documento. */
  index: number;
  /** Primera y última página (números del PDF, desde 1). */
  from: number;
  to: number;
  pages: number[];
  chars: number;
  /** Estimación de tokens de entrada de esta tanda. */
  tokens: number;
}

export interface TopicBatchPlan {
  batches: TopicBatch[];
  totalPages: number;
  totalChars: number;
  /** Tokens por minuto aplicados (los del plan configurado). */
  tokensPerMinute: number;
}

/** Cuántos caracteres de texto caben en una llamada, con margen de cuota. */
export function batchInputChars(tokensPerMinute: number): number {
  const usable = Math.max(600, Math.floor(tokensPerMinute * 0.95) - TOPIC_OUTPUT_TOKENS - TOPIC_OVERHEAD_TOKENS);
  // ~4 caracteres por token en español.
  return usable * 4;
}

/**
 * Parte el texto del PDF en tandas que quepan en una llamada cada una.
 *
 * Se corta **por páginas enteras**: una frase partida es una cita que el modelo
 * no puede localizar. Una página que por sí sola supere el presupuesto va sola
 * en su tanda (y se avisa en la pantalla, porque esa tanda gastará dos minutos
 * de cuota en lugar de uno).
 */
export function planTopicBatches(
  pages: readonly PdfTextPage[],
  options: { tokensPerMinute: number },
): TopicBatchPlan {
  const tokensPerMinute = Math.max(1_000, Math.round(options.tokensPerMinute));
  const chunks = chunkPages(pages, batchInputChars(tokensPerMinute));

  const batches: TopicBatch[] = chunks.map((chunk, index) => ({
    index,
    from: chunk[0].page,
    to: chunk[chunk.length - 1].page,
    pages: chunk.map((page) => page.page),
    chars: chunk.reduce((total, page) => total + page.text.length, 0),
    tokens: approximateTokens(renderPages(chunk)) + TOPIC_OVERHEAD_TOKENS,
  }));

  return {
    batches,
    totalPages: pages.length,
    totalChars: pages.reduce((total, page) => total + page.text.length, 0),
    tokensPerMinute,
  };
}

/**
 * Espera que debe hacer el navegador antes de la siguiente tanda.
 *
 * Se calcula sobre los tokens **gastados de verdad** (los devuelve la API) y se
 * redondea hacia arriba: quedarse corto cuesta un 429 y un reintento manual.
 */
export function nextBatchDelayMs(usedTokens: number, tokensPerMinute: number): number {
  const perMinute = Math.max(1_000, Math.round(tokensPerMinute));
  const used = Math.max(0, Math.round(usedTokens));
  if (used === 0) return 1_000;
  // Una llamada mayor que el minuto entero se come la cuota: se espera el
  // minuto completo antes de intentarlo otra vez.
  return Math.min(65_000, Math.ceil((used / perMinute) * 60_000) + 750);
}

/** Estimación honesta del tiempo total, para no prometer milagros. */
export function estimatePlanSeconds(plan: TopicBatchPlan): number {
  const tokens = plan.batches.reduce(
    (total, batch) => total + batch.tokens + TOPIC_OUTPUT_TOKENS,
    0,
  );
  return Math.round((tokens / plan.tokensPerMinute) * 60);
}
