import { DomainError } from "@/domain/text";

/**
 * VERSIONADO DE CURSOS
 * ====================
 *
 * Un curso tiene versiones inmutables (v1, v2, …). Solo una está publicada.
 * Publicar una versión nueva obliga a repetir el curso: el progreso se guarda
 * ligado a `version`, de modo que el progreso de v1 no sirve para v2, pero
 * tampoco se pierde (queda como histórico).
 */

export const COURSE_VERSION_STATUSES = ["draft", "published", "archived"] as const;
export type CourseVersionStatus = (typeof COURSE_VERSION_STATUSES)[number];

export interface CourseVersionSummary {
  version: number;
  status: CourseVersionStatus;
}

export function compareVersions(a: number, b: number): number {
  return a - b;
}

export function assertValidVersionNumber(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new DomainError(
      "VERSION_INVALID",
      "El número de versión debe ser un entero mayor o igual que 1.",
      500,
    );
  }
}

/** Siguiente número de versión a partir del histórico. */
export function nextVersionNumber(versions: readonly CourseVersionSummary[]): number {
  if (versions.length === 0) return 1;
  return Math.max(...versions.map((v) => v.version)) + 1;
}

/**
 * Solo se puede publicar la versión inmediatamente siguiente a la publicada
 * actual y debe estar en borrador. Evita saltos (v1 → v5) y dobles
 * publicaciones accidentales.
 */
export function assertPublishable(
  versions: readonly CourseVersionSummary[],
  versionToPublish: number,
): void {
  assertValidVersionNumber(versionToPublish);

  const target = versions.find((v) => v.version === versionToPublish);
  if (!target) {
    throw new DomainError("VERSION_NOT_FOUND", "La versión indicada no existe.", 404);
  }

  if (target.status === "published") {
    throw new DomainError("VERSION_ALREADY_PUBLISHED", "Esa versión ya está publicada.", 409);
  }

  if (target.status === "archived") {
    throw new DomainError("VERSION_ARCHIVED", "Una versión archivada no se puede publicar.", 409);
  }

  const currentlyPublished = versions.filter((v) => v.status === "published");
  if (currentlyPublished.length > 1) {
    throw new DomainError(
      "VERSION_MULTIPLE_PUBLISHED",
      "Hay más de una versión publicada: estado inconsistente.",
      500,
    );
  }

  if (currentlyPublished.length === 0) {
    if (versionToPublish !== 1) {
      throw new DomainError(
        "VERSION_MUST_START_AT_ONE",
        "La primera versión publicada de un curso debe ser la 1.",
        409,
      );
    }
    return;
  }

  const current = currentlyPublished[0].version;
  if (versionToPublish !== current + 1) {
    throw new DomainError(
      "VERSION_OUT_OF_ORDER",
      `Solo se puede publicar la versión ${current + 1} (actual publicada: ${current}).`,
      409,
    );
  }
}

/**
 * ¿Hay que repetir el curso? Sí cuando la versión publicada es posterior a la
 * última que el usuario completó. Un usuario que nunca lo completó también
 * debe hacerlo.
 */
export function requiresNewCompletion(
  lastCompletedVersion: number | null,
  publishedVersion: number,
): boolean {
  if (lastCompletedVersion === null) return true;
  return publishedVersion > lastCompletedVersion;
}

export function isVersionCompletable(
  versions: readonly CourseVersionSummary[],
  version: number,
): boolean {
  const target = versions.find((v) => v.version === version);
  return target?.status === "published";
}
