/**
 * NÚCLEO DEL ALTA DE ADMINISTRADORES INICIALES
 * ============================================
 *
 * Aquí vive la lógica que se puede probar sin red y sin credenciales: el
 * reparto de responsabilidades, el rollback, el informe de residuos y la
 * comprobación del dominio de correo. `scripts/bootstrap-admins.mjs` solo
 * conecta esto con `firebase-admin` y con `process.env`.
 *
 * POR QUÉ UN MÓDULO APARTE Y NO TODO EN EL SCRIPT
 * ----------------------------------------------
 * El script se ejecuta con `node` sin compilar TypeScript, así que no puede
 * importar `src/`. Para poder probar los caminos de fallo (commit a medias,
 * limpieza que falla, auditoría que falla, dos ejecuciones a la vez) la lógica
 * recibe sus dependencias por parámetro: `deps.db` y `deps.auth` con la misma
 * forma que usan `firebase-admin/firestore` y `firebase-admin/auth`. Las
 * pruebas pasan dobles en memoria; el script pasa los clientes reales.
 *
 * GARANTÍAS QUE ESTE MÓDULO MANTIENE (y que las pruebas fijan):
 *
 *   1. Nada de secretos en reposo: de un código de activación solo se guarda
 *      su SHA-256. El token en claro existe únicamente en memoria del proceso
 *      y en la salida estándar de la ejecución (una vez).
 *   2. La contraseña inicial es aleatoria (48 bytes) y no se conoce ni se
 *      entrega: la cuenta es inaccesible hasta que el titular la active.
 *   3. Los códigos caducan (72 h por omisión) y son de un solo uso (lo hace
 *      cumplir el flujo de activación, que ya existía; aquí solo se crean).
 *   4. Si algo falla a mitad, se limpia TODO lo creado —incluido
 *      `activationTokens/{hash}`, que es un código válido si sobrevive— y se
 *      informa de cada recurso cuya limpieza falle y del estado residual.
 *   5. Un conflicto de reserva (concurrencia) no aborta el resto del lote: se
 *      informa como omitido y se sigue con el siguiente nombre.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const MAX_BOOTSTRAP_ADMINS = 20;
export const TOKEN_TTL_HOURS = 72;
export const USERNAME_MIN_LENGTH = 4;
export const USERNAME_MAX_LENGTH = 60;
export const USERNAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** Los mismos nombres reservados que `src/domain/people/username.ts`. */
export const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "sistema",
  "system",
  "soporte",
  "seguridad",
]);

export const DEFAULT_EMAIL_DOMAIN = "formacion.invalid";
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export const CREATED_BY = "bootstrap-script";
export const AUDIT_ACTOR = "bootstrap-script";

// ---------------------------------------------------------------------------
// Errores con código
// ---------------------------------------------------------------------------

/**
 * Error con un `code` estable. El código no cambia el comportamiento (el
 * script sigue siendo un CLI); sirve para que las pruebas y los mensajes
 * distingan «conflicto esperable» de «fallo real».
 */
export class BootstrapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    Object.assign(this, details);
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * ¿Es un choque de concurrencia (otra ejecución, o el mismo nombre ya usado)?
 *
 * Se reconocen los códigos de gRPC de Firestore (6 = ALREADY_EXISTS,
 * 9 = FAILED_PRECONDITION, 10 = ABORTED por contención) y los de Auth
 * (`auth/email-already-exists`, `auth/uid-already-exists`), además de nuestro
 * propio código. Se comprueba también `details` porque el SDK envuelve unos
 * errores dentro de otros.
 */
export function isConcurrencyConflict(error) {
  if (!error) return false;
  if (error instanceof BootstrapError && error.code === "RESERVATION_TAKEN") return true;

  const codes = [error.code, error.errorInfo?.code, error.details?.code, error.cause?.code];
  for (const code of codes) {
    if (code === 6 || code === 9 || code === 10) return true;
    if (code === "ALREADY_EXISTS" || code === "ABORTED" || code === "FAILED_PRECONDITION") return true;
    if (code === "auth/email-already-exists" || code === "auth/uid-already-exists") return true;
  }

  const message = String(error.message ?? "").toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("ya existe") ||
    message.includes("already-exists")
  );
}

