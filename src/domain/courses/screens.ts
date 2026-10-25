import { DomainError } from "@/domain/text";

/**
 * PANTALLAS DE ESTUDIO
 * ====================
 *
 * Contenido formativo estructurado que se estudia pantalla a pantalla, igual
 * que hoy se lee un PDF página a página. Nace para el contenido generado con
 * IA, pero no es «contenido de la IA»: es contenido del curso, se guarda en el
 * documento de la versión, se revisa en el editor y se publica con el mismo
 * ciclo que todo lo demás.
 *
 * Tres decisiones que importan:
 *
 *   · **Es contenido público, sin respuestas.** Una pantalla no lleva la clave
 *     de ninguna pregunta; por eso puede ir en el documento de la versión y no
 *     en `answerKeys`.
 *   · **Lleva las páginas del PDF de origen** cuando se conocen. Es lo que
 *     permite comprobar que lo que dice la pantalla está en el documento y no
 *     inventado: el administrador puede ir a la página citada.
 *   · **Está acotado en tamaño.** El documento de la versión se acerca al
 *     límite de 1 MiB de Firestore; una pantalla sin tope podría dejarlo
 *     ilegible. Los topes están aquí, en un solo sitio, y los aplica la
 *     validación del borrador.
 */

export const SCREEN_LIMITS = {
  /** Pantallas por tema. Suficiente para un tema de 20–30 minutos. */
  maxPerTopic: 30,
  /** Párrafos por pantalla (además de las viñetas). */
  maxParagraphs: 6,
  maxParagraphChars: 600,
  maxBullets: 8,
  maxBulletChars: 240,
  maxTitleChars: 120,
  /** Referencias de página citadas en una pantalla. */
  maxPageRefs: 12,
  /** Tope de una pantalla completa, sumando textos (bytes UTF-8 aproximados). */
  maxScreenChars: 3000,
} as const;

export interface StudyScreen {
  /** Identificador estable: forma parte del progreso del alumnado. */
  id: string;
  title: string;
  /** Texto explicativo, un párrafo por elemento. */
  paragraphs: string[];
  /** Listas y pasos; puede estar vacío. */
  bullets: string[];
  /** Páginas del PDF de origen en las que se apoya (1-based). */
  pages: number[];
}

/**
 * Identificador de progreso de las pantallas de un tema.
 *
 * El progreso de lectura guarda un registro por «documento»; las pantallas se
 * registran con este identificador derivado del tema. Así reutilizan la misma
 * máquina (`assertCanViewPage`, `recordPageViewed`) sin inventar un segundo
 * sistema de avance, y sin ocupar el identificador de un PDF real.
 */
export function screensProgressId(topicId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(topicId)) {
    throw new DomainError("TOPIC_ID_INVALID", "Identificador de tema no válido.", 500);
  }
  return `screens_${topicId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean === "" || clean.length > max) return null;
  return clean;
}

function textList(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const clean = text(item, maxChars);
    if (clean === null) return null;
    out.push(clean);
  }
  return out;
}

function pageList(value: unknown, maxPages: number | null): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > SCREEN_LIMITS.maxPageRefs) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 1) return null;
    if (maxPages !== null && item > maxPages) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out.sort((a, b) => a - b);
}

export interface ScreenLimitsOverride {
  /** Páginas conocidas del PDF de origen; `null` si no se pudieron determinar. */
  pageCount?: number | null;
}

/**
 * Normaliza y valida una lista de pantallas.
 *
 * Devuelve la lista limpia (espacios colapsados, páginas ordenadas y sin
 * repetir) o lanza `SCREENS_INVALID` con el motivo. Se usa en dos sitios: al
 * recibir el contenido del modelo y al validar el borrador antes de guardarlo.
 * Es la misma función, para que no haya dos criterios.
 */
export function normalizeScreens(
  value: unknown,
  options: ScreenLimitsOverride = {},
): StudyScreen[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "SCREENS_INVALID",
      "El tema no tiene ninguna pantalla de estudio válida.",
      400,
    );
  }
  if (value.length > SCREEN_LIMITS.maxPerTopic) {
    throw new DomainError(
      "SCREENS_TOO_MANY",
      `Un tema no puede tener más de ${SCREEN_LIMITS.maxPerTopic} pantallas.`,
      400,
    );
  }

  const pageCount = options.pageCount ?? null;
  const ids = new Set<string>();
  const screens: StudyScreen[] = [];

  value.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new DomainError("SCREENS_INVALID", `La pantalla ${index + 1} no es válida.`, 400);
    }

    const id = text(item.id, 64);
    const title = text(item.title, SCREEN_LIMITS.maxTitleChars);
    const paragraphs = textList(item.paragraphs, SCREEN_LIMITS.maxParagraphs, SCREEN_LIMITS.maxParagraphChars);
    const bullets = textList(item.bullets, SCREEN_LIMITS.maxBullets, SCREEN_LIMITS.maxBulletChars);
    const pages = pageList(item.pages, pageCount);

    if (!id || !title || paragraphs === null || bullets === null || pages === null) {
      throw new DomainError(
        "SCREENS_INVALID",
        `La pantalla ${index + 1} tiene un campo vacío, demasiado largo o con una página fuera del documento.`,
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new DomainError(
        "SCREENS_INVALID",
        `El identificador de la pantalla ${index + 1} no es válido.`,
        400,
      );
    }
    if (ids.has(id)) {
      throw new DomainError("SCREENS_INVALID", `Pantalla repetida: ${id}.`, 400);
    }
    ids.add(id);

    if (paragraphs.length === 0 && bullets.length === 0) {
      throw new DomainError(
        "SCREENS_INVALID",
        `La pantalla ${index + 1} no tiene contenido: ni párrafos ni viñetas.`,
        400,
      );
    }

    const chars =
      title.length +
      paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0) +
      bullets.reduce((sum, bullet) => sum + bullet.length, 0);
    if (chars > SCREEN_LIMITS.maxScreenChars) {
      throw new DomainError(
        "SCREENS_TOO_LONG",
        `La pantalla ${index + 1} es demasiado larga para estudiarla de una vez (${chars} caracteres, máximo ${SCREEN_LIMITS.maxScreenChars}).`,
        400,
      );
    }

    screens.push({ id, title, paragraphs, bullets, pages });
  });

  return screens;
}

/** Volumen aproximado de un tema en pantallas, para comprobar el límite del documento. */
export function screensChars(screens: readonly StudyScreen[]): number {
  return screens.reduce(
    (total, screen) =>
      total +
      screen.title.length +
      screen.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0) +
      screen.bullets.reduce((sum, bullet) => sum + bullet.length, 0),
    0,
  );
}
