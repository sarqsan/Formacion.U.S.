import { DomainError } from "@/domain/text";

/**
 * LÍMITE DE PETICIONES EN MEMORIA
 * ===============================
 *
 * Motivo concreto (informe de fase 5): el endpoint de PDF permitía pedir
 * fragmentos en bucle. Con 50 000 lecturas diarias de Firestore, ~7 000
 * descargas de un PDF de 5 MiB agotaban la cuota y **dejaban la aplicación
 * entera sin servicio** hasta medianoche del Pacífico. Un solo usuario podía
 * provocarlo sin ser administrador.
 *
 * Diseño, con sus límites honestos:
 *   - ventana deslizante en memoria, por usuario y global;
 *   - coste por operación (una página cuesta 1; una lectura completa del PDF
 *     cuesta `pageCount`, así no se puede "pagar" lo mismo por todo el fichero);
 *   - reloj inyectable para poder probarlo sin esperas;
 *   - **es por instancia**: con varios procesos detrás de un balanceador, el
 *     límite real se multiplica por el número de instancias. Para el
 *     despliegue previsto (un servidor propio) es suficiente; si algún día hay
 *     varias instancias, hay que moverlo a un almacén compartido.
 */

export interface LimitConfig {
  /** Peticiones (o coste) permitidas por ventana y usuario. */
  perUser: number;
  /** Peticiones (o coste) permitidas por ventana en total. */
  global: number;
  /** Duración de la ventana en milisegundos. */
  windowMs: number;
}

export interface LimitDecision {
  allowed: boolean;
  /** Coste que se cobraría (útil para pruebas y para el mensaje). */
  cost: number;
  remainingUser: number;
  remainingGlobal: number;
  /** Segundos hasta que la ventana libere espacio. */
  retryAfterSeconds: number;
}

export const PDF_WINDOW_LIMITS: LimitConfig = {
  perUser: 600,
  global: 6_000,
  windowMs: 60 * 60 * 1000,
};

/**
 * Activación de cuentas: 10 intentos por hora y dirección.
 *
 * No sustituye al token de 256 bits (que es lo que impide adivinar el código),
 * pero corta el sondeo masivo y el abuso del endpoint como oráculo.
 */
export const ACTIVATION_LIMITS: LimitConfig = {
  perUser: 10,
  global: 300,
  windowMs: 60 * 60 * 1000,
};

export const PDF_UPLOAD_LIMITS: LimitConfig = {
  perUser: 20,
  global: 120,
  windowMs: 60 * 60 * 1000,
};

interface Bucket {
  /** Marcas de tiempo de cada consumo, en orden creciente. */
  hits: Array<{ at: number; cost: number }>;
}

export class SlidingWindowLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly config: LimitConfig;
  private readonly clock: () => number;

  constructor(config: LimitConfig, clock: () => number = () => Date.now()) {
    this.config = config;
    this.clock = clock;
  }

  /**
   * Comprueba **sin consumir**. Permite decidir antes de hacer trabajo caro
   * (leer Firestore) y consumir solo si la operación se autoriza.
   */
  peek(key: string, cost = 1): LimitDecision {
    const now = this.clock();
    this.prune(now);

    const bucket = this.buckets.get(key);
    const userCost = bucket?.hits.reduce((sum, hit) => sum + hit.cost, 0) ?? 0;
    const globalCost = this.globalCost();

    const remainingUser = Math.max(0, this.config.perUser - userCost);
    const remainingGlobal = Math.max(0, this.config.global - globalCost);
    const allowed = cost <= remainingUser && cost <= remainingGlobal;

    return {
      allowed,
      cost,
      remainingUser,
      remainingGlobal,
      retryAfterSeconds: allowed ? 0 : this.retryAfterSeconds(bucket, now),
    };
  }

  /** Consume si hay margen; si no, lanza 429. */
  consumeOrThrow(key: string, cost = 1): void {
    const decision = this.peek(key, cost);
    if (!decision.allowed) {
      throw new DomainError(
        "RATE_LIMITED",
        "Has hecho demasiadas peticiones en poco tiempo. Espera unos minutos antes de continuar.",
        429,
        { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }
    this.consume(key, cost);
  }

  /** Consume sin comprobar (para pruebas o tras un `peek` aceptado). */
  consume(key: string, cost = 1): void {
    const now = this.clock();
    this.prune(now);
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits.push({ at: now, cost });
    this.buckets.set(key, bucket);
  }

  /** Solo para pruebas: reinicia el estado. */
  reset(): void {
    this.buckets.clear();
  }

  private globalCost(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.hits.reduce((sum, hit) => sum + hit.cost, 0);
    }
    return total;
  }

  private prune(now: number): void {
    const threshold = now - this.config.windowMs;
    for (const [key, bucket] of this.buckets) {
      const kept = bucket.hits.filter((hit) => hit.at > threshold);
      if (kept.length === 0) this.buckets.delete(key);
      else bucket.hits = kept;
    }
  }

  private retryAfterSeconds(bucket: Bucket | undefined, now: number): number {
    if (!bucket || bucket.hits.length === 0) return Math.ceil(this.config.windowMs / 1000);
    const oldest = bucket.hits[0].at;
    return Math.max(1, Math.ceil((oldest + this.config.windowMs - now) / 1000));
  }
}

/**
 * Limitadores compartidos por proceso. Se resuelven de forma perezosa para que
 * importar el módulo no cree estado en las pruebas.
 */
let pdfInstance: SlidingWindowLimiter | null = null;
let uploadInstance: SlidingWindowLimiter | null = null;
let activationInstance: SlidingWindowLimiter | null = null;

export function pdfLimiter(): SlidingWindowLimiter {
  pdfInstance ??= new SlidingWindowLimiter(PDF_WINDOW_LIMITS);
  return pdfInstance;
}

export function activationLimiter(): SlidingWindowLimiter {
  activationInstance ??= new SlidingWindowLimiter(ACTIVATION_LIMITS);
  return activationInstance;
}

export function uploadLimiter(): SlidingWindowLimiter {
  uploadInstance ??= new SlidingWindowLimiter(PDF_UPLOAD_LIMITS);
  return uploadInstance;
}

/** Solo para pruebas. */
export function resetLimiters(): void {
  pdfInstance = null;
  uploadInstance = null;
  activationInstance = null;
}
