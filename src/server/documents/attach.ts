import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";
import type { TopicDocumentDefinition } from "@/domain/courses/content";
import { checkDraftStructure } from "@/domain/courses/draft";
import { definitionFromDocuments } from "@/server/courses/definition";
import {
  toAnswerKeys,
  toPublicVersion,
  type CourseCatalogStore,
} from "@/server/courses/catalog";
import type { PdfDocumentStore } from "@/server/documents/store";

/**
 * ASOCIAR UN PDF A UN TEMA DEL BORRADOR
 * ====================================
 *
 * Subir el fichero y asociarlo son dos pasos distintos, y a propósito:
 *
 *   1. subir produce un **activo inmutable** (`documents/{id}`) que todavía no
 *      forma parte de ningún curso;
 *   2. asociarlo mete su referencia (`{id, title, pageCount}`) en el tema de una
 *      versión **en borrador**.
 *
 * Esto permite reutilizar un activo, subir antes de decidir el tema y, sobre
 * todo, que un documento pendiente no pueda llegar nunca al contenido que ve el
 * alumnado: solo se asocia lo que está `active` (verificado de punta a punta).
 *
 * Reglas:
 *   - solo administradores;
 *   - solo versiones en borrador (`VERSION_NOT_EDITABLE`), con la revisión que
 *     el editor tenía abierta (`DRAFT_STALE` si cambió);
 *   - el documento tiene que estar activo (`DOCUMENT_NOT_READY`) y pertenecer
 *     al mismo curso y a la **misma versión** para la que se subió;
 *   - asociar dos veces el mismo documento es idempotente: no crea una segunda
 *     referencia ni sube la revisión.
 *
 * La versión se escribe con `replaceDraftContent`, es decir, junto con sus
 * claves de corrección: el mismo invariante que el resto del editor.
 */

export interface AttachDependencies {
  documents: PdfDocumentStore;
  catalog: CourseCatalogStore;
  now?: () => Date;
}

export interface AttachResult {
  courseId: string;
  version: number;
  revision: number;
  topicId: string;
  documentId: string;
  /** `false` si ya estaba asociado y no hubo que escribir. */
  attached: boolean;
}

export async function attachDocumentToDraft(
  input: { actor: Actor; documentId: string; expectedRevision: number },
  deps: AttachDependencies,
): Promise<AttachResult> {
  assertAdmin(input.actor);

  const meta = await deps.documents.getMeta(input.documentId);
  if (!meta || meta.state === "aborted") {
    throw new DomainError("DOCUMENT_NOT_FOUND", "El documento no existe.", 404);
  }
  if (meta.state !== "active") {
    throw new DomainError(
      "DOCUMENT_NOT_READY",
      "La subida todavía no se ha completado: un documento pendiente no se asocia a ningún curso.",
      409,
    );
  }

  const version = await deps.catalog.getVersion(meta.courseId, meta.version);
  if (!version) {
    throw new DomainError("VERSION_NOT_FOUND", "La versión del documento ya no existe.", 404);
  }
  if (version.status !== "draft") {
    throw new DomainError(
      "VERSION_NOT_EDITABLE",
      "Solo se asocian documentos a un borrador: una versión publicada es inmutable.",
      409,
    );
  }

  const topic = version.topics.find((item) => item.id === meta.topicId);
  if (!topic) {
    throw new DomainError(
      "TOPIC_NOT_IN_COURSE",
      "El tema para el que se subió el documento ya no existe en esta versión.",
      404,
    );
  }

  const reference: TopicDocumentDefinition = {
    id: meta.documentId,
    title: meta.title,
    pageCount: meta.pageCount,
  };

  const already = topic.documents.some((document) => document.id === meta.documentId);
  if (already) {
    return {
      courseId: meta.courseId,
      version: meta.version,
      revision: version.revision ?? 0,
      topicId: meta.topicId,
      documentId: meta.documentId,
      attached: false,
    };
  }

  const keys = await deps.catalog.getAnswerKeys(meta.courseId, meta.version);
  const definition = definitionFromDocuments(version, keys);

  const merged = {
    ...definition,
    topics: definition.topics.map((item) =>
      item.id === meta.topicId
        ? { ...item, documents: [...item.documents, reference] }
        : item,
    ),
  };

  const issues = checkDraftStructure(merged).filter((issue) => issue.severity === "error");
  if (issues.length > 0) {
    throw new DomainError("COURSE_STRUCTURE_INVALID", issues[0].message, 400, { issues });
  }

  const versionDoc = toPublicVersion(merged, {
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    status: "draft",
  });
  versionDoc.revision = input.expectedRevision + 1;

  const answerKeys = toAnswerKeys(merged, {
    createdAt: keys?.createdAt ?? version.createdAt,
  });

  await deps.catalog.replaceDraftContent({
    versionDoc,
    answerKeys,
    expectedRevision: input.expectedRevision,
  });

  return {
    courseId: meta.courseId,
    version: meta.version,
    revision: versionDoc.revision,
    topicId: meta.topicId,
    documentId: meta.documentId,
    attached: true,
  };
}