// ---------------------------------------------------------------------------
// Plan: lista de nombres
// ---------------------------------------------------------------------------

export function parseAdminList(raw) {
  if (!raw) return [];
  return [
    ...new Set(
      String(raw)
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * Filtra los nombres imposibles antes de tocar nada. No consulta la base:
 * eso lo hace `runBootstrap` con el conjunto de reservas existentes.
 */
export function planAdminUsernames(requested) {
  const create = [];
  const invalid = [];
  for (const username of requested) {
    if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
      invalid.push({ username, reason: "longitud no válida" });
      continue;
    }
    if (!USERNAME_PATTERN.test(username)) {
      invalid.push({ username, reason: "caracteres no válidos" });
      continue;
    }
    if (RESERVED_USERNAMES.has(username)) {
      invalid.push({ username, reason: "nombre reservado" });
      continue;
    }
    create.push(username);
  }
  return { create, invalid };
}

// ---------------------------------------------------------------------------
// Dominio de correo interno
// ---------------------------------------------------------------------------

/**
 * Resuelve los dos dominios que deben coincidir.
 *
 * El registrador de la cuenta (`AUTH_EMAIL_DOMAIN`) y el que usa el navegador
 * para iniciar sesión (`NEXT_PUBLIC_AUTH_EMAIL_DOMAIN`) son variables
 * distintas. Si divergen, la cuenta existe en Auth con un correo que el login
 * nunca construye y el síntoma es «usuario o contraseña incorrectos»: un error
 * indistinguible de una contraseña mal escrita. Por eso el alta se niega.
 *
 * Cuando `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` no está definida se usa su valor por
 * defecto documentado (`src/lib/firebase/client.ts` y `.env.example`):
 * `formacion.invalid`. No se inventa nada: es el mismo que aplicaría el
 * navegador.
 */
/**
 * CREDENCIALES DE FIREBASE ADMIN
 * ==============================
 *
 * Dos formas de cargarlas, siempre fuera del repositorio:
 *
 *   a) el JSON de la cuenta de servicio que descarga la consola de Firebase:
 *        FIREBASE_SERVICE_ACCOUNT_FILE=/ruta/cuenta.json
 *
 *   b) las tres variables sueltas:
 *        FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *
 * La opción (a) evita pegar una clave PEM en la terminal (donde los saltos de
 * línea se rompen con facilidad). Devuelve `null` si no hay nada, para que el
 * script pueda decirlo en vez de fallar dentro de firebase-admin.
 */
export function resolveAdminCredentials(env = {}, readFile = readFileSync) {
  const fileRaw = env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const file = typeof fileRaw === "string" ? fileRaw.trim() : "";

  if (file) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(file, "utf8"));
    } catch {
      throw new Error(
        "No se pudo leer el fichero de FIREBASE_SERVICE_ACCOUNT_FILE (¿existe y es JSON?).",
      );
    }
    const projectId = typeof parsed.project_id === "string" ? parsed.project_id.trim() : "";
    const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email.trim() : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key.trim() : "";
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "El fichero de cuenta de servicio no tiene project_id, client_email y private_key.",
      );
    }
    return { projectId, clientEmail, privateKey, source: "file" };
  }

  const pick = (value) => (typeof value === "string" ? value.trim() : "");
  const projectId = pick(env.FIREBASE_PROJECT_ID);
  const clientEmail = pick(env.FIREBASE_CLIENT_EMAIL);
  const privateKey = pick(env.FIREBASE_PRIVATE_KEY);
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey, source: "env" };
}

/** La clave PEM llega escapada (\\n) desde las variables de entorno. */
const ESCAPED_NEWLINE = String.raw`\n`;

export function normalizePrivateKey(key) {
  const value = typeof key === "string" ? key : "";
  return value.includes(ESCAPED_NEWLINE)
    ? value.split(ESCAPED_NEWLINE).join("\n")
    : value;
}

