import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportBackup } from "@/server/backup/export";
import { restoreBackup } from "@/server/backup/restore";
import { readManifest } from "@/server/backup/archive";
import { encodeValue, decodeValue, mapTimestamps } from "@/server/backup/codec";
import { canonicalJson } from "@/server/backup/codec";
import { InMemoryFirestore } from "../helpers/backup-double";
import type { BackupSource } from "@/server/backup/store";

/**
 * COPIAS DE SEGURIDAD: RECORRIDO COMPLETO
 * =======================================
 *
 * Exportar → cifrar → escribir archivo → leer archivo → descifrar → validar →
 * restaurar → comparar. Todo con datos sintéticos, en un directorio temporal.
 *
 * Lo que estas pruebas demuestran: el formato, el cifrado, la verificación de
 * integridad, el troceado en lotes, la negativa a sobrescribir y que lo
 * restaurado es idéntico a lo exportado.
 *
 * Lo que NO demuestran: el I/O de Firestore (el adaptador real no se ha
 * ejecutado: el emulador no está disponible en este entorno). El doble
 * reproduce las invariantes del almacén, no su comportamiento exacto.
 */

const PASS = "frase de paso larga para la copia 2026";
const dir = mkdtempSync(join(tmpdir(), "formacion-backup-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHUNK = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));

function syntheticStore(): InMemoryFirestore {
  const store = new InMemoryFirestore();

  store.seed("accounts/learner-1", {
    uid: "learner-1",
    firstName: "Lucía",
    lastName1: "García",
    username: "lucia.garcia",
    role: "learner",
    status: "active",
    claimsVersion: 1,
    createdAt: "2026-01-10T09:00:00.000Z",
  });
  store.seed("usernames/lucia.garcia", { uid: "learner-1" });
  store.seed("activationTokens/abc123hash", { uid: "learner-1", usedAt: null });
  store.seed("audits/audit-1", { type: "people_import", actorUid: "admin-1" });

  store.seed("courses/curso-a", {
    title: "Prevención",
    publishedVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.seed("courses/curso-a/versions/1", {
    version: 1,
    status: "published",
    topics: [{ id: "tema-1", title: "Tema 1", documents: [{ id: "doc-1" }] }],
  });

  store.seed("answerKeys/curso-a_1_q1", {
    courseId: "curso-a",
    version: 1,
    answers: [{ id: "q1", correctOptionIds: ["b"] }],
  });

  store.seed("enrollments/learner-1_curso-a", {
    uid: "learner-1",
    courseId: "curso-a",
    status: "active",
    version: 1,
  });

  store.seed("progress/learner-1_curso-a", {
    uid: "learner-1",
    courseId: "curso-a",
    version: 1,
    documents: { "doc-1": { totalPages: 10, lastPageViewed: 10, completedAt: "2026-02-01T10:00:00.000Z" } },
    updatedAt: { $timestamp: { seconds: 1_769_947_200, nanoseconds: 0 } },
  });
  store.seed("progressHistory/learner-1_curso-a_v0", { uid: "learner-1", version: 0 });
  store.seed("attempts/attempt-1", {
    uid: "learner-1",
    courseId: "curso-a",
    passed: true,
    gradedBy: "server",
  });

  store.seed("documents/doc-1", {
    courseId: "curso-a",
    version: 1,
    topicId: "tema-1",
    title: "Apuntes",
    pageCount: 10,
    bytes: CHUNK.length,
    sha256: "f".repeat(64),
    chunkLengths: [CHUNK.length],
  });
  store.seed("pdfChunks/doc-1_0", {
    documentId: "doc-1",
    index: 0,
    data: CHUNK,
    sha256OfDocument: "f".repeat(64),
  });

  store.seed("meta/storage", { usedBytes: CHUNK.length });
  store.seed("meta/schema", { schemaVersion: 1, collections: ["accounts", "courses"] });

  return store;
}

async function exportTo(name: string, store = syntheticStore()) {
  const outPath = join(dir, name);
  const result = await exportBackup({
    source: store.asSource(),
    passphrase: PASS,
    outPath,
    createdAt: new Date("2026-10-21T12:00:00.000Z"),
  });
  return { ...result, outPath, store };
}

describe("exportación", () => {
  it("incluye todas las colecciones, también las subcolecciones de cursos", async () => {
    const { manifest } = await exportTo("basic.fbak");
    const names = manifest.collections.map((collection) => collection.name).sort();

    expect(names).toContain("courses");
    expect(names).toContain("courses/curso-a/versions");
    expect(names).toContain("pdfChunks");
    expect(names).toContain("answerKeys");
    expect(names).toContain("enrollments");
    expect(names).toContain("meta");

    expect(manifest.records).toBe(15);
    expect(manifest.collections.find((item) => item.name === "pdfChunks")?.records).toBe(1);
    expect(manifest.createdAt).toBe("2026-10-21T12:00:00.000Z");
    expect(manifest.schemaVersion).toBe(1);
  });

  it("el archivo en disco no contiene datos legibles ni la contraseña", async () => {
    const { outPath } = await exportTo("opaque.fbak");
    const bytes = readFileSync(outPath);

    for (const secret of [
      "Lucía",
      "García",
      "correctOptionIds",
      "lucia.garcia",
      "Prevención",
      PASS,
      CHUNK.toString("base64").slice(0, 40),
    ]) {
      expect(bytes.includes(Buffer.from(secret, "utf8")), `no debe aparecer «${secret}»`).toBe(false);
    }

    // El manifiesto sí es legible, pero solo tiene metadatos.
    const manifest = await readManifest(outPath);
    expect(JSON.stringify(manifest)).not.toContain("Lucía");
    expect(JSON.stringify(manifest)).not.toContain("correctOptionIds");
  });

  it("rechaza una contraseña corta", async () => {
    await expect(
      exportBackup({ source: syntheticStore().asSource(), passphrase: "corta", outPath: join(dir, "x.fbak") }),
    ).rejects.toMatchObject({ code: "BACKUP_PASSPHRASE_WEAK" });
  });

  it("se detiene ante un tipo de dato que no sabe representar", async () => {
    const store = new InMemoryFirestore();
    // Un valor indefinido no se puede representar: la copia debe detenerse en
    // lugar de guardar un hueco que parezca una copia válida.
    store.seed("meta/raro", { cuando: undefined });

    await expect(exportBackup({ source: store.asSource(), passphrase: PASS, outPath: join(dir, "raro.fbak") }))
      .rejects.toMatchObject({ code: "BACKUP_UNSUPPORTED_VALUE" });
  });

  it("rechaza rutas que no pertenecen a la colección exportada", async () => {
    const rogue: BackupSource = {
      collections: async () => ["accounts"],
      read: async function* () {
        yield { path: "courses/curso-a", data: { title: "colado" } };
      },
    };

    await expect(
      exportBackup({ source: rogue, passphrase: PASS, outPath: join(dir, "rogue.fbak") }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID_PATH" });
  });
});

describe("restauración", () => {
  it("restaura exactamente lo exportado, incluidos los bytes de los PDF", async () => {
    const { outPath, store } = await exportTo("roundtrip.fbak");
    const target = new InMemoryFirestore();

    const result = await restoreBackup({
      inPath: outPath,
      passphrase: PASS,
      target: target.asTarget(),
    });

    expect(result.records).toBe(15);
    expect(result.totalInTargetAfter).toBe(15);

    expect([...target.docs.keys()].sort()).toEqual([...store.docs.keys()].sort());

    for (const path of store.docs.keys()) {
      expect(canonicalJson(target.get(path)), path).toBe(canonicalJson(store.get(path)));
    }

    const chunk = target.get("pdfChunks/doc-1_0")?.data;
    expect(Buffer.isBuffer(chunk)).toBe(true);
    expect(Buffer.compare(chunk as Buffer, CHUNK)).toBe(0);

    const keys = target.get("answerKeys/curso-a_1_q1");
    expect(JSON.stringify(keys)).toContain("correctOptionIds");
  });

  it("--dry-run valida la copia sin escribir nada", async () => {
    const { outPath } = await exportTo("dryrun.fbak");
    const target = new InMemoryFirestore();

    const result = await restoreBackup({
      inPath: outPath,
      passphrase: PASS,
      target: target.asTarget(),
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.records).toBe(15);
    expect(target.docs.size).toBe(0);
    expect(target.writes).toBe(0);
  });

  it("no restaura sobre un destino con datos salvo con force", async () => {
    const { outPath } = await exportTo("occupied.fbak");
    const target = new InMemoryFirestore();
    target.seed("accounts/ajena", { uid: "ajena" });

    await expect(
      restoreBackup({ inPath: outPath, passphrase: PASS, target: target.asTarget() }),
    ).rejects.toMatchObject({ code: "BACKUP_TARGET_NOT_EMPTY", status: 409 });

    expect(target.docs.size).toBe(1);

    const forced = await restoreBackup({
      inPath: outPath,
      passphrase: PASS,
      target: target.asTarget(),
      force: true,
    });
    expect(forced.records).toBe(15);
    expect(target.docs.has("accounts/ajena")).toBe(true); // force no borra: sobrescribe las rutas de la copia
  });

  it("con la contraseña incorrecta no escribe nada", async () => {
    const { outPath } = await exportTo("wrongpass.fbak");
    const target = new InMemoryFirestore();

    await expect(
      restoreBackup({ inPath: outPath, passphrase: "otra frase larguísima 2026", target: target.asTarget() }),
    ).rejects.toThrow();

    expect(target.docs.size).toBe(0);
  });

  it("detecta un archivo manipulado", async () => {
    const { outPath } = await exportTo("tampered.fbak");
    const bytes = readFileSync(outPath);
    // Se altera un byte del primer bloque cifrado (sin tocar el manifiesto).
    bytes[40] = bytes[40] ^ 0xff;
    const tampered = join(dir, "tampered-2.fbak");
    writeFileSync(tampered, bytes);

    const target = new InMemoryFirestore();
    await expect(
      restoreBackup({ inPath: tampered, passphrase: PASS, target: target.asTarget() }),
    ).rejects.toThrow();

    expect(target.docs.size).toBe(0);
  });

  it("detecta un manifiesto que declara otro número de documentos", async () => {
    const { outPath, manifest } = await exportTo("badcount.fbak");
    const bytes = readFileSync(outPath);
    const manifestText = JSON.stringify({ ...manifest, records: manifest.records + 1 });
    const offset = bytes.length - Buffer.byteLength(JSON.stringify(manifest), "utf8");
    const forged = Buffer.concat([bytes.subarray(0, offset), Buffer.from(manifestText, "utf8")]);
    // La cabecera sigue apuntando al mismo desplazamiento: el manifiesto nuevo
    // ocupa otro tamaño, así que se reescribe también el puntero.
    const pointer = Buffer.alloc(4);
    pointer.writeUInt32BE(offset, 0);
    pointer.copy(forged, 19);
    const path = join(dir, "badcount-2.fbak");
    writeFileSync(path, forged);

    await expect(
      restoreBackup({ inPath: path, passphrase: PASS, target: new InMemoryFirestore().asTarget() }),
    ).rejects.toMatchObject({ code: "BACKUP_COUNT_MISMATCH" });
  });

  it("no escribe un documento si su lote falla y no declara la restauración como buena", async () => {
    const { outPath } = await exportTo("batchfail.fbak");
    const target = new InMemoryFirestore();
    target.failOnBatch = 2;

    await expect(
      restoreBackup({
        inPath: outPath,
        passphrase: PASS,
        target: target.asTarget(),
        batchRecords: 5,
      }),
    ).rejects.toMatchObject({ code: "SIMULATED_BATCH_FAILURE" });

    // Lo ya escrito de lotes anteriores permanece: la restauración NO es global
    // y atómica. Está documentado en el informe.
    expect(target.docs.size).toBeGreaterThan(0);
    expect(target.docs.size).toBeLessThan(15);
  });

  it("respeta el tamaño de lote configurado", async () => {
    const { outPath } = await exportTo("batching.fbak");
    const target = new InMemoryFirestore();
    const sizes: number[] = [];
    const inner = target.asTarget();

    await restoreBackup({
      inPath: outPath,
      passphrase: PASS,
      target: {
        isEmpty: inner.isEmpty,
        count: inner.count,
        write: async (records) => {
          sizes.push(records.length);
          await inner.write(records);
        },
      },
      batchRecords: 4,
    });

    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
    expect(sizes.reduce((sum, value) => sum + value, 0)).toBe(15);
  });

  it("rechaza una copia que no es de Formación", async () => {
    const path = join(dir, "ajeno.fbak");
    writeFileSync(path, Buffer.from("no soy una copia", "utf8"));

    await expect(
      restoreBackup({ inPath: path, passphrase: PASS, target: new InMemoryFirestore().asTarget() }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
  });
});

describe("codificación de valores", () => {
  it("los Bytes vuelven idénticos", () => {
    const encoded = encodeValue(CHUNK);
    const decoded = decodeValue(encoded) as Buffer;

    expect(encoded).toEqual({ $bytes: CHUNK.toString("base64") });
    expect(Buffer.compare(decoded, CHUNK)).toBe(0);
  });

  it("un Timestamp se guarda con segundos y nanosegundos exactos", () => {
    const stamp = { seconds: 1_700_000_000, nanoseconds: 123_456_789, toMillis: () => 0 };
    const decoded = decodeValue(encodeValue(stamp)) as { $timestamp: { seconds: number; nanoseconds: number } };

    expect(decoded.$timestamp).toEqual({ seconds: 1_700_000_000, nanoseconds: 123_456_789 });
  });

  it("las marcas de tiempo se convierten al escribir en Firestore", () => {
    const converted = mapTimestamps(
      { cuando: { $timestamp: { seconds: 10, nanoseconds: 20 } }, lista: [1, "dos"] },
      (stamp) => `ts:${stamp.seconds}.${stamp.nanoseconds}`,
    );

    expect(converted).toEqual({ cuando: "ts:10.20", lista: [1, "dos"] });
  });

  it("rechaza valores que perderían información", () => {
    for (const value of [undefined, Number.NaN, { anidado: undefined }]) {
      expect(() => encodeValue(value)).toThrow();
    }
  });

  it("el JSON canónico no depende del orden de las claves", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
