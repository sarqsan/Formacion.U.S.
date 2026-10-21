import { cookies } from "next/headers";
import type { Actor } from "@/domain/auth/authorization";
import { demoAccountByUid } from "@/demo/store";

/**
 * SESIÓN DE LA DEMOSTRACIÓN
 * =========================
 *
 * Se usa **solo** con `DEMO_MODE=1`. Es una cookie con el uid de una cuenta
 * inventada; no hay contraseña, ni token firmado, ni Firebase Authentication.
 *
 * Por eso mismo:
 *   · la cabecera de todas las páginas avisa de que es una demostración;
 *   · `getUiSession` no la confunde nunca con una sesión real (modo `demo`);
 *   · las rutas de API reales (`/api/*`) NO aceptan esta cookie: siguen
 *     exigiendo la cookie de sesión de Firebase.
 */

export const DEMO_COOKIE = "formacion_demo";

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** ¿Hay configuración suficiente para hablar con Firebase de verdad? */
export function isFirebaseConfigured(): boolean {
  const hasProject = Boolean(process.env.FIREBASE_PROJECT_ID);
  const hasEmulator = Boolean(
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST,
  );
  const hasCredentials = Boolean(
    process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY,
  );
  return hasProject && (hasEmulator || hasCredentials);
}

/** Una cuenta de demostración solo vale si está activa. */
export async function getDemoActor(): Promise<Actor | null> {
  if (!isDemoMode()) return null;

  const cookieStore = await cookies();
  const uid = cookieStore.get(DEMO_COOKIE)?.value;
  if (!uid) return null;

  const account = demoAccountByUid(uid);
  if (!account || account.status !== "active") return null;

  return { uid: account.uid, role: account.role, status: account.status };
}

export type UiSessionMode = "demo" | "firebase" | "unconfigured";

export interface UiSession {
  mode: UiSessionMode;
  actor: Actor | null;
  /** Motivo legible cuando no hay sesión utilizable. */
  message?: string;
}

/**
 * Resuelve la sesión para las páginas.
 *
 * - `demo`:    `DEMO_MODE=1` y cookie de demostración.
 * - `firebase`: Firebase configurado; se usa la sesión real.
 * - `unconfigured`: no hay Firebase ni demostración; las páginas deben
 *   explicarlo, no romperse.
 */
export async function getUiSession(): Promise<UiSession> {
  if (isDemoMode()) {
    return { mode: "demo", actor: await getDemoActor() };
  }

  if (!isFirebaseConfigured()) {
    return {
      mode: "unconfigured",
      actor: null,
      message:
        "Esta instalación no tiene Firebase configurado. Para ver la aplicación con datos de prueba, arranca con DEMO_MODE=1.",
    };
  }

  try {
    const { getActor } = await import("@/server/auth/session");
    return { mode: "firebase", actor: await getActor() };
  } catch {
    return {
      mode: "unconfigured",
      actor: null,
      message: "No se ha podido comprobar la sesión: falta configuración de Firebase.",
    };
  }
}
