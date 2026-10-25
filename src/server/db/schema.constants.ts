/**
 * CONSTANTES DEL ESQUEMA (sin importaciones)
 * ==========================================
 *
 * Este fichero no importa nada a propósito: lo usan tanto la aplicación
 * (a través de `schema.ts`) como los scripts de línea de comandos ejecutados
 * con `tsx` (`npm run db:check`, `npm run db:init`), que así no dependen de
 * los alias de TypeScript (`@/...`).
 *
 * Si añades una colección aquí, las pruebas de deriva exigirán que también
 * aparezca en `firestore.rules`, en `firestore.indexes.json` (si se consulta)
 * y en `docs/MODELO-DATOS.md`.
 */

/**
 * Versión del esquema.
 *
 * v1 → v2 (bloque 03): `documents` deja de ser legible por el cliente y los
 * documentos guardan `originVersion` (la versión en la que se subieron) además
 * de `version`, que se conserva por compatibilidad. Los campos nuevos son
 * opcionales en lectura, así que una base v1 sigue siendo utilizable.
 */
export const SCHEMA_VERSION = 2;

export const COLLECTIONS = {
  accounts: "accounts",
  usernames: "usernames",
  activationTokens: "activationTokens",
  audits: "audits",
  courses: "courses",
  enrollments: "enrollments",
  versions: "versions",
  answerKeys: "answerKeys",
  documents: "documents",
  pdfChunks: "pdfChunks",
  progress: "progress",
  progressHistory: "progressHistory",
  attempts: "attempts",
  certificates: "certificates",
  meta: "meta",
} as const;

export const META_DOC = { collection: COLLECTIONS.meta, id: "schema" } as const;

/**
 * Colecciones legibles por el cliente (solo lo que permiten las reglas).
 *
 * `documents` NO está aquí desde el esquema v2: aunque solo contiene metadatos
 * (título, páginas, tamaño), los metadatos de un documento en **borrador** no
 * deben ser visibles para el alumnado. Los lee el servidor a través de la API
 * de documentos, que comprueba sesión, matrícula y publicación.
 */
export const CLIENT_READABLE_COLLECTIONS = [
  COLLECTIONS.accounts,
  COLLECTIONS.audits,
  COLLECTIONS.courses,
  COLLECTIONS.enrollments,
  COLLECTIONS.progress,
  COLLECTIONS.progressHistory,
  COLLECTIONS.attempts,
] as const;

/** Colecciones solo-servidor. */
export const SERVER_ONLY_COLLECTIONS = [
  COLLECTIONS.usernames,
  COLLECTIONS.activationTokens,
  COLLECTIONS.answerKeys,
  COLLECTIONS.documents,
  COLLECTIONS.pdfChunks,
  COLLECTIONS.certificates,
  COLLECTIONS.meta,
] as const;

/** Colecciones de nivel raíz que deben existir tras inicializar. */
export const ROOT_COLLECTIONS = [
  COLLECTIONS.accounts,
  COLLECTIONS.usernames,
  COLLECTIONS.activationTokens,
  COLLECTIONS.audits,
  COLLECTIONS.courses,
  COLLECTIONS.enrollments,
  COLLECTIONS.answerKeys,
  COLLECTIONS.documents,
  COLLECTIONS.pdfChunks,
  COLLECTIONS.progress,
  COLLECTIONS.progressHistory,
  COLLECTIONS.attempts,
  COLLECTIONS.certificates,
  COLLECTIONS.meta,
] as const;
