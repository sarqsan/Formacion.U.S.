import { cookies } from "next/headers";
import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import { assertSessionIssuable, resolveSession } from "@/domain/auth/actor";
import { getAdminAuth, getAdminDb } from "@/server/firebase/admin";
import { getServerConfig } from "@/server/config";

/**
 * SESIÓN
 * ======
 *
 * Modelo elegido: **cookie de sesión httpOnly emitida por el servidor** a
 * partir de un ID token de Firebase Authentication.
 *
 * - El cliente inicia sesión con el SDK de Firebase usando persistencia EN
 *   MEMORIA: no queda ningún token duradero en localStorage ni IndexedDB.
 * - El servidor verifica el ID token con `verifyIdToken` (comprueba firma,
 *   emisor, audiencia y caducidad con las claves públicas de Google).
 * - Se emite una cookie `__Host-…`/httpOnly/Secure/SameSite=Lax con
 *   `createSessionCookie`.
 * - En cada petición se verifica la cookie (`checkRevoked: true`) y además se
 *   lee el documento de cuenta: un usuario deshabilitado pierde el acceso
 *   inmediatamente, aunque su token siga siendo criptográficamente válido.
 * - `claimsVersion` en las Custom Claims permite invalidar sesiones cuando
 *   cambian rol o estado.
 *
 * Prohibido explícitamente: simular la sesión con `localStorage` (no se usa
 * ninguna marca de sesión en el cliente).
 */

export const SESSION_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface AccountDocument {
  uid: string;
  username: string;
  role: string;
  status: string;
  claimsVersion: number;
  personRol?: string;
}

export function sessionCookieName(): string {
  return getServerConfig().SESSION_COOKIE_NAME;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    name: sessionCookieName(),
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Verifica un ID token recién emitido y devuelve el uid. */
export async function verifyIdToken(idToken: string): Promise<{ uid: string }> {
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken, true);
    return { uid: decoded.uid };
  } catch {
    throw new DomainError("ID_TOKEN_INVALID", "Sesión no válida. Vuelve a iniciar sesión.", 401);
  }
}

/**
 * Canjea un ID token por una cookie de sesión.
 *
 * Cuatro comprobaciones, en este orden:
 *   1. el token se verifica con las claves públicas de Google y, además, se
 *      consulta si ha sido revocado (`checkRevoked`);
 *   2. el token debe ser **reciente** (≤ 5 minutos): así no se puede convertir
 *      en cookie un token viejo rescatado de un registro;
 *   3. la ficha de la cuenta se lee de Firestore y la política de sesión
 *      (`assertSessionIssuable`) exige que esté activa y que las claims
 *      coincidan con lo almacenado;
 *   4. solo entonces se emite la cookie.
 *
 * El paso 3 es el que evita dar una cookie a una cuenta pendiente o
 * deshabilitada que, por un fallo de provisionamiento, conserve un token
 * válido.
 */
export async function createSessionCookie(idToken: string): Promise<{
  value: string;
  maxAgeSeconds: number;
}> {
  let decoded: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decoded = await getAdminAuth().verifyIdToken(idToken, true);
  } catch {
    throw new DomainError("ID_TOKEN_INVALID", "Sesión no válida. Vuelve a iniciar sesión.", 401);
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - decoded.auth_time;
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw new DomainError(
      "ID_TOKEN_STALE",
      "La sesión ha caducado durante el inicio. Inténtalo de nuevo.",
      401,
    );
  }

  const snapshot = await getAdminDb().collection("accounts").doc(decoded.uid).get();
  const account = snapshot.exists
    ? { ...(snapshot.data() as Omit<AccountDocument, "uid">), uid: decoded.uid }
    : null;

  assertSessionIssuable(decoded as unknown as Record<string, unknown>, account);

  const maxAgeSeconds = getServerConfig().SESSION_TTL_HOURS * 60 * 60;
  const value = await getAdminAuth().createSessionCookie(idToken, {
    expiresIn: maxAgeSeconds * 1000,
  });

  return { value, maxAgeSeconds };
}

/**
 * Construye el `Actor` a partir de la cookie y del documento de cuenta.
 * Devuelve `null` si no hay sesión (no es un error).
 */
export async function getActor(): Promise<Actor | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(sessionCookieName())?.value ?? null;
  if (!value) return null;

  let uid: string;
  let tokenClaims: Record<string, unknown>;
  try {
    const decoded = await getAdminAuth().verifySessionCookie(value, true);
    uid = decoded.uid;
    tokenClaims = decoded as unknown as Record<string, unknown>;
  } catch {
    return null;
  }

  const snapshot = await getAdminDb().collection("accounts").doc(uid).get();
  if (!snapshot.exists) return null;

  const account = { ...(snapshot.data() as Omit<AccountDocument, "uid">), uid };

  // Toda la política de sesión vive en `resolveSession` (dominio puro), para
  // poder probarla sin Firebase: estado de la BD, versión de claims y
  // coherencia entre token y ficha.
  const resolution = resolveSession(
    {
      role: tokenClaims.role,
      status: tokenClaims.status,
      claimsVersion: tokenClaims.claimsVersion,
      personRol: tokenClaims.personRol,
    },
    account,
  );

  if (!resolution.ok) return null;

  return {
    uid: resolution.actor.uid,
    role: resolution.actor.role,
    status: resolution.actor.status,
  };
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) {
    throw new DomainError("UNAUTHENTICATED", "Debes iniciar sesión.", 401);
  }
  return actor;
}
