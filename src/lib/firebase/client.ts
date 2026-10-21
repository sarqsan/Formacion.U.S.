"use client";

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  inMemoryPersistence,
  setPersistence,
  type Auth,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

/**
 * Firebase del navegador
 * ======================
 *
 * - Persistencia EN MEMORIA: el token no se guarda en localStorage ni en
 *   IndexedDB. La sesión real vive en una cookie httpOnly emitida por el
 *   servidor (`/api/auth/session`), imposible de leer desde JavaScript.
 * - El correo es sintético (`usuario@dominio.invalid`): el usuario solo
 *   escribe su nombre de usuario.
 * - Si falta configuración pública, se lanza un error controlado en lugar de
 *   intentar conectar a cualquier proyecto.
 */

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export interface PublicFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

export function getPublicFirebaseConfig(): PublicFirebaseConfig | null {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  };

  if (!config.apiKey || !config.authDomain || !config.projectId || !config.appId) {
    return null;
  }
  return config;
}

export async function getClientAuth(): Promise<Auth> {
  if (auth) return auth;

  const config = getPublicFirebaseConfig();
  if (!config) {
    throw new Error(
      "Firebase no está configurado en este entorno. Revisa las variables NEXT_PUBLIC_FIREBASE_*.",
    );
  }

  app = getApps().length > 0 ? getApps()[0] : initializeApp(config);
  auth = getAuth(app);
  await setPersistence(auth, inMemoryPersistence);
  return auth;
}

export function authEmailForUsername(username: string): string {
  const domain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN ?? "formacion.invalid";
  return `${username.trim().toLowerCase()}@${domain}`;
}

export interface LoginResult {
  ok: boolean;
  message?: string;
}

/** Inicia sesión y canjea el ID token por la cookie httpOnly del servidor. */
export async function loginWithUsername(username: string, password: string): Promise<LoginResult> {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername || !password) {
    return { ok: false, message: "Indica usuario y contraseña." };
  }

  let clientAuth: Auth;
  try {
    clientAuth = await getClientAuth();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Error de configuración." };
  }

  try {
    const credential = await signInWithEmailAndPassword(
      clientAuth,
      authEmailForUsername(cleanUsername),
      password,
    );
    const idToken = await credential.user.getIdToken(true);

    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });

    // El token ya no hace falta: la sesión está en la cookie httpOnly.
    await signOut(clientAuth).catch(() => undefined);

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      return {
        ok: false,
        message: data?.error?.message ?? "No se ha podido iniciar sesión.",
      };
    }

    return { ok: true };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    // Mensaje único: no se revela si el usuario existe.
    if (
      code === "auth/invalid-credential" ||
      code === "auth/user-not-found" ||
      code === "auth/wrong-password"
    ) {
      return { ok: false, message: "Usuario o contraseña incorrectos." };
    }
    if (code === "auth/too-many-requests") {
      return { ok: false, message: "Demasiados intentos. Espera unos minutos." };
    }
    if (code === "auth/user-disabled") {
      return { ok: false, message: "Esta cuenta está deshabilitada." };
    }
    return { ok: false, message: "No se ha podido iniciar sesión." };
  }
}

/**
 * Cierre de sesión.
 *
 * Se hacen las dos cosas: cerrar la sesión de Firebase en memoria (si seguía
 * abierta) y pedir al servidor que borre la cookie httpOnly. Borrar solo la
 * cookie dejaría la sesión de Firebase viva hasta recargar la página.
 */
export async function logout(): Promise<void> {
  if (auth) {
    await signOut(auth).catch(() => undefined);
  }
  await fetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
}