export function checkEmailDomains(env = {}) {
  const serverRaw = env.AUTH_EMAIL_DOMAIN;
  const clientRaw = env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN;

  const server = (typeof serverRaw === "string" && serverRaw.trim() !== ""
    ? serverRaw.trim()
    : DEFAULT_EMAIL_DOMAIN
  ).toLowerCase();

  const clientConfigured = typeof clientRaw === "string" && clientRaw.trim() !== "";
  const client = (clientConfigured ? clientRaw.trim() : DEFAULT_EMAIL_DOMAIN).toLowerCase();

  const result = { server, client, clientConfigured, ok: false, reason: null };

  if (!EMAIL_DOMAIN_PATTERN.test(server)) {
    result.reason = `AUTH_EMAIL_DOMAIN no es un dominio válido: «${server}».`;
    return result;
  }
  if (!EMAIL_DOMAIN_PATTERN.test(client)) {
    result.reason = `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN no es un dominio válido: «${client}».`;
    return result;
  }
  if (server !== client) {
    result.reason =
      `AUTH_EMAIL_DOMAIN («${server}») y NEXT_PUBLIC_AUTH_EMAIL_DOMAIN («${client}») ` +
      "no coinciden: la cuenta se crearía con un correo y el navegador intentaría " +
      "entrar con otro. Igualar las dos variables antes de dar de alta.";
    return result;
  }

  result.ok = true;
  return result;
}

