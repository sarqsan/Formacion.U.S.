import { describe, expect, it } from "vitest";
import {
  PDF_UPLOAD_LIMITS,
  PDF_WINDOW_LIMITS,
  SlidingWindowLimiter,
  pdfLimiter,
  resetLimiters,
  uploadLimiter,
} from "@/server/ratelimit/limiter";

/**
 * LIMITADOR DE PETICIONES
 * =======================
 *
 * Prueba real del reloj inyectable: no hay esperas, así que los casos de
 * ventana deslizante se ejecutan en milisegundos.
 *
 * Límite honesto que estas pruebas NO demuestran: el estado vive en memoria del
 * proceso. Con varias instancias, el límite efectivo se multiplica por el
 * número de instancias.
 */

function limiter(perUser = 5, global = 100, windowMs = 60_000) {
  let now = 1_000_000;
  const instance = new SlidingWindowLimiter({ perUser, global, windowMs }, () => now);
  return {
    instance,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe("ventana deslizante", () => {
  it("permite hasta el tope por usuario y luego deniega", () => {
    const { instance } = limiter(3);

    for (let index = 0; index < 3; index += 1) {
      expect(instance.peek("u1").allowed).toBe(true);
      instance.consume("u1");
    }

    expect(instance.peek("u1").allowed).toBe(false);
    expect(() => instance.consumeOrThrow("u1")).toThrow(/demasiadas peticiones/i);
  });

  it("el tope es por usuario: uno agotado no bloquea a otro", () => {
    const { instance } = limiter(2);

    instance.consumeOrThrow("u1");
    instance.consumeOrThrow("u1");
    expect(instance.peek("u1").allowed).toBe(false);

    expect(instance.peek("u2").allowed).toBe(true);
    instance.consumeOrThrow("u2");
  });

  it("la ventana se desliza: al pasar el tiempo vuelve a permitir", () => {
    const { instance, advance } = limiter(1, 100, 60_000);

    instance.consumeOrThrow("u1");
    expect(instance.peek("u1").allowed).toBe(false);

    advance(59_999);
    expect(instance.peek("u1").allowed).toBe(false);

    advance(2);
    expect(instance.peek("u1").allowed).toBe(true);
  });

  it("informa de cuántos segundos faltan para reintentar", () => {
    const { instance, advance } = limiter(1, 100, 60_000);

    instance.consumeOrThrow("u1");
    advance(15_000);

    const decision = instance.peek("u1");
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(45);

    try {
      instance.consumeOrThrow("u1");
    } catch (error) {
      expect((error as { status: number }).status).toBe(429);
      expect((error as { details?: unknown }).details).toEqual({ retryAfterSeconds: 45 });
    }
  });

  it("aplica también el tope global entre usuarios distintos", () => {
    const { instance } = limiter(100, 3);

    instance.consumeOrThrow("u1");
    instance.consumeOrThrow("u2");
    instance.consumeOrThrow("u3");

    // u4 no ha hecho nada, pero el total está agotado.
    expect(instance.peek("u4").allowed).toBe(false);
    expect(instance.peek("u4").remainingGlobal).toBe(0);
  });

  it("el consumo global baja cuando caducan las marcas antiguas", () => {
    const { instance, advance } = limiter(100, 2, 10_000);

    instance.consumeOrThrow("u1");
    instance.consumeOrThrow("u2");
    expect(instance.peek("u3").allowed).toBe(false);

    advance(10_001);
    expect(instance.peek("u3").allowed).toBe(true);
  });

  it("cobra por coste: una lectura completa cuesta lo que sus páginas", () => {
    const { instance } = limiter(20);

    expect(instance.peek("u1", 20).allowed).toBe(true);
    instance.consumeOrThrow("u1", 20);

    // Pedir 30 páginas de golpe nunca cabría; pedir 1 tampoco, ya sin margen.
    expect(instance.peek("u1", 1).allowed).toBe(false);
    expect(instance.peek("u1", 30).allowed).toBe(false);
  });

  it("no deja pasar una operación que no cabe entera (ni cobra parcial)", () => {
    const { instance } = limiter(10);
    instance.consume("u1", 8);

    expect(() => instance.consumeOrThrow("u1", 5)).toThrow();
    // No se ha consumido nada: quedan 2.
    expect(instance.peek("u1").remainingUser).toBe(2);
  });

  it("peek no consume", () => {
    const { instance } = limiter(1);

    for (let index = 0; index < 5; index += 1) {
      expect(instance.peek("u1").allowed).toBe(true);
    }
    expect(instance.peek("u1").remainingUser).toBe(1);
  });

  it("reset limpia el estado (solo para pruebas)", () => {
    const { instance } = limiter(1);
    instance.consumeOrThrow("u1");
    expect(instance.peek("u1").allowed).toBe(false);

    instance.reset();
    expect(instance.peek("u1").allowed).toBe(true);
  });
});

describe("límites configurados", () => {
  it("los topes de lectura y de subida son los declarados", () => {
    expect(PDF_WINDOW_LIMITS).toEqual({ perUser: 600, global: 6_000, windowMs: 3_600_000 });
    expect(PDF_UPLOAD_LIMITS).toEqual({ perUser: 20, global: 120, windowMs: 3_600_000 });
  });

  it("los singleton se crean una sola vez por proceso", () => {
    resetLimiters();
    expect(pdfLimiter()).toBe(pdfLimiter());
    expect(uploadLimiter()).toBe(uploadLimiter());
    expect(pdfLimiter()).not.toBe(uploadLimiter());

    const before = pdfLimiter();
    resetLimiters();
    expect(pdfLimiter()).not.toBe(before);
  });
});
