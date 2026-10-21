#!/usr/bin/env node
/**
 * MEDIDA DEL PAYLOAD REAL DE UNA SUBIDA DE PDF
 * ============================================
 *
 *   node scripts/firestore-size-check.mjs
 *
 * Usa el serializador y los protos oficiales de `@google-cloud/firestore`
 * (ver `src/server/firestore/wire-size.ts`) para medir cuántos bytes viajan de
 * verdad en el commit de subida: fragmentos + metadatos + contador.
 *
 * Lo que este script demuestra: el tamaño exacto del mensaje.
 * Lo que NO demuestra: que Firestore lo acepte. Para eso hace falta el
 * emulador o un proyecto de pruebas (ver docs/INFORME-FASE-7.md).
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));

const CHUNK_BYTES = 768 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT = 1024 * 1024;
const MAX_REQUEST = 10 * 1024 * 1024;

const proto = require(
  join(process.cwd(), "node_modules/@google-cloud/firestore/build/protos/firestore_v1_proto_api.js"),
);
const { Serializer } = require(
  join(process.cwd(), "node_modules/@google-cloud/firestore/build/src/serializer.js"),
);
const serializer = new Serializer({ _settings: { ignoreUndefinedProperties: false } });

const ROOT = "projects/demo-formacion/databases/(default)/documents";

function documentBytes(path, data) {
  return proto.google.firestore.v1.Document.encode({
    name: `${ROOT}/${path}`,
    fields: serializer.encodeFields(data),
  }).finish().length;
}

function commitBytes(writes) {
  return proto.google.firestore.v1.CommitRequest.encode({
    database: "projects/demo-formacion/databases/(default)",
    writes: writes.map((write) => ({
      update: { name: `${ROOT}/${write.path}`, fields: serializer.encodeFields(write.data) },
      currentDocument: { exists: false },
    })),
    transaction: Buffer.alloc(16),
  }).finish().length;
}

function measure(pdfBytes) {
  const chunks = Math.ceil(pdfBytes / CHUNK_BYTES);
  const sha = "a".repeat(64);
  const chunkLengths = Array.from({ length: chunks }, (_, index) =>
    Math.min(CHUNK_BYTES, pdfBytes - index * CHUNK_BYTES),
  );

  const writes = chunkLengths.map((length, index) => ({
    path: `pdfChunks/doc-medida_${index}`,
    data: {
      documentId: "doc-medida",
      index,
      data: Buffer.alloc(length, 1),
      sha256OfDocument: sha,
    },
  }));

  writes.push({
    path: "documents/doc-medida",
    data: {
      documentId: "doc-medida",
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
    data: { usedBytes: pdfBytes, updatedAt: "2026-03-01T10:00:00.000Z" },
  });

  const sizes = writes.map((write) => documentBytes(write.path, write.data));
  const total = commitBytes(writes);
  const largest = Math.max(...sizes);

  return { pdfBytes, chunks, largest, total, docOk: largest <= MAX_DOCUMENT, reqOk: total <= MAX_REQUEST };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

console.log("MEDIDA DEL PAYLOAD DE SUBIDA (serializador y protos oficiales)\n");
console.log("| PDF | Fragmentos | Documento mayor | Commit total | ≤1 MiB/doc | ≤10 MiB/petición |");
console.log("| --- | --- | --- | --- | --- | --- |");

const cases = [
  ["vacío (rechazado antes)", 0],
  ["1 MiB", 1024 * 1024],
  ["5 MiB", 5 * 1024 * 1024],
  ["8 MiB (tope actual)", MAX_PDF_BYTES],
  ["9 MiB (12 fragmentos)", 9 * 1024 * 1024],
  ["20 MiB (diseño anterior)", 20 * 1024 * 1024],
];

let failed = false;
for (const [label, size] of cases) {
  if (size === 0) {
    console.log(`| ${label} | 0 | — | — | — | — |`);
    continue;
  }
  const measured = measure(size);
  if (!measured.reqOk && size <= MAX_PDF_BYTES) failed = true;
  console.log(
    `| ${label} | ${measured.chunks} | ${kb(measured.largest)} | ${mb(measured.total)} | ${
      measured.docOk ? "sí" : "NO"
    } | ${measured.reqOk ? "sí" : "NO"} |`,
  );
}

const current = measure(MAX_PDF_BYTES);
const previous = measure(20 * 1024 * 1024);

console.log("\nConclusiones medidas (no estimadas):");
console.log(
  `  · Con el tope actual (8 MiB) el commit mide ${mb(current.total)} y deja ${mb(
    MAX_REQUEST - current.total,
  )} de margen.`,
);
console.log(
  `  · El diseño anterior (20 MiB, ${previous.chunks} fragmentos) medía ${mb(
    previous.total,
  )}: superaba el límite de 10 MiB por petición en ${mb(
    previous.total - MAX_REQUEST,
  )}. Era un defecto real, no una hipótesis.`,
);
console.log(
  `  · El fragmento mayor ocupa ${kb(current.largest)} de los 1 MiB permitidos por documento.`,
);
console.log("\nLímite de esta comprobación: mide el mensaje, no la respuesta del servidor.");

if (failed) {
  console.error("\nFALLO: el tope configurado no cabe en una petición de 10 MiB.");
  process.exit(1);
}
