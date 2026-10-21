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

export const SCHEMA_VERSION = 1;

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
  meta: "meta",
} as const;

export const META_DOC = { collection: COLLECTIONS.meta, id: "schema" } as const;

/** Colecciones legibles por el cliente (solo lo que permiten las reglas). */
export const CLIENT_READABLE_COLLECTIONS = [
  COLLECTIONS.accounts,
  COLLECTIONS.audits,
  COLLECTIONS.courses,
  COLLECTIONS.enrollments,
  COLLECTIONS.progress,
  COLLECTIONS.progressHistory,
  COLLECTIONS.attempts,
  COLLECTIONS.documents,
] as const;

/** Colecciones solo-servidor. */
export const SERVER_ONLY_COLLECTIONS = [
  COLLECTIONS.usernames,
  COLLECTIONS.activationTokens,
  COLLECTIONS.answerKeys,
  COLLECTIONS.pdfChunks,
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
  COLLECTIONS.meta,
] as const;
