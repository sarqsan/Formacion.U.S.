import { createPrivateKey, type KeyObject } from "node:crypto";
import { checkPublicFirebaseConfig } from "@/server/firebase/public-config";
import { decideDemoMode } from "@/server/config/demo-gate";

/**
 * ¿ESTÁ ESTA INSTALACIÓN LISTA PARA HABLAR CON FIREBASE?
 * =====================================================
 *
 * Una sola pregunta, respondida **sin red y sin credenciales**: ¿qué le falta a
 * esta configuración para que la aplicación pueda conectarse al proyecto
 * `formacionus-63555`?
 *
 * Existe porque hoy la respuesta está repartida en tres sitios (el login, el
 * diagnóstico de CLI y `/api/health`) y cada uno mira una parte distinta:
 *
 *   · el **login** decidía con `isFirebaseConfigured()`, que solo mira las
 *     credenciales del servidor. Con las credenciales puestas y la app web sin
 *     registrar, el formulario aparecía y el error real («Firebase no está
 *     configurado en este entorno») saltaba al pulsar «Entrar», en el navegador
 *     y sin decir qué valor faltaba;
 *   · `check:firebase --config-only` valida **solo** la parte web, así que no
 *     sirve para comprobar las credenciales del servidor antes de tener la app
 *     web;
 *   · `/api/health` solo dice si `getServerConfig()` no ha lanzado.
 *
 * Aquí se comprueba todo lo que se puede comprobar **sin hablar con Google**:
 * presencia y forma de cada valor, que la clave privada sea un PEM RSA de
 * verdad, que cliente y servidor apunten al mismo proyecto, y que el
 * endurecimiento de producción no se haya quedado a medias. Nada de esto
 * demuestra que la conexión funcione: eso exige red y lo responde
 * `npm run check:firebase`.
 *
 * Reglas que cumple este módulo:
 *   · **no imprime secretos**: de la clave privada solo se dice si se puede
 *     leer; del correo, su dominio; del proyecto, su identificador (público);
 *   · **no escribe nada** y no importa nada de Firestore;
 *   · es **puro**: recibe el entorno y devuelve hallazgos. Se prueba sin red.
 */

export type ReadinessLevel = "PASSED" | "FAILED";

/**
 * Naturaleza del valor, para no tratar igual lo que se puede pegar en un chat
 * que lo que nunca debe salir del entorno privado:
 *
 *   · `publica`      → viaja en el bundle del navegador (apiKey, projectId…);
 *   · `secreta`      → credenciales de la cuenta de servicio (correo y clave);
 *   · `configuracion`→ se fija a mano y no es secreto (origen, cookie, cuota).
 */
export type ReadinessKind = "publica" | "secreta" | "configuracion";

export const KIND_LABEL: Record<ReadinessKind, string> = {
  publica: "pública",
  secreta: "SECRETA",
  configuracion: "configuración",
};

export interface ReadinessFinding {
  /** Identificador estable (el nombre de la variable o del grupo). */
  id: string;
  title: string;
  level: ReadinessLevel;
  /** Pública, secreta o configuración: decide dónde puede escribirse. */
  kind: ReadinessKind;
  detail: string;
  /** Qué hacer si falla. Sin secretos: solo la ruta y el nombre del valor. */
  fix?: string | null;
}

export interface FirebaseReadiness {
  /** Proyecto previsto de la aplicación. */
  expectedProject: string;
  /** Configuración del servidor (Admin SDK) utilizable. */
  serverReady: boolean;
  /** Configuración pública del SDK web utilizable (la necesita el login). */
  webReady: boolean;
  /** Ambas partes listas. No implica que la red ni los permisos funcionen. */
  ready: boolean;
  /**
   * La demostración se está usando de verdad: `DEMO_MODE=1` y fuera de
   * producción. En producción siempre es `false`, aunque la variable esté puesta.
   */
  demoMode: boolean;
  serverFindings: ReadinessFinding[];
  webFindings: ReadinessFinding[];
  /** Pasos concretos, en orden, para pasar de «incompleto» a «listo». */
  actions: string[];
}

export interface ReadinessOptions {
  expectedProject?: string;
}

export const DEFAULT_EXPECTED_PROJECT = "formacionus-63555";

type Env = Record<string, string | undefined>;

