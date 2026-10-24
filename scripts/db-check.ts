#!/usr/bin/env node
/**
 * COMPROBACIÓN DE LA BASE DE DATOS (solo lectura)
 * ===============================================
 *
 *   npm run db:check                 (informe completo, uso local)
 *   npm run db:check -- --redact     (informe sin identificadores personales)
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
 *
 * `--redact` sustituye los identificadores personales (usuario, uid, correo,
 * origen de creación) por etiquetas estables ANTES de imprimir, porque la
 * salida puede acabar en un registro público. No cambia ninguna consulta ni
 * ningún criterio: solo lo que se ve. Sin el flag la salida es la de siempre,
 * salvo el saneado de caracteres de control, que se aplica siempre para que un
 * dato manipulado no pueda fabricar líneas nuevas (ver `sanitizeText`).
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
import {
  auditStatus,
  buildRedactionIndex,
  formatAuditStatus,
  formatFindingLines,
  installStreamGuard,
  redactGeneric,
  sanitizeText,
  type RedactionIndex,
  type StreamLike,
} from "../src/server/db/redact";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const allowProd = process.env.DB_ALLOW_PROD === "yes";
const MAX_DOCS = 2000;

const KNOWN_FLAGS = new Set(["--redact"]);
const unknownFlags = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.has(arg));
const redact = process.argv.includes("--redact");

/**
 * Índice vigente para el filtro de streams. Se rellena en cuanto se leen las
 * cuentas; hasta entonces el filtro genérico sigue actuando.
 */
let liveRedactionIndex: RedactionIndex | null = null;

/**
 * Con `--redact`, TODO lo que escribe el proceso pasa por la redacción,
 * incluidos los avisos que emite el SDK de Firebase/gRPC por su cuenta
 * (`stderr`) y que no pasan por nuestras funciones de impresión.
 *
 * Solo se instala con el flag: sin él la salida debe ser la de antes.
 */
const streamGuard = redact
  ? installStreamGuard(
      [process.stdout, process.stderr] as unknown as StreamLike[],
      () => liveRedactionIndex,
    )
  : null;

/**
 * Estado de la ejecución cuando no se puede completar: siempre `AUDIT_BLOCKED`,
 * nunca `NO_ADMIN`. Un fallo de configuración, conectividad o permisos no dice
 * nada sobre si existe un administrador.
 */
function reportBlocked(message: string): never {
  const safe = sanitizeText(message);
  console.error(`\n✖ ${redact ? redactGeneric(safe) : safe}`);
  if (redact) console.error(`\n${formatAuditStatus(auditStatus({ findings: [], adminCount: null, blocked: true }))}`);
  console.error("");
  process.exit(1);
}

function fail(message: string): never {
  return reportBlocked(message);
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

/**
 * Lee como máximo `MAX_DOCS` documentos. Una lectura truncada NO puede filtrar
 * identificadores: el índice de redacción se construye con estas mismas listas,
 * así que lo que no se leyó tampoco se recorre ni se imprime. El truncado sí
 * limita la auditoría (los recuentos son cotas inferiores), y eso ya era así
 * antes de `--redact`: no se cambia ningún criterio.
 */
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

  if (unknownFlags.length > 0) {
    fail(`Argumento no reconocido: ${unknownFlags.join(" ")}. Solo se admite --redact.`);
  }

  console.log("\n=== Comprobación de la base de datos de Formación ===");
  console.log(`Proyecto: ${sanitizeText(projectId ?? "(sin definir)")}`);
  console.log(
    `Modo:     ${isEmulator ? `emulador (${sanitizeText(String(emulatorHost))})` : "Firebase real"}`,
  );

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
      // Histórico (bloque 10): la consulta real filtra SOLO por uid y limita a
      // 200, sin orderBy. Debe responder sin índice compuesto; si algún día
      // exigiera uno, esta comprobación lo delata antes de que falle en la app.
      label: "progressHistory(uid) [sin índice compuesto]",
      run: () =>
        db.collection(COLLECTIONS.progressHistory).where("uid", "==", "sin-uso").limit(200).get(),
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
      // Se recorta a la primera línea y se sanea: el mensaje de Firestore puede
      // traer varias y la salida debe seguir teniendo una línea por concepto.
      const raw = error instanceof Error ? error.message : String(error);
      const message = sanitizeText(raw.split(/\r?\n/)[0] ?? "");
      if (/FAILED_PRECONDITION|requires an index|index/i.test(message)) {
        indexProblems.push(`${query.label}: ${message}`);
      } else {
        indexProblems.push(`${query.label}: error inesperado (${message})`);
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

  // El veredicto se calcula SIEMPRE sobre los hallazgos originales: redactar
  // solo afecta a lo que se imprime.
  const summary = summarize(findings);

  const redactionIndex: RedactionIndex | null = redact
    ? buildRedactionIndex({
        accounts,
        // `checkLearning` imprime estos uid aunque la cuenta ya no exista
        // (borrado de cuenta o `rollbackAccount` fallido). Se indexan siempre.
        extraUids: [...progress.map((entry) => entry.uid), ...attempts.map((entry) => entry.uid)],
      })
    : null;

  liveRedactionIndex = redactionIndex;

  for (const finding of findings) {
    for (const line of formatFindingLines(finding, redactionIndex)) console.log(line);
  }

  console.log(
    `\nResumen: ${summary.errors} error(es), ${summary.warnings} aviso(s), ${summary.infos} informativo(s).`,
  );

  if (redactionIndex) {
    const adminCount = accounts.filter((account) => account.role === "admin").length;
    console.log(formatAuditStatus(auditStatus({ findings, adminCount })));
    // A partir de aquí ninguna escritura posterior (avisos del SDK al cerrar,
    // mensajes de error tardíos) puede fabricar un estado falso.
    streamGuard?.seal();
  }

  if (!summary.ok) {
    console.log("Resultado: HAY ERRORES. Revisa los mensajes anteriores.\n");
    process.exit(1);
  }

  console.log("Resultado: sin errores.\n");
}

main().catch((error) => {
  const message = sanitizeText(error instanceof Error ? error.message : String(error));
  if (redact) {
    console.error(`\n✖ Error inesperado: ${redactGeneric(message)}`);
    console.error(`\n${formatAuditStatus(auditStatus({ findings: [], adminCount: null, blocked: true }))}\n`);
  } else {
    console.error(`\n✖ Error inesperado: ${message}`);
  }
  process.exit(1);
});