/** Igual que `checkEmailDomains`, pero lanza si no coinciden. */
export function assertEmailDomainsMatch(env = {}) {
  const check = checkEmailDomains(env);
  if (!check.ok) {
    throw new BootstrapError("EMAIL_DOMAIN_MISMATCH", check.reason, { check });
  }
  return check;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** 32 bytes en base64url: 43 caracteres, el formato que exige la activación. */
export function generateActivationToken() {
  return randomBytes(32).toString("base64url");
}

/** Contraseña aleatoria que nadie conoce ni recibe. */
export function generateUnusablePassword() {
  return randomBytes(48).toString("base64url");
}

/** En la base solo vive este hash; el token no se guarda en ningún sitio. */
export function hashActivationToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cuerpo de la ficha `accounts/{uid}`. Sin secretos. */
export function buildAccountDocument({ uid, username, authEmail, createdAt }) {
  return {
    uid,
    username,
    authEmail,
    apellido: null,
    personRol: null,
    role: "admin",
    status: "pending_activation",
    claimsVersion: 1,
    createdAt,
    createdBy: CREATED_BY,
    activatedAt: null,
    disabledAt: null,
  };
}

/** Cuerpo de `activationTokens/{hash}`. Sin el token en claro. */
export function buildActivationDocument({ uid, createdAt, expiresAt }) {
  return { uid, createdAt, expiresAt, usedAt: null, revokedAt: null };
}

/** Claims iniciales: la cuenta existe, pero todavía no puede hacer nada. */
export function buildInitialClaims() {
  return { role: "admin", status: "pending_activation", claimsVersion: 1 };
}

// ---------------------------------------------------------------------------
// Limpieza y verificación de residuos
// ---------------------------------------------------------------------------

function safeDoc(db, collection, id) {
  return db.collection(collection).doc(id);
}

/**
 * Borra todo lo que la provisión pudo crear, en orden de riesgo: primero el
 * código de activación (es una credencial válida mientras exista), después la
 * ficha, después el usuario de Auth y por último la reserva de nombre.
 *
 * No oculta errores: cada paso se intenta por separado y se devuelve qué se
 * limpió, qué falló y (leyendo de nuevo) qué queda. Un borrado de un documento
 * inexistente no es un error: Firestore lo trata como éxito.
 */
export async function rollbackProvisioned({ deps, username, uid, tokenHash, reservationCreated }) {
  const steps = [];

  if (tokenHash) {
    steps.push({
      resource: `activationTokens/${tokenHash}`,
      run: () => safeDoc(deps.db, "activationTokens", tokenHash).delete(),
    });
  }
  if (uid) {
    steps.push({
      resource: `accounts/${uid}`,
      run: () => safeDoc(deps.db, "accounts", uid).delete(),
    });
    steps.push({
      resource: `auth:${uid}`,
      run: () => deps.auth.deleteUser(uid),
    });
  }
  if (reservationCreated) {
    steps.push({
      resource: `usernames/${username}`,
      run: () => safeDoc(deps.db, "usernames", username).delete(),
    });
  }

  const cleaned = [];
  const failed = [];

  for (const step of steps) {
    try {
      await step.run();
      cleaned.push(step.resource);
    } catch (error) {
      failed.push({ resource: step.resource, error: describeError(error) });
    }
  }

  const residual = await inspectResidual({ deps, username, uid, tokenHash, reservationCreated });
  return { cleaned, failed, residual };
}

/**
 * Relee lo que debería haber desaparecido y devuelve solo lo que sigue ahí (o
 * lo que no se pudo comprobar). Es la parte que impide decir «rollback hecho»
 * cuando en realidad quedó basura: un `delete` silenciado no engaña a esta
 * comprobación.
 */
export async function inspectResidual({ deps, username, uid, tokenHash, reservationCreated }) {
  const residual = [];

  async function checkDoc(resource, collection, id) {
    if (!id) return;
    try {
      const snapshot = await safeDoc(deps.db, collection, id).get();
      if (snapshot.exists) residual.push({ resource, state: "sigue existiendo" });
    } catch (error) {
      residual.push({ resource, state: "no se pudo comprobar", error: describeError(error) });
    }
  }

  if (tokenHash) await checkDoc(`activationTokens/${tokenHash}`, "activationTokens", tokenHash);
  if (uid) await checkDoc(`accounts/${uid}`, "accounts", uid);

  if (uid && typeof deps.auth.getUser === "function") {
    try {
      await deps.auth.getUser(uid);
      residual.push({ resource: `auth:${uid}`, state: "sigue existiendo" });
    } catch (error) {
      const code = error?.code ?? error?.errorInfo?.code;
      const message = String(error?.message ?? "").toLowerCase();
      const missing =
        code === "auth/user-not-found" ||
        code === 5 ||
        message.includes("no user record") ||
        message.includes("user not found");
      if (!missing) {
        residual.push({
          resource: `auth:${uid}`,
          state: "no se pudo comprobar",
          error: describeError(error),
        });
      }
    }
  }

  if (reservationCreated) await checkDoc(`usernames/${username}`, "usernames", username);

  return residual;
}

// ---------------------------------------------------------------------------
// Provisión de un administrador
// ---------------------------------------------------------------------------

/**
 * Crea un administrador `pending_activation` y devuelve su código de
 * activación **una sola vez, en memoria**. No imprime nada: la impresión es
 * responsabilidad del CLI, para que las pruebas puedan comprobar que el token
 * no viaja a ningún almacén.
 *
 * Devuelve siempre un objeto con `status`:
 *   - `created`  → `{ username, uid, token, tokenHash, expiresAt, createdAt }`
 *   - `skipped`  → `{ username, reason }` (concurrencia o nombre ya usado)
 *   - `failed`   → `{ username, stage, error, cleanup }`
 */
export async function provisionAdmin({
  username,
  deps,
  now = new Date(),
  ttlHours = TOKEN_TTL_HOURS,
  tokenFactory = generateActivationToken,
  passwordFactory = generateUnusablePassword,
  displayName = undefined,
}) {
  if (!username) {
    throw new BootstrapError("USERNAME_REQUIRED", "Falta el nombre de usuario.");
  }

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
  const emailDomain = deps.emailDomain ?? DEFAULT_EMAIL_DOMAIN;
  const authEmail = `${username}@${emailDomain}`;

  const state = {
    username,
    uid: null,
    tokenHash: null,
    reservationCreated: false,
    stage: "reserva",
  };

  // 1. Reserva de unicidad. Es una transacción: si dos ejecuciones coinciden,
  //    una gana y la otra recibe un conflicto que NO debe tumbar el lote.
  const reservation = safeDoc(deps.db, "usernames", username);
  try {
    await deps.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reservation);
      if (snapshot.exists) {
        throw new BootstrapError("RESERVATION_TAKEN", `El usuario «${username}» ya existe.`);
      }
      transaction.create(reservation, {
        uid: null,
        reservedAt: createdAt,
        reservedBy: "bootstrap",
      });
    });
    state.reservationCreated = true;
  } catch (error) {
    if (isConcurrencyConflict(error)) {
      return { status: "skipped", username, reason: "el nombre ya está reservado (otra ejecución o cuenta existente)" };
    }
    return {
      status: "failed",
      username,
      stage: "reserva",
      error: describeError(error),
      cleanup: { cleaned: [], failed: [], residual: [] },
    };
  }

  try {
    // 2. Usuario de Auth con contraseña aleatoria e inútil.
    state.stage = "auth.createUser";
    const user = await deps.auth.createUser({
      email: authEmail,
      password: passwordFactory(),
      displayName: displayName ?? `${username} (administrador)`,
      disabled: false,
    });
    state.uid = user.uid;

    // 3. Claims iniciales: existen, pero la cuenta sigue pendiente.
    state.stage = "auth.setCustomUserClaims";
    await deps.auth.setCustomUserClaims(user.uid, buildInitialClaims());

    // 4. Código de activación: 32 bytes aleatorios; solo el hash se guarda.
    state.stage = "token";
    const token = tokenFactory();
    state.tokenHash = hashActivationToken(token);

    // 5. Lote atómico: ficha + código + reserva con uid. O están los tres, o
    //    ninguno. Es lo que hace limpio el caso «falla antes del commit».
    state.stage = "commit";
    const batch = deps.db.batch();
    batch.create(
      safeDoc(deps.db, "accounts", user.uid),
      buildAccountDocument({ uid: user.uid, username, authEmail, createdAt }),
    );
    batch.create(
      safeDoc(deps.db, "activationTokens", state.tokenHash),
      buildActivationDocument({ uid: user.uid, createdAt, expiresAt }),
    );
    batch.update(reservation, { uid: user.uid });
    await batch.commit();

    state.stage = "done";
    return {
      status: "created",
      username,
      uid: user.uid,
      token,
      tokenHash: state.tokenHash,
      expiresAt,
      createdAt,
    };
  } catch (error) {
    // Un correo que ya existe en Auth no es un fallo de la ejecución: es otra
    // cuenta con ese correo. Se retira la reserva y se informa como omitido.
    const duplicateEmail =
      state.stage === "auth.createUser" &&
      state.uid === null &&
      isConcurrencyConflict(error);

    const cleanup = await rollbackProvisioned({
      deps,
      username,
      uid: state.uid,
      tokenHash: state.tokenHash,
      reservationCreated: state.reservationCreated,
    });

    if (duplicateEmail) {
      return { status: "skipped", username, reason: "ese correo ya está registrado en Auth", cleanup };
    }

    return {
      status: "failed",
      username,
      stage: state.stage,
      error: describeError(error),
      // Se exponen para poder informar con precisión de lo que se intentó
      // limpiar (nunca contienen el token en claro).
      uid: state.uid,
      tokenHash: state.tokenHash,
      cleanup,
    };
  }
}

