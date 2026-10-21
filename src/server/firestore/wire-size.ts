import { createRequire } from "node:module";
import { join } from "node:path";
import { CHUNK_BYTES, MAX_PDF_BYTES } from "@/domain/storage/pdf-chunks";

/**
 * MEDIDA REAL DEL TAMAÑO QUE VIAJA A FIRESTORE
 * ============================================
 *
 * Los límites de Firestore —1 MiB por documento y 10 MiB por petición— se
 * aplican al **protobuf codificado**, no a la aritmética de los bytes que uno
 * cree estar enviando. Contar "768 KiB × 11" es una estimación; esto mide el
 * payload de verdad.
 *
 * Qué hace y qué no:
 *
 *   ✔ usa el **serializador oficial** del SDK de Firestore
 *     (`@google-cloud/firestore`, el que usa `firebase-admin`) para convertir
 *     valores (Bytes, Timestamps, mapas, arrays) al formato de cable;
 *   ✔ usa los **protos oficiales** (`google.firestore.v1.Document` y
 *     `CommitRequest`) y `protobufjs` para codificarlos, así que el número que
 *     sale es el tamaño exacto del mensaje que se enviaría;
 *   ✘ **no** demuestra que el servidor lo acepte: eso solo lo dice Firestore
 *     (emulador o real). Mide el payload, no la respuesta.
 *
 * Por qué se accede a rutas internas del SDK: la API pública no expone el
 * serializador ni los protos. Se resuelven con ruta absoluta y `createRequire`
 * y se comprueba al cargar que existen las funciones esperadas, para que la
 * prueba falle de forma explícita si el SDK cambia, en lugar de medir mal.
 */

interface FirestoreProto {
  google: {
    firestore: {
      v1: {
        Document: { encode: (message: unknown) => { finish(): Uint8Array } };
        CommitRequest: { encode: (message: unknown) => { finish(): Uint8Array } };
      };
    };
  };
}

interface SerializerLike {
  encodeFields(value: Record<string, unknown>): Record<string, unknown>;
}

export const FIRESTORE_MAX_DOCUMENT_BYTES = 1_048_576;
export const FIRESTORE_MAX_REQUEST_BYTES = 10 * 1_048_576;

const requireInternals = createRequire(join(process.cwd(), "package.json"));

function loadProto(): FirestoreProto {
  return requireInternals(
    join(process.cwd(), "node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js"),
  ) as FirestoreProto;
}

function loadSerializer(): SerializerLike {
  const serializerModule = requireInternals(
    join(process.cwd(), "node_modules/@google-cloud/firestore/build/src/serializer.js"),
  ) as { Serializer: new (firestore: unknown) => SerializerLike };

  // El constructor solo consulta `_settings.ignoreUndefinedProperties`.
  const serializer = new serializerModule.Serializer({
    _settings: { ignoreUndefinedProperties: false },
  });
  if (typeof serializer.encodeFields !== "function") {
    throw new Error(
      "El SDK de Firestore cambió: no existe Serializer.encodeFields. Revisa scripts/firestore-size-check.mjs.",
    );
  }
  return serializer;
}

let cachedSerializer: SerializerLike | null = null;

function serializer(): SerializerLike {
  cachedSerializer ??= loadSerializer();
  return cachedSerializer;
}

/** Bytes del documento codificado (el límite de 1 MiB se aplica a esto). */
export function documentBytes(path: string, data: Record<string, unknown>): number {
  const proto = loadProto();
  const fields = serializer().encodeFields(data);
  const document = {
    name: `projects/demo-formacion/databases/(default)/documents/${path}`,
    fields,
  };
  return proto.google.firestore.v1.Document.encode(document).finish().length;
}

export interface WriteMeasurement {
  path: string;
  data: Record<string, unknown>;
  /** Se rellena en `measureUpload` con `documentBytes`. */
  bytes: number;
}

/**
 * Bytes de un `CommitRequest` con esas escrituras (el límite de 10 MiB se
 * aplica al mensaje de la petición).
 */