/**
 * Dominios de una cuenta de servicio de Google. Las claves de Firebase Admin
 * tienen correos del tipo `firebase-adminsdk-xxxxx@<proyecto>.iam.gserviceaccount.com`;
 * comparar solo con `gserviceaccount.com` avisaba en falso («no es el habitual»)
 * justo en la comprobación que se ejecuta con credenciales reales.
 */
const SERVICE_ACCOUNT_SUFFIXES = [".iam.gserviceaccount.com", ".gserviceaccount.com"];

function value(env: Env, name: string): string | null {
  const raw = env[name];
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

function normalizeKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** Intenta leer el PEM. Devuelve el tipo de clave o `null` si no es válido. */
function readKey(raw: string): KeyObject | null {
  try {
    return createPrivateKey(normalizeKey(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Servidor (Admin SDK)
// ---------------------------------------------------------------------------

function serverFindings(env: Env, expectedProject: string): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];

  const project = value(env, "FIREBASE_PROJECT_ID");
  const clientEmail = value(env, "FIREBASE_CLIENT_EMAIL");
  const privateKey = value(env, "FIREBASE_PRIVATE_KEY");
  const authEmulator = value(env, "FIREBASE_AUTH_EMULATOR_HOST");
  const firestoreEmulator = value(env, "FIRESTORE_EMULATOR_HOST");
  const usingEmulator = Boolean(authEmulator || firestoreEmulator);
  const production = value(env, "NODE_ENV") === "production";

  // ------------------------------------------------------------- proyecto
  if (!project) {
    findings.push({
      id: "FIREBASE_PROJECT_ID",
      title: "Proyecto de Firebase",
      level: "FAILED",
      kind: "publica",
      detail: "No está definido.",
      fix: `Añade FIREBASE_PROJECT_ID=${expectedProject} a .env.local (sin comillas).`,
    });
  } else if (project !== expectedProject) {
    findings.push({
      id: "FIREBASE_PROJECT_ID",
      title: "Proyecto de Firebase",
      level: "FAILED",
      kind: "publica",
      detail: `El proyecto configurado es «${project}» y el previsto es «${expectedProject}».`,
      fix: "No se reutiliza el Firebase de otra aplicación: corrige FIREBASE_PROJECT_ID.",
    });
  } else {
    findings.push({
      id: "FIREBASE_PROJECT_ID",
      title: "Proyecto de Firebase",
      level: "PASSED",
      kind: "publica",
      detail: `FIREBASE_PROJECT_ID=${project}`,
    });
  }

  // ---------------------------------------------------------- credenciales
  if (usingEmulator) {
    findings.push({
      id: "FIREBASE_CLIENT_EMAIL",
      title: "Credenciales de la cuenta de servicio",
      level: "PASSED",
      kind: "secreta",
      detail: `Modo emulador (${[authEmulator, firestoreEmulator].filter(Boolean).join(", ")}): no hacen falta credenciales.`,
    });
  } else if (!clientEmail || !privateKey) {
    const missing = [
      clientEmail ? null : "FIREBASE_CLIENT_EMAIL",
      privateKey ? null : "FIREBASE_PRIVATE_KEY",
    ].filter(Boolean);

    findings.push({
      id: "FIREBASE_CLIENT_EMAIL",
      title: "Credenciales de la cuenta de servicio",
      level: "FAILED",
      kind: "secreta",
      detail: `Faltan ${missing.join(" y ")}.`,
      // El correo y la clave NO se tratan igual: el correo puede ir a
      // `.env.local`; la clave es lo único verdaderamente secreto del proyecto.
      fix:
        "Consola de Firebase → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada. " +
        "client_email puede ir a .env.local; FIREBASE_PRIVATE_KEY va SOLO al entorno privado del proceso " +
        "(variables del proveedor de despliegue), nunca al chat, a un commit ni a un fichero compartido.",
    });
  } else {
    const domain = clientEmail.split("@")[1] ?? "";
    const looksLikeServiceAccount = SERVICE_ACCOUNT_SUFFIXES.some((suffix) =>
      domain.endsWith(suffix),
    );
    findings.push({
      id: "FIREBASE_CLIENT_EMAIL",
      title: "Credenciales de la cuenta de servicio",
      level: "PASSED",
      kind: "secreta",
      detail: looksLikeServiceAccount
        ? `Cuenta de servicio (${domain}).`
        : `Correo con dominio «${domain}», que no es el habitual de una cuenta de servicio (*.iam.gserviceaccount.com): revisa que hayas copiado client_email.`,
    });
  }

  // ------------------------------------------------------- clave privada
  if (privateKey && !usingEmulator) {
    const key = readKey(privateKey);
    if (!key) {
      findings.push({
        id: "FIREBASE_PRIVATE_KEY",
        title: "Clave privada legible",
        level: "FAILED",
        kind: "secreta",
        detail: "FIREBASE_PRIVATE_KEY no es un PEM válido.",
        fix: 'Pega la clave entre comillas dobles conservando los \\n: FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n".',
      });
    } else if (key.asymmetricKeyType !== "rsa") {
      findings.push({
        id: "FIREBASE_PRIVATE_KEY",
        title: "Clave privada legible",
        level: "FAILED",
        kind: "secreta",
        detail: `El PEM se lee, pero es de tipo «${key.asymmetricKeyType ?? "desconocido"}» y la clave de servicio es RSA.`,
        fix: "Vuelve a descargar la clave desde la consola: es un JSON con private_key RSA (PKCS#8).",
      });
    } else {
      findings.push({
        id: "FIREBASE_PRIVATE_KEY",
        title: "Clave privada legible",
        level: "PASSED",
        kind: "secreta",
        detail: "PEM RSA correcto (no se muestra la clave).",
      });
    }
  }

  // ------------------------------------------- endurecimiento de producción
  if (production) {
    const origin = value(env, "APP_ORIGIN");
    let originOk = false;
    if (origin) {
      try {
        const parsed = new URL(origin);
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
        originOk = parsed.protocol === "https:" || local;
      } catch {
        originOk = false;
      }
    }

    findings.push({
      id: "APP_ORIGIN",
      title: "Origen público (producción)",
      level: originOk ? "PASSED" : "FAILED",
      kind: "configuracion",
      detail: !origin
        ? "Falta APP_ORIGIN: en producción la aplicación no arranca sin él."
        : originOk
          ? `Origen válido para producción (${new URL(origin).protocol}).`
          : "APP_ORIGIN debe ser https fuera de local.",
      fix: originOk ? null : "Define APP_ORIGIN=https://tu-dominio (sin barra final).",
    });

    const cookie = value(env, "SESSION_COOKIE_NAME") ?? "formacion_session";
    const cookieOk = cookie.startsWith("__Host-");
    findings.push({
      id: "SESSION_COOKIE_NAME",
      title: "Cookie de sesión (producción)",
      level: cookieOk ? "PASSED" : "FAILED",
      kind: "configuracion",
      detail: cookieOk
        ? `Prefijo __Host- presente (${cookie}).`
        : `«${cookie}» no empieza por __Host-: un subdominio podría sobrescribirla.`,
      fix: cookieOk ? null : "Usa SESSION_COOKIE_NAME=__Host-formacion_session en producción.",
    });

    const demo = decideDemoMode(env);
    if (demo.reason === "production") {
      // No es un fallo de funcionamiento —la aplicación sigue con Firebase— pero
      // sí una configuración que hay que quitar: en producción la demostración
      // entra sin contraseña y está cerrada por el candado.
      findings.push({
        id: "DEMO_MODE_IN_PRODUCTION",
        title: "Demostración fuera de producción",
        level: "FAILED",
        kind: "configuracion",
        detail:
          "Hay DEMO_MODE=1 con NODE_ENV=production. La demostración NO se está usando (no hay acceso sin contraseña), porque el candado la ignora fuera de desarrollo.",
        fix: "Quita DEMO_MODE de las variables del despliegue: la aplicación funciona sin ella.",
      });
    }

    if (usingEmulator) {
      findings.push({
        id: "EMULATOR_IN_PRODUCTION",
        title: "Emuladores fuera de producción",
        level: "FAILED",
        kind: "configuracion",
        detail: "Hay variables de emulador definidas con NODE_ENV=production: la aplicación se negará a arrancar.",
        fix: "Vacía FIREBASE_AUTH_EMULATOR_HOST y FIRESTORE_EMULATOR_HOST fuera del entorno local.",
      });
    }
  }

  // ------------------------------------------------------- cuota de PDF
  const budget = value(env, "PDF_STORAGE_BUDGET_MB");
  if (budget !== null) {
    const numeric = Number(budget);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      findings.push({
        id: "PDF_STORAGE_BUDGET_MB",
        title: "Presupuesto de PDF",
        level: "FAILED",
        kind: "configuracion",
        detail: `«${budget}» no es un número de MiB positivo.`,
        fix: "Usa un entero, por ejemplo PDF_STORAGE_BUDGET_MB=512.",
      });
    } else {
      findings.push({
        id: "PDF_STORAGE_BUDGET_MB",
        title: "Presupuesto de PDF",
        level: "PASSED",
        kind: "configuracion",
        detail: `${numeric} MiB (se acota al máximo seguro de la cuota gratuita).`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Evaluación completa
// ---------------------------------------------------------------------------

/**
 * Evalúa la configuración sin red. `ready` **no** significa «conectado»:
 * significa que no falta nada por rellenar y que la clave tiene forma válida.
 */
export function assessFirebaseReadiness(
  env: Env,
  options: ReadinessOptions = {},
): FirebaseReadiness {
  const expectedProject = options.expectedProject ?? DEFAULT_EXPECTED_PROJECT;

  const server = serverFindings(env, expectedProject);
  const publicCheck = checkPublicFirebaseConfig(env);
  const web: ReadinessFinding[] = publicCheck.issues.map((issue) => ({
    id: issue.field,
    title: issue.field,
    level: issue.ok ? "PASSED" : "FAILED",
    // La configuración web no es secreta: viaja en el bundle del navegador.
    kind: "publica",
    detail: issue.detail,
    fix: issue.fix ?? null,
  }));

  const serverReady = server.every((finding) => finding.level === "PASSED");
  const webReady = publicCheck.ok;
  // `demoMode` significa «la demostración se está usando», no «está pedida»:
  // en producción el candado la niega aunque la variable esté puesta.
  const demoMode = decideDemoMode(env).enabled;

  // Orden en el que conviene hacer las cosas la primera vez: el servidor puede
  // validarse sin la app web, pero el login necesita las dos partes.
  const order = [
    "FIREBASE_PROJECT_ID",
    "PDF_STORAGE_BUDGET_MB",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "APP_ORIGIN",
    "SESSION_COOKIE_NAME",
    "DEMO_MODE_IN_PRODUCTION",
    "EMULATOR_IN_PRODUCTION",
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
  ];

  const failing = [...server, ...web].filter((finding) => finding.level === "FAILED");

  // Cada acción nombra la variable: «falta el appId» no dice dónde ponerlo.
  const actions = failing
    .map((finding) => ({ finding, rank: order.indexOf(finding.id) }))
    .sort((a, b) => (a.rank === -1 ? 99 : a.rank) - (b.rank === -1 ? 99 : b.rank))
    .map(({ finding }) => {
      const body = finding.fix
        ? `${finding.id} → ${finding.fix}`
        : `Revisa ${finding.id}: ${finding.detail}`;
      return `${body} · [${KIND_LABEL[finding.kind]}]`;
    });

  // Deduplicar conservando el orden: dos hallazgos pueden compartir consejo.
  const uniqueActions = [...new Set(actions)];

  return {
    expectedProject,
    serverReady,
    webReady,
    ready: serverReady && webReady,
    demoMode,
    serverFindings: server,
    webFindings: web,
    actions: uniqueActions,
  };
}

/**
 * Variables secretas que siguen pendientes. Sirve para avisar en la CLI de que
 * esas no se pegan en el chat ni se commitean: `check:setup` no es un lugar
 * seguro para pegarlas.
 */
export function pendingSecrets(readiness: FirebaseReadiness): string[] {
  return [...readiness.serverFindings, ...readiness.webFindings]
    .filter((finding) => finding.level === "FAILED" && finding.kind === "secreta")
    .map((finding) => finding.id);
}

/** Nombres de lo que falta, para mensajes cortos en la interfaz. */
export function missingConfiguration(readiness: FirebaseReadiness): string[] {
  return [...readiness.serverFindings, ...readiness.webFindings]
    .filter((finding) => finding.level === "FAILED")
    .map((finding) => finding.id);
}
