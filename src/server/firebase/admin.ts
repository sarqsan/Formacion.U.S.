import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getServerConfig, normalizePrivateKey } from "@/server/config";
import { DomainError } from "@/domain/text";

/**
 * FIREBASE ADMIN (solo servidor)
 * ==============================
 *
 * Este proyecto es un Firebase PROPIO de Formación. No comparte proyecto,
 * credenciales ni datos con la aplicación de cuadrantes.
 *
 * - La inicialización es perezosa: `next build` y las pruebas no necesitan
 *   credenciales.
 * - Si falta configuración, cualquier acceso falla con 503 en lugar de
 *   arrancar con valores por defecto inseguros.
 * - Nunca se registran credenciales en logs.
 *
 * NO se inicializa Cloud Storage: el plan Spark no lo incluye y los PDF se
 * guardan fragmentados en Firestore (`src/server/documents`). Así una variable
 * de bucket olvidada no puede reabrir una dependencia de pago.
 */

let cachedApp: App | null = null;

export function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;

  const config = getServerConfig();
  const existing = getApps();

  if (existing.length > 0 && !config.usingEmulator) {
    cachedApp = getApp();
    return cachedApp;
  }

  const projectId = config.FIREBASE_PROJECT_ID;

  // Emuladores: credenciales ficticias, sin tocar producción.
  if (config.usingEmulator) {
    if (process.env.NODE_ENV === "production") {
      throw new DomainError(
        "SERVER_CONFIG_UNSAFE",
        "Los emuladores no están permitidos en producción.",
        503,
      );
    }
    cachedApp = initializeApp({ projectId }, "formacion-emulator");
    return cachedApp;
  }

  if (!config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
    throw new DomainError("SERVER_NOT_CONFIGURED", "Faltan credenciales de Firebase Admin.", 503);
  }

  cachedApp = initializeApp({
    projectId,
    credential: cert({
      projectId,
      clientEmail: config.FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(config.FIREBASE_PRIVATE_KEY),
    }),
  });

  return cachedApp;
}

export function getAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminDb() {
  return getFirestore(getFirebaseAdminApp());
}

/** Solo para pruebas: descarta la instancia memoizada. */
export function resetFirebaseAdminApp(): void {
  cachedApp = null;
}

export { applicationDefault };
