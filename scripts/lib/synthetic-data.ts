import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, META_DOC, SCHEMA_VERSION } from "../../src/server/db/schema.constants";

/**
 * DATOS SINTÉTICOS COMPARTIDOS
 * ============================
 *
 * Un único conjunto de documentos inventados para el emulador, usado por
 * `npm run seed:synthetic` y por `npm run rehearse:backup`. Todos los valores
 * son falsos y reconocibles: nombres «Sintético», correos `@example.invalid`,
 * curso `curso-sintetico` y binario de relleno.
 *
 * Se mantiene aparte del script para que la reposición y el ensayo de copias
 * no puedan divergir (si divergen, el ensayo compararía cosas distintas).
 */

export const SYNTHETIC_CHUNK = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));

export const SYNTHETIC_DOCUMENTS: Array<{ path: string; data: Record<string, unknown> }> = [
  {
    path: "accounts/sintetico-admin",
    data: {
      uid: "sintetico-admin",
      firstName: "Admin",
      lastName1: "Sintético",
      email: "sintetico.admin@example.invalid",
      username: "admin.sintetico",
      role: "admin",
      status: "active",
      claimsVersion: 1,
      createdAt: Timestamp.fromDate(new Date("2026-01-01T09:00:00.000Z")),
    },
  },
  {
    path: "accounts/sintetico-alumno",
    data: {
      uid: "sintetico-alumno",
      firstName: "Alumno",
      lastName1: "Sintético",
      email: "sintetico.alumno@example.invalid",
      username: "alumno.sintetico",
      role: "learner",
      status: "active",
      claimsVersion: 1,
      createdAt: Timestamp.fromDate(new Date("2026-01-02T09:00:00.000Z")),
    },
  },
  { path: "usernames/alumno.sintetico", data: { uid: "sintetico-alumno" } },
  { path: "usernames/admin.sintetico", data: { uid: "sintetico-admin" } },
  {
    path: "activationTokens/hash-sintetico-1",
    data: {
      uid: "sintetico-alumno",
      usedAt: null,
      createdAt: Timestamp.fromDate(new Date("2026-01-02T09:00:00.000Z")),
    },
  },
  {
    path: "audits/auditoria-sintetica-1",
    data: {
      type: "people_import",
      actorUid: "sintetico-admin",
      at: Timestamp.fromDate(new Date("2026-01-02T09:10:00.000Z")),
    },
  },
  {
    path: "courses/curso-sintetico",
    data: {
      title: "Curso sintético de prueba",
      description: "Contenido inventado para ensayar copias y restauración.",
      publishedVersion: 1,
      createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z")),
      updatedAt: Timestamp.fromDate(new Date("2026-01-05T00:00:00.000Z")),
    },
  },
  {
    path: "courses/curso-sintetico/versions/1",
    data: {
      version: 1,
      status: "published",
      title: "Curso sintético de prueba",
      description: "Contenido inventado.",
      topics: [
        {
          id: "tema-sintetico",
          title: "Tema sintético",
          order: 1,
          mandatory: true,
          documents: [{ id: "doc-sintetico", title: "Apuntes sintéticos", pageCount: 10 }],
          quizPublic: [
            { id: "q-sintetica", type: "single", optionIds: ["a", "b"], prompt: "¿Pregunta?" },
          ],
        },
      ],
      finalExamPublic: [
        { id: "q-final-sintetica", type: "single", optionIds: ["a", "b"], prompt: "¿Final?" },
      ],
      publishedAt: Timestamp.fromDate(new Date("2026-01-05T00:00:00.000Z")),
      publishedBy: "sintetico-admin",
    },
  },
  {
    path: "answerKeys/curso-sintetico_1_q-sintetica",
    data: {
      courseId: "curso-sintetico",
      version: 1,
      answers: [{ id: "q-sintetica", correctOptionIds: ["a"] }],
    },
  },
  {
    path: "enrollments/sintetico-alumno_curso-sintetico",
    data: {
      uid: "sintetico-alumno",
      courseId: "curso-sintetico",
      status: "active",
      version: 1,
      enrolledAt: "2026-01-06T10:00:00.000Z",
      enrolledBy: "sintetico-admin",
      updatedAt: "2026-01-06T10:00:00.000Z",
    },
  },
  {
    path: "progress/sintetico-alumno_curso-sintetico",
    data: {
      uid: "sintetico-alumno",
      courseId: "curso-sintetico",
      version: 1,
      topics: {},
      documents: { "doc-sintetico": { totalPages: 10, lastPageViewed: 3, completedAt: null } },
      completedAt: null,
      updatedAt: Timestamp.fromDate(new Date("2026-01-07T10:00:00.000Z")),
    },
  },
  {
    path: "attempts/intento-sintetico-1",
    data: {
      uid: "sintetico-alumno",
      courseId: "curso-sintetico",
      version: 1,
      assessmentType: "topic",
      topicId: "tema-sintetico",
      passed: false,
      gradedBy: "server",
      at: Timestamp.fromDate(new Date("2026-01-08T10:00:00.000Z")),
    },
  },
  {
    path: "documents/doc-sintetico",
    data: {
      documentId: "doc-sintetico",
      courseId: "curso-sintetico",
      version: 1,
      topicId: "tema-sintetico",
      title: "Apuntes sintéticos",
      pageCount: 10,
      bytes: SYNTHETIC_CHUNK.length,
      sha256: "0".repeat(64),
      chunkLengths: [SYNTHETIC_CHUNK.length],
      uploadedBy: "sintetico-admin",
      uploadedAt: "2026-01-06T09:00:00.000Z",
      archived: false,
    },
  },
  {
    path: "pdfChunks/doc-sintetico_0",
    data: {
      documentId: "doc-sintetico",
      index: 0,
      data: SYNTHETIC_CHUNK,
      sha256OfDocument: "0".repeat(64),
    },
  },
  { path: "meta/storage", data: { usedBytes: SYNTHETIC_CHUNK.length } },
  {
    path: META_DOC.collection + "/" + META_DOC.id,
    data: { schemaVersion: SCHEMA_VERSION, collections: Object.values(COLLECTIONS) },
  },
];

/** Borra las colecciones conocidas (solo emulador). Devuelve cuántos documentos quitó. */
export async function resetEmulatorCollections(db: Firestore): Promise<number> {
  let removed = 0;

  for (const collection of new Set(Object.values(COLLECTIONS))) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      for (const subcollection of await document.ref.listCollections()) {
        const subs = await subcollection.get();
        await Promise.all(subs.docs.map((item) => item.ref.delete()));
        removed += subs.size;
      }
      await document.ref.delete();
      removed += 1;
    }
  }

  return removed;
}