// ---------------------------------------------------------------------------
// Reemisión de un código
// ---------------------------------------------------------------------------

/**
 * Emite un código nuevo para una cuenta que sigue pendiente de activación.
 *
 * Existe por un caso muy concreto: el alta se ejecutó, la persona perdió el
 * código (o el proceso murió antes de que se copiara) y no hay ningún
 * administrador activo que pueda entrar al panel a reemitirlo. Sin esto, el
 * sistema se queda sin puerta de entrada.
 *
 * Orden deliberado: primero se revocan los códigos vivos y después se crea el
 * nuevo. Si el segundo paso falla, la cuenta se queda sin código utilizable
 * (se puede repetir la operación), nunca con dos válidos a la vez.
 */
export async function reissueActivationCode({
  username,
  deps,
  now = new Date(),
  ttlHours = TOKEN_TTL_HOURS,
  tokenFactory = generateActivationToken,
}) {
  if (!username) {
    throw new BootstrapError("USERNAME_REQUIRED", "Falta el nombre de usuario.");
  }

  const found = await deps.db.collection("accounts").where("username", "==", username).limit(1).get();
  const accountDoc = (found.docs ?? [])[0];
  if (!accountDoc) {
    return { status: "not_found", username };
  }

  const account = accountDoc.data() ?? {};
  if (account.status === "active") {
    return { status: "not_applicable", username, reason: "la cuenta ya está activa: no necesita código" };
  }
  if (account.status === "disabled") {
    return {
      status: "not_applicable",
      username,
      reason: "la cuenta está deshabilitada: reactívala antes de emitir un código",
    };
  }

  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();

  const liveSnapshot = await deps.db.collection("activationTokens").where("uid", "==", accountDoc.id).get();
  const live = (liveSnapshot.docs ?? []).filter((doc) => {
    const data = doc.data() ?? {};
    return !data.usedAt && !data.revokedAt;
  });

  if (live.length > 0) {
    const revoke = deps.db.batch();
    for (const doc of live) {
      revoke.update(safeDoc(deps.db, "activationTokens", doc.id), {
        revokedAt: at,
        revokedReason: "reissued",
      });
    }
    await revoke.commit();
  }

  const token = tokenFactory();
  const tokenHash = hashActivationToken(token);
  await safeDoc(deps.db, "activationTokens", tokenHash).create(
    buildActivationDocument({ uid: accountDoc.id, createdAt: at, expiresAt }),
  );

  return {
    status: "reissued",
    username,
    uid: accountDoc.id,
    token,
    tokenHash,
    expiresAt,
    revoked: live.length,
  };
}

