#!/usr/bin/env node
/**
 * COMPROBACIÓN DE LA BASE DE DATOS (solo lectura)
 * ===============================================
 *
 *   npm run db:check
 *
 * No escribe nada. Sirve para:
 *   - comprobar que hay conectividad real (no solo variables definidas);
 *   - verificar que el esquema está inicializado y en la versión esperada;
 *   - auditar cuentas, administradores, cursos, claves, progreso e intentos;
 *   - detectar índices que faltan ejecutando las consultas reales y leyendo el
 *     error de Firestore (que incluye el enlace para crearlos).
 *
 * Código de salida: 0 si no hay errores, 1 si hay algún `error`.
 * (Los `warning` no hacen fallar la comprobación, pero se muestran.)
 *
 * En un proyecto real exige `DB_ALLOW_PROD=yes` de forma explícita: es solo
 * lectura, pero conviene que nadie apunte a producción por descuido.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  COLLECTIONS,
  META_DOC,
  SCHEMA_VERSION,
} from "../src/server/db/schema.constants";
import {
  runChecks,
  summarize,
  type AccountLite,
  type AnswerKeysLite,
  type AttemptLite,
  type CourseLite,
  type ProgressLite,
  type VersionLite,
} from "../src/server/db/checks";
import { budgetBytesFromMiB } from "../src/domain/storage/pdf-chunks";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const allowProd = process.env.DB_ALLOW_PROD === "yes";
const MAX_DOCS = 2000;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function buildApp() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) fail("Falta FIREBASE_PROJECT_ID.");
  if (getApps().length > 0) return getApps()[0];

  if (emulatorHost) return initializeApp({ projectId });

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    fail("Faltan FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.");
  }
  return initializeApp({
    projectId,
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
}

async function readCollection<T>(
  db: FirebaseFirestore.Firestore,
  name: string,
): Promise<T[]> {
  const snapshot = await db.collection(name).limit(MAX_DOCS).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as object) }) as T);
}

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const isEmulator = Boolean(emulatorHost);

  console.log("\n=== Comprobación de la base de datos de Formación ===");
  console.log(`Proyecto: ${projectId ?? "(sin definir)"}`);
  console.log(`Modo:     ${isEmulator ? `emulador (${emulatorHost})` : "Firebase real"}`);

  if (!isEmulator && !allowProd) {
    fail(
      "Apuntas a un proyecto real. Esta comprobación es de solo lectura; si es intencionado, añade DB_ALLOW_PROD=yes.",
    );
  }

  const db = getFirestore(buildApp());

  // Conectividad
  try {
    await db.doc(`${META_DOC.collection}/${META_DOC.id}`).get();
    console.log("✓ Conectividad con Firestore comprobada.\n");
  } catch (error) {
    fail(
      `No se puede hablar con Firestore: ${error instanceof Error ? error.message.split("\n")[0] : "error"}`,
    );
  }

  // Índices: se ejecutan las consultas reales y se detecta FAILED_PRECONDITION.
  const indexProblems: string[] = [];
  const indexQueries: Array<{ label: string; run: () => Promise<unknown> }> = [
    {
      label: "accounts(status, createdAt)",
      run: () =>
        db.collection(COLLECTIONS.accounts).where("status", "==", "active").orderBy("createdAt", "desc").limit(1).get(),
    },
    {
      label: "accounts(role, status)",
      run: () =>
        db.collection(COLLECTIONS.accounts).where("role", "==", "admin").where("status", "==", "active").limit(1).get(),
    },
    {
      label: "progress(uid, updatedAt)",
      run: () =>
        db.collection(COLLECTIONS.progress).where("uid", "==", "sin-uso").orderBy("updatedAt", "desc").limit(1).get(),
    },
    {
      label: "progress(courseId, version, completedAt)",
      run: () =>
        db
          .collection(COLLECTIONS.progress)
          .where("courseId", "==", "sin-uso")
          .where("version", "==", 1)
          .orderBy("completedAt", "desc")
          .limit(1)
          .get(),
    },
    {
      label: "attempts(uid, at)",
      run: () =>
        db.collection(COLLECTIONS.attempts).where("uid", "==", "sin-uso").orderBy("at", "desc").limit(1).get(),
    },
    {
      label: "attempts(courseId, version, at)",
      run: () =>
        db
          .collection(COLLECTIONS.attempts)
          .where("courseId", "==", "sin-uso")
          .where("version", "==", 1)
          .orderBy("at", "desc")
          .limit(1)
          .get(),
    },
    {
      label: "documents(courseId, version, topicId)",
      run: () =>
        db
          .collection(COLLECTIONS.documents)
          .where("courseId", "==", "sin-uso")
          .where("version", "==", 1)
          .where("topicId", "==", "sin-uso")
          .limit(1)
          .get(),
    },
    {
      label: "documents(archived) [cuota de PDF]",
      run: () => db.collection(COLLECTIONS.documents).where("archived", "==", false).limit(1).get(),
    },
  ];

  for (const query of indexQueries) {
    try {
      await query.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/FAILED_PRECONDITION|requires an index|index/i.test(message)) {
        indexProblems.push(`${query.label}: ${message.split("\n")[0]}`);
      } else {
        indexProblems.push(`${query.label}: error inesperado (${message.split("\n")[0]})`);
      }
    }
  }

  // Datos
  const metaSnap = await db.doc(`${META_DOC.collection}/${META_DOC.id}`).get();
  const meta = metaSnap.exists
    ? (metaSnap.data() as { schemaVersion?: unknown; initializedAt?: unknown })
    : null;

  const accounts = await readCollection<AccountLite>(db, COLLECTIONS.accounts);
  const courses = await readCollection<CourseLite>(db, COLLECTIONS.courses);
  const answerKeys = await readCollection<AnswerKeysLite>(db, COLLECTIONS.answerKeys);
  const progress = await readCollection<ProgressLite>(db, COLLECTIONS.progress);
  const attempts = await readCollection<AttemptLite>(db, COLLECTIONS.attempts);

  // Cuota de PDF: contador atómico frente a la suma real de los documentos.
  const storageSnap = await db.doc(`${META_DOC.collection}/storage`).get();
  const counterBytes = Number(storageSnap.data()?.usedBytes ?? 0);
  const documentSnapshots = await db
    .collection(COLLECTIONS.documents)
    .where("archived", "==", false)
    .limit(MAX_DOCS)
    .get();
  const actualBytes = documentSnapshots.docs.reduce(
    (sum, doc) => sum + Number(doc.data().bytes ?? 0),
    0,
  );
  const budgetBytes = budgetBytesFromMiB(process.env.PDF_STORAGE_BUDGET_MB
    ? Number(process.env.PDF_STORAGE_BUDGET_MB)
    : undefined);

  // Versiones: una consulta por curso (son pocos y así no se necesita
  // consulta de grupo de colecciones ni índice adicional).
  const versions: VersionLite[] = [];
  for (const course of courses) {
    const snapshot = await db
      .collection(COLLECTIONS.courses)
      .doc(course.courseId)
      .collection(COLLECTIONS.versions)
      .get();
    for (const doc of snapshot.docs) {
      versions.push({
        courseId: course.courseId,
        version: Number(doc.id),
        status: (doc.data() as { status?: string }).status,
      });
    }
  }

  const findings = runChecks({
    expectedSchemaVersion: SCHEMA_VERSION,
    meta,
    accounts,
    courses,
    versions,
    answerKeys,
    progress,
    attempts,
    storage: { counterBytes, actualBytes, budgetBytes },
  });

  if (indexProblems.length > 0) {
    findings.unshift({
      level: "error",
      code: "MISSING_INDEXES",
      message: `Faltan índices o no se pueden ejecutar consultas: ${indexProblems.length}. Despliega firestore.indexes.json.`,
      refs: indexProblems,
    });
  } else {
    findings.unshift({
      level: "info",
      code: "INDEXES_OK",
      message: "Todas las consultas compuestas han respondido sin error de índice.",
    });
  }

  for (const finding of findings) {
    const icon = finding.level === "error" ? "✖" : finding.level === "warning" ? "!" : "·";
    console.log(`${icon} [${finding.level}] ${finding.code}: ${finding.message}`);
    for (const ref of finding.refs ?? []) console.log(`      ↳ ${ref}`);
  }

  const summary = summarize(findings);
  console.log(
    `\nResumen: ${summary.errors} error(es), ${summary.warnings} aviso(s), ${summary.infos} informativo(s).`,
  );

  if (!summary.ok) {
    console.log("Resultado: HAY ERRORES. Revisa los mensajes anteriores.\n");
    process.exit(1);
  }

  console.log("Resultado: sin errores.\n");
}

main().catch((error) => {
  console.error("\n✖ Error inesperado:", error instanceof Error ? error.message : error);
  process.exit(1);
});
