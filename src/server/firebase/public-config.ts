/**
 * CONFIGURACIÓN PÚBLICA DE FIREBASE WEB
 * =====================================
 *
 * El SDK de JavaScript necesita cuatro datos **públicos** (viajan en el
 * bundle; no son secretos) y un quinto valor propio de la aplicación: el
 * dominio de los correos internos.
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY       apiKey        (empieza por «AIza»)
 *   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN   authDomain    (`<proyecto>.firebaseapp.com`)
 *   NEXT_PUBLIC_FIREBASE_PROJECT_ID    projectId     (el mismo del servidor)
 *   NEXT_PUBLIC_FIREBASE_APP_ID        appId         (`1:<nº>:web:<hash>`)
 *   NEXT_PUBLIC_AUTH_EMAIL_DOMAIN      dominio de los correos sintéticos
 *
 * Esta función comprueba la **forma** de esos valores antes de intentar
 * conectar. No habla con Firebase: detecta el error más común (pegar un valor
 * de otro proyecto, o el `projectId` del servidor en la casilla equivocada)
 * sin gastar una sola lectura.
 *
 * Es lógica pura a propósito: se prueba sin red y la usa
 * `npm run check:firebase`.
 */

export type PublicConfigEnv = Record<string, string | undefined>;

export interface PublicConfigIssue {
  field: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface PublicConfigCheck {
  ok: boolean;
  issues: PublicConfigIssue[];
}

const API_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{30,}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;
const APP_ID_PATTERN = /^1:\d{6,}:web:[0-9a-f]+$/i;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

function value(env: PublicConfigEnv, name: string): string | null {
  const raw = env[name];
  return raw && raw.trim() !== "" ? raw.trim() : null;
}

export function checkPublicFirebaseConfig(env: PublicConfigEnv): PublicConfigCheck {
  const issues: PublicConfigIssue[] = [];

  const apiKey = value(env, "NEXT_PUBLIC_FIREBASE_API_KEY");
  const authDomain = value(env, "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  const projectId = value(env, "NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  const appId = value(env, "NEXT_PUBLIC_FIREBASE_APP_ID");
  const emailDomain = value(env, "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN");
  const serverProject = value(env, "FIREBASE_PROJECT_ID");

  // ---------------------------------------------------------------- apiKey
  if (!apiKey) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_API_KEY",
      ok: false,
      detail: "No está definida.",
      fix: "Consola → Configuración del proyecto → Tus apps → Web → Configuración del SDK → apiKey.",
    });
  } else if (!API_KEY_PATTERN.test(apiKey)) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_API_KEY",
      ok: false,
      detail: "No tiene la forma de una clave de API web de Firebase.",
      fix: "Debe empezar por «AIza». Suele ser el valor equivocado de otro proyecto.",
    });
  } else {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_API_KEY",
      ok: true,
      detail: `Clave web con la forma esperada (${apiKey.length} caracteres).`,
    });
  }

  // ------------------------------------------------------------ authDomain
  if (!authDomain) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ok: false,
      detail: "No está definida.",
      fix: "Consola → Configuración del proyecto → Tus apps → Web → Configuración del SDK → authDomain.",
    });
  } else if (authDomain.includes("://") || authDomain.includes("/")) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ok: false,
      detail: "Contiene protocolo o ruta: debe ser solo el dominio.",
      fix: `Escribe \`${projectId ?? "<proyecto>"}.firebaseapp.com\`, sin https:// ni barra final.`,
    });
  } else if (projectId && authDomain === `${projectId}.firebaseapp.com`) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ok: true,
      detail: `Coincide con el dominio predeterminado de ${projectId}.`,
    });
  } else {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ok: true,
      detail:
        "Dominio aceptado (distinto del predeterminado: comprueba que es el que muestra la consola).",
    });
  }

  // ------------------------------------------------------------- projectId
  if (!projectId) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      ok: false,
      detail: "No está definida.",
      fix: "Es el mismo valor que FIREBASE_PROJECT_ID.",
    });
  } else if (!PROJECT_ID_PATTERN.test(projectId)) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      ok: false,
      detail: "No tiene forma de identificador de proyecto.",
      fix: "Solo minúsculas, números y guiones (por ejemplo `mi-proyecto-12345`).",
    });
  } else if (serverProject && projectId !== serverProject) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      ok: false,
      detail: `El cliente apunta a «${projectId}» y el servidor a «${serverProject}».`,
      fix: "Cliente y servidor deben hablar del MISMO proyecto.",
    });
  } else {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      ok: true,
      detail: serverProject
        ? `Coincide con FIREBASE_PROJECT_ID (${serverProject}).`
        : `${projectId} (FIREBASE_PROJECT_ID sin definir: se comprobará al configurarlo).`,
    });
  }

  // ----------------------------------------------------------------- appId
  if (!appId) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_APP_ID",
      ok: false,
      detail: "No está definida.",
      fix: "Consola → Configuración del proyecto → Tus apps → Web → Configuración del SDK → appId.",
    });
  } else if (!APP_ID_PATTERN.test(appId)) {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_APP_ID",
      ok: false,
      detail: "No tiene la forma `1:<número>:web:<hash>`.",
      fix: "Copia el appId entero, sin espacios ni comillas.",
    });
  } else {
    issues.push({
      field: "NEXT_PUBLIC_FIREBASE_APP_ID",
      ok: true,
      detail: "Identificador de app web con la forma esperada.",
    });
  }

  // -------------------------------------------------------- dominio correo
  const serverEmailDomain = value(env, "AUTH_EMAIL_DOMAIN");

  if (!emailDomain) {
    issues.push({
      field: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
      ok: false,
      detail: "No está definida.",
      fix: "Usa `formacion.invalid`, el mismo valor que AUTH_EMAIL_DOMAIN.",
    });
  } else if (!EMAIL_DOMAIN_PATTERN.test(emailDomain)) {
    issues.push({
      field: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
      ok: false,
      detail: "No es un dominio válido.",
      fix: "Debe tener al menos un punto, por ejemplo `formacion.invalid`.",
    });
  } else if (serverEmailDomain && emailDomain !== serverEmailDomain) {
    issues.push({
      field: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
      ok: false,
      detail: `El cliente usa «${emailDomain}» y el servidor «${serverEmailDomain}».`,
      fix: "Si no coinciden, la cuenta se crea con un correo y se intenta entrar con otro.",
    });
  } else if (!emailDomain.endsWith(".invalid")) {
    issues.push({
      field: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
      ok: true,
      detail: `«${emailDomain}» no es el dominio reservado .invalid: no se envía correo, pero revisa que sea intencionado.`,
    });
  } else {
    issues.push({
      field: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN",
      ok: true,
      detail: `Dominio reservado ${emailDomain} (no enrutable).`,
    });
  }

  return { ok: issues.every((issue) => issue.ok), issues };
}