// ---------------------------------------------------------------------------
// Lote completo
// ---------------------------------------------------------------------------

/**
 * Recorre los nombres y devuelve el informe. Nunca lanza por un nombre
 * concreto: un fallo o un conflicto se refleja en su entrada y el bucle sigue,
 * de modo que un problema con «admin1» no impide crear «admin2».
 *
 * NO escribe la auditoría y NO imprime códigos: el CLI imprime primero los
 * códigos (si el proceso muere después, el titular ya los tiene) y solo
 * después escribe la auditoría.
 */
export async function runBootstrap({
  usernames,
  existing = new Set(),
  deps,
  now = new Date(),
  ttlHours = TOKEN_TTL_HOURS,
  tokenFactory = generateActivationToken,
  passwordFactory = generateUnusablePassword,
  onEvent = () => {},
}) {
  const created = [];
  const skipped = [];
  const failed = [];

  for (const username of usernames) {
    if (existing.has(username)) {
      skipped.push({ username, reason: "ya existe (reserva previa)" });
      onEvent({ type: "skipped", username, reason: "ya existe (reserva previa)" });
      continue;
    }

    const result = await provisionAdmin({
      username,
      deps,
      now,
      ttlHours,
      tokenFactory,
      passwordFactory,
    });

    if (result.status === "created") {
      created.push(result);
      onEvent({ type: "created", username, expiresAt: result.expiresAt });
    } else if (result.status === "skipped") {
      skipped.push({ username: result.username, reason: result.reason });
      onEvent({ type: "skipped", username: result.username, reason: result.reason });
    } else {
      failed.push(result);
      onEvent({
        type: "failed",
        username: result.username,
        stage: result.stage,
        error: result.error,
        cleanup: result.cleanup,
      });
    }
  }

  return { created, skipped, failed, expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

/**
 * Documento de auditoría de la ejecución. Contiene nombres y estados, nunca
 * códigos: el `token` no se copia aquí ni recortado.
 *
 * Se escribe DESPUÉS de haber mostrado los códigos (ver el CLI). Si falla, no
 * se pierde ningún código: como mucho queda un alta sin rastro de auditoría, y
 * el CLI lo dice en voz alta y termina con error.
 */
export async function writeBootstrapAudit({ deps, report, at }) {
  const payload = {
    type: "bootstrap_admins",
    at,
    actorUid: AUDIT_ACTOR,
    usernames: report.created.map((item) => item.username),
    skipped: report.skipped.map((item) => ({ username: item.username, reason: item.reason })),
    failed: report.failed.map((item) => ({ username: item.username, stage: item.stage })),
    severity: "warning",
  };

  // Contrato explícito: nada de secretos en la auditoría.
  if (JSON.stringify(payload).includes("token")) {
    throw new BootstrapError("AUDIT_LEAK", "El documento de auditoría contendría un token.");
  }

  await deps.db.collection("audits").add(payload);
  return payload;
}