export function commitBytes(writes: Array<Pick<WriteMeasurement, "path" | "data">>): number {
  const proto = loadProto();

  const message = {
    database: "projects/demo-formacion/databases/(default)",
    writes: writes.map((write) => ({
      update: {
        name: `projects/demo-formacion/databases/(default)/documents/${write.path}`,
        fields: serializer().encodeFields(write.data),
      },
      currentDocument: { exists: false },
    })),
    transaction: Buffer.alloc(16),
  };

  return proto.google.firestore.v1.CommitRequest.encode(message).finish().length;
}

export interface UploadMeasurement {
  /** Tamaño del PDF medido. */
  pdfBytes: number;
  chunks: number;
  /** Tamaño del fragmento más grande (todos iguales salvo el último). */
  largestChunkBytes: number;
  /** Metadatos + contador. */
  metaBytes: number;
  counterBytes: number;
  /** Estimación del commit completo. */
  commitTotalBytes: number;
  /** ¿Cabe cada documento en 1 MiB? */
  documentFits: boolean;
  /** ¿Cabe la petición completa en 10 MiB? */
  requestFits: boolean;
  /** Margen restante frente al límite de 10 MiB. */
  requestMarginBytes: number;
}

/**
 * Reproduce exactamente lo que escribe `FirestorePdfDocumentStore.saveDocument`
 * (mismos nombres de campo) y mide el resultado.
 */
export function measureUpload(pdfBytes: number, options: { documentId?: string } = {}): UploadMeasurement {
  const documentId = options.documentId ?? "doc-medida";
  // Aritmética propia a propósito: `chunkCount()` aplica los límites vigentes y
  // aquí hay que poder medir también diseños que hoy se rechazan (el tope de
  // 20 MiB anterior) para comparar.
  const totalChunks = Math.ceil(pdfBytes / CHUNK_BYTES);
  const sha = "a".repeat(64);
  const chunkLengths = Array.from({ length: totalChunks }, (_, index) =>
    Math.min(CHUNK_BYTES, pdfBytes - index * CHUNK_BYTES),
  );

  const writes: (WriteMeasurement & { data: Record<string, unknown> })[] = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const length = chunkLengths[index];
    writes.push({
      path: `pdfChunks/${documentId}_${index}`,
      bytes: 0,
      data: {
        documentId,
        index,
        data: Buffer.alloc(length, 1),
        sha256OfDocument: sha,
      },
    });
  }

  writes.push({
    path: `documents/${documentId}`,
    bytes: 0,
    data: {
      documentId,
      courseId: "curso-a",
      version: 1,
      topicId: "tema-1",
      title: "Tema 1 — Apuntes del tema",
      pageCount: 40,
      bytes: pdfBytes,
      sha256: sha,
      chunkLengths,
      uploadedBy: "admin-uid-0001",
      uploadedAt: "2026-03-01T10:00:00.000Z",
      archived: false,
    },
  });

  writes.push({
    path: "meta/storage",
    bytes: 0,
    data: { usedBytes: pdfBytes, updatedAt: "2026-03-01T10:00:00.000Z" },
  });

  for (const write of writes) write.bytes = documentBytes(write.path, write.data);

  const commitTotalBytes = commitBytes(writes.map(({ path, data }) => ({ path, data })));
  const largestChunkBytes =
    totalChunks === 0 ? 0 : Math.max(...writes.slice(0, totalChunks).map((write) => write.bytes));
  const meta = writes.find((write) => write.path.startsWith("documents/"));
  const counter = writes.find((write) => write.path === "meta/storage");

  return {
    pdfBytes,
    chunks: totalChunks,
    largestChunkBytes,
    metaBytes: meta?.bytes ?? 0,
    counterBytes: counter?.bytes ?? 0,
    commitTotalBytes,
    documentFits: writes.every((write) => write.bytes <= FIRESTORE_MAX_DOCUMENT_BYTES),
    requestFits: commitTotalBytes <= FIRESTORE_MAX_REQUEST_BYTES,
    requestMarginBytes: FIRESTORE_MAX_REQUEST_BYTES - commitTotalBytes,
  };
}

/** Medida del tope configurado (8 MiB) y del diseño anterior (20 MiB). */
export function referenceMeasurements(): { current: UploadMeasurement; previous: UploadMeasurement } {
  return { current: measureUpload(MAX_PDF_BYTES), previous: measureUpload(20 * 1024 * 1024) };
}
