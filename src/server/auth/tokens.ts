import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOKENS DE ACTIVACIÓN
 * ====================
 *
 * - 32 bytes de entropía (256 bits) en base64url: no adivinables.
 * - En la base de datos se guarda SOLO el hash SHA-256, nunca el token.
 * - La comparación usa `timingSafeEqual` (aunque el hash ya elimina el riesgo
 *   de canal lateral sobre el token original).
 * - El token se consume una sola vez (campo `usedAt`).
 *
 * Nota: SHA-256 sin sal es suficiente aquí porque el token es aleatorio de
 * alta entropía (no es una contraseña humana); no hace falta un KDF lento.
 */

export const ACTIVATION_TOKEN_BYTES = 32;
const ACTIVATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateActivationToken(): string {
  return randomBytes(ACTIVATION_TOKEN_BYTES).toString("base64url");
}

export function isValidActivationTokenFormat(token: unknown): token is string {
  return typeof token === "string" && ACTIVATION_TOKEN_PATTERN.test(token);
}

export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function activationTokenMatches(token: string, storedHash: string): boolean {
  if (!isValidActivationTokenFormat(token)) return false;
  const computed = Buffer.from(hashActivationToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (computed.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(computed, stored);
}

export function activationExpiry(now: Date, ttlHours: number): Date {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new Error("TTL de activación no válido");
  }
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

/**
 * Contraseña temporal aleatoria. NO se entrega a nadie: con el flujo de
 * activación por token, la cuenta es inaccesible hasta que el usuario fija su
 * propia contraseña.
 */
export function generateUnusablePassword(): string {
  return randomBytes(48).toString("base64url");
}

/** Huella no reversible para comparar tokens de idempotencia en logs. */
export function shortFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
