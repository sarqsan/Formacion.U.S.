/**
 * ESPACIADO DE LLAMADAS POR CUOTA (servidor)
 * ==========================================
 *
 * El tramo gratuito de Groq limita **tokens por minuto** (8 000 en el modelo
 * grande). Un temario de 40 páginas son unos 20 000 tokens de entrada, así que
 * no cabe en una sola llamada ni en dos seguidas: hay que trocear y **esperar**.
 *
 * Este módulo lleva la cuenta de lo enviado en los últimos 60 s y calcula la
 * espera necesaria antes de la siguiente llamada. Es deliberadamente
 * conservador: prefiere tardar treinta segundos más que comerse un 429 a mitad
 * de un curso.
 *
 * `now` y `sleep` se inyectan para que las pruebas no esperen de verdad.
 */

export interface PacerOptions {
  /** Tokens que permite el plan en un minuto. */
  tokensPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Pacer {
  /**
   * Espera lo necesario para que quepa `tokens`. Devuelve los milisegundos
   * esperados (0 si no hubo que esperar), para poder probarlo y registrarlo.
   */
  wait(tokens: number): Promise<number>;
  /** Suma tokens ya gastados (después de la llamada, con el uso real si se conoce). */
  record(tokens: number): void;
  /** Tokens contabilizados ahora mismo en la ventana. */
  pending(): number;
}

const WINDOW_MS = 60_000;

export function createPacer(options: PacerOptions): Pacer {
  const limit = Math.max(1, Math.floor(options.tokensPerMinute));
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let window: Array<{ at: number; tokens: number }> = [];

  function prune(at: number): void {
    window = window.filter((entry) => at - entry.at < WINDOW_MS);
  }

  function sum(entries: Array<{ tokens: number }>): number {
    return entries.reduce((total, entry) => total + entry.tokens, 0);
  }

  return {
    async wait(tokens: number): Promise<number> {
      const wanted = Math.max(0, Math.round(tokens));
      // Una sola llamada mayor que el minuto entero no se puede espaciar: se
      // deja pasar (el 429 lo explicará) en vez de dormir para siempre.
      if (wanted >= limit) return 0;

      let waited = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const at = now();
        prune(at);
        if (sum(window) + wanted <= limit) return waited;

        // Hay que esperar a que caduque lo más antiguo de la ventana.
        const oldest = window[0];
        const ms = Math.max(250, WINDOW_MS - (at - oldest.at) + 50);
        await sleep(ms);
        waited += ms;
      }
      return waited;
    },

    record(tokens: number): void {
      const amount = Math.max(0, Math.round(tokens));
      if (amount === 0) return;
      const at = now();
      prune(at);
      window.push({ at, tokens: amount });
    },

    pending(): number {
      prune(now());
      return sum(window);
    },
  };
}
