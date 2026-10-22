import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

/**
 * PRUEBAS DE REGLAS DE FIRESTORE
 * ==============================
 *
 * Requieren el emulador de Firestore:
 *
 *     npm run test:rules
 *
 * (equivale a `firebase emulators:exec --only firestore,storage "vitest run
 * --config vitest.rules.config.mts"`).
 *
 * Cada prueba usa `withSecurityRulesDisabled` para sembrar datos como lo haría
 * el Admin SDK y después consulta como un usuario real. Las claims se simulan
 * con `authenticatedContext(uid, claims)`, que es cómo Firebase construye el
 * token: esto permite reproducir el caso "token antiguo que todavía dice
 * active".
 *
 * Las escrituras se hacen desde el SDK de cliente a propósito: son
 * exactamente las que un atacante podría intentar ejecutando JavaScript
 * propio en la aplicación.
 */

const projectId = "demo-formacion";
const RULES = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");

let testEnv: RulesTestEnvironment;

const ADMIN = { uid: "admin-1", claims: { role: "admin", status: "active", claimsVersion: 1 } };
const LEARNER = { uid: "learner-1", claims: { role: "learner", status: "active", claimsVersion: 1 } };
const OTHER_LEARNER = {
  uid: "learner-2",
  claims: { role: "learner", status: "active", claimsVersion: 1 },
};
const PENDING = {
  uid: "pending-1",
  claims: { role: "learner", status: "pending_activation", claimsVersion: 1 },
};
const DISABLED = {
  uid: "disabled-1",
  claims: { role: "learner", status: "active", claimsVersion: 1 },
};

beforeAll(async () => {
  // Preflight explícito: si alguien lanza este fichero con Vitest a pelo (sin
  // `npm run test:rules`), el resultado debe ser BLOCKED y no un error de
  // conexión que parezca un fallo de las reglas.
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "BLOCKED: FIRESTORE_EMULATOR_HOST no está definido. " +
        "Ejecuta `npm run test:rules` (arranca el emulador de Firestore). " +
        "Requisitos: docs/ENTORNO-PRUEBAS.md.",
    );
  }

  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: RULES },
  });
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

/** Siembra como Admin SDK (sin reglas), que es lo que hace el servidor. */
async function seed(): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "accounts", ADMIN.uid), {
      uid: ADMIN.uid,
      username: "admin.sistema",
      role: "admin",
      status: "active",
      claimsVersion: 1,
      personRol: null,
    });
    await setDoc(doc(db, "accounts", LEARNER.uid), {
      uid: LEARNER.uid,
      username: "rol1.garcia",
      role: "learner",
      status: "active",
      claimsVersion: 1,
      personRol: "ROL 1",
    });
    await setDoc(doc(db, "accounts", OTHER_LEARNER.uid), {
      uid: OTHER_LEARNER.uid,
      username: "rol1.perez",
      role: "learner",
      status: "active",
      claimsVersion: 1,
      personRol: "ROL 1",
    });
    await setDoc(doc(db, "accounts", PENDING.uid), {
      uid: PENDING.uid,
      username: "rol2.lopez",
      role: "learner",
      status: "pending_activation",
      claimsVersion: 1,
      personRol: "ROL 2",
    });
    // Cuenta deshabilitada cuya ficha ya cambió, mientras el token del usuario
    // sigue diciendo "active": es el escenario del requisito 8.
    await setDoc(doc(db, "accounts", DISABLED.uid), {
      uid: DISABLED.uid,
      username: "rol1.ruiz",
      role: "learner",
      status: "disabled",
      claimsVersion: 1,
      personRol: "ROL 1",
    });

    await setDoc(doc(db, "progress", `${LEARNER.uid}_curso-a`), {
      uid: LEARNER.uid,
      courseId: "curso-a",
      version: 1,
      completedAt: null,
      finalExam: { passed: false, attempts: 0 },
    });
    await setDoc(doc(db, "progress", `${OTHER_LEARNER.uid}_curso-a`), {
      uid: OTHER_LEARNER.uid,
      courseId: "curso-a",
      version: 1,
      completedAt: null,
      finalExam: { passed: false, attempts: 0 },
    });

    await setDoc(doc(db, "answerKeys", "curso-a_1_final"), {
      courseId: "curso-a",
      version: 1,
      finalExam: [{ id: "f1", correctOptionIds: ["b"] }],
    });

    await setDoc(doc(db, "courses", "curso-a"), {
      title: "Curso publicado",
      publishedVersion: 1,
    });
    await setDoc(doc(db, "courses", "curso-borrador"), {
      title: "Curso en preparación",
      publishedVersion: null,
    });
    await setDoc(doc(db, "courses", "curso-a", "versions", "1"), {
      version: 1,
      status: "published",
      topics: [],
    });
    await setDoc(doc(db, "courses", "curso-a", "versions", "2"), {
      version: 2,
      status: "draft",
      topics: [],
    });

    // Fase 6: LEARNER está matriculado en curso-a; OTHER_LEARNER, no. Publicar
    // un curso no crea la matrícula: eso es exactamente lo que se comprueba.
    await setDoc(doc(db, "enrollments", `${LEARNER.uid}_curso-a`), {
      uid: LEARNER.uid,
      courseId: "curso-a",
      status: "active",
      version: 1,
      enrolledAt: "2026-01-01T00:00:00.000Z",
      enrolledBy: ADMIN.uid,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await setDoc(doc(db, "enrollments", `${OTHER_LEARNER.uid}_curso-a`), {
      uid: OTHER_LEARNER.uid,
      courseId: "curso-a",
      status: "revoked",
      version: 1,
      enrolledAt: "2026-01-01T00:00:00.000Z",
      enrolledBy: ADMIN.uid,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    // Histórico de versiones anteriores (bloque 10). Tiene la misma forma que
    // escribe el servidor: `archivedAt` es una cadena ISO.
    await setDoc(doc(db, "progressHistory", `${LEARNER.uid}_curso-a_v1`), {
      uid: LEARNER.uid,
      courseId: "curso-a",
      version: 1,
      mandatoryTopicIds: ["tema-1"],
      topics: {},
      documents: {},
      completedAt: "2026-01-20T09:00:00.000Z",
      archivedAt: "2026-02-01T10:00:00.000Z",
    });
    await setDoc(doc(db, "progressHistory", `${OTHER_LEARNER.uid}_curso-a_v1`), {
      uid: OTHER_LEARNER.uid,
      courseId: "curso-a",
      version: 1,
      mandatoryTopicIds: ["tema-1"],
      topics: {},
      documents: {},
      completedAt: null,
      archivedAt: "2026-02-02T10:00:00.000Z",
    });

    // También para las cuentas que no deben poder leer nada: así la denegación
    // no se confunde con «el documento no existe».
    for (const uid of [PENDING.uid, DISABLED.uid]) {
      await setDoc(doc(db, "progressHistory", `${uid}_curso-a_v1`), {
        uid,
        courseId: "curso-a",
        version: 1,
        mandatoryTopicIds: [],
        topics: {},
        documents: {},
        completedAt: null,
        archivedAt: "2026-02-03T10:00:00.000Z",
      });
    }

    await setDoc(doc(db, "attempts", "intento-1"), {
      uid: LEARNER.uid,
      passed: true,
    });
    await setDoc(doc(db, "documents", "doc-1"), {
      courseId: "curso-a",
      pageCount: 10,
    });
    // Fragmento real: sin sembrarlo, «no se puede leer» sería indistinguible de
    // «no existe».
    await setDoc(doc(db, "pdfChunks", "doc-1_0"), {
      documentId: "doc-1",
      index: 0,
      data: new Uint8Array([1, 2, 3]),
    });
    await setDoc(doc(db, "meta", "storage"), { usedBytes: 0, reservedBytes: 0 });
    await setDoc(doc(db, "usernames", "rol1.garcia"), { uid: LEARNER.uid });
    await setDoc(doc(db, "activationTokens", "hash"), { uid: PENDING.uid });
    await setDoc(doc(db, "audits", "a1"), { type: "people_import" });
  });
}

const learnerDb = () => testEnv.authenticatedContext(LEARNER.uid, LEARNER.claims).firestore();
const otherDb = () => testEnv.authenticatedContext(OTHER_LEARNER.uid, OTHER_LEARNER.claims).firestore();
const adminDb = () => testEnv.authenticatedContext(ADMIN.uid, ADMIN.claims).firestore();
const pendingDb = () => testEnv.authenticatedContext(PENDING.uid, PENDING.claims).firestore();
const disabledDb = () => testEnv.authenticatedContext(DISABLED.uid, DISABLED.claims).firestore();
const anonDb = () => testEnv.unauthenticatedContext().firestore();

describe("1. usuario no autenticado", () => {
  beforeEach(seed);

  it("no puede leer datos privados", async () => {
    const db = anonDb();
    await assertFails(getDoc(doc(db, "accounts", LEARNER.uid)));
    await assertFails(getDoc(doc(db, "progress", `${LEARNER.uid}_curso-a`)));
    await assertFails(getDoc(doc(db, "answerKeys", "curso-a_1_final")));
    await assertFails(getDoc(doc(db, "courses", "curso-a")));
    await assertFails(getDoc(doc(db, "documents", "doc-1")));
    await assertFails(getDoc(doc(db, "audits", "a1")));
    await assertFails(getDoc(doc(db, "usernames", "rol1.garcia")));
    await assertFails(getDoc(doc(db, "enrollments", `${LEARNER.uid}_curso-a`)));
  });

  it("no puede escribir nada", async () => {
    const db = anonDb();
    await assertFails(
      setDoc(doc(db, "progress", "x"), { uid: "x", finalExam: { passed: true } }),
    );
    await assertFails(setDoc(doc(db, "accounts", "x"), { role: "admin" }));
    await assertFails(setDoc(doc(db, "audits", "x"), { type: "falso" }));
  });
});

describe("2. respuestas correctas y claves internas", () => {
  beforeEach(seed);

  it("el alumno no puede leer las claves de corrección", async () => {
    await assertFails(getDoc(doc(learnerDb(), "answerKeys", "curso-a_1_final")));
  });

  it("tampoco el administrador: las claves no salen del servidor", async () => {
    await assertFails(getDoc(doc(adminDb(), "answerKeys", "curso-a_1_final")));
  });

  it("nadie puede listar la colección de claves", async () => {
    await assertFails(getDocs(collection(learnerDb(), "answerKeys")));
    await assertFails(getDocs(collection(adminDb(), "answerKeys")));
  });

  it("las claves no se pueden escribir desde el cliente", async () => {
    await assertFails(
      setDoc(doc(learnerDb(), "answerKeys", "curso-a_1_final"), {
        finalExam: [{ id: "f1", correctOptionIds: ["a"] }],
      }),
    );
  });

  it("los tokens de activación y las reservas de usuario son invisibles", async () => {
    await assertFails(getDoc(doc(learnerDb(), "activationTokens", "hash")));
    await assertFails(getDoc(doc(adminDb(), "activationTokens", "hash")));
    await assertFails(getDoc(doc(learnerDb(), "usernames", "rol1.garcia")));
  });
});

describe("3. progreso propio", () => {
  beforeEach(seed);

  it("el alumno puede leer su propio progreso", async () => {
    await assertSucceeds(getDoc(doc(learnerDb(), "progress", `${LEARNER.uid}_curso-a`)));
  });

  it("no puede marcarse como aprobado", async () => {
    const db = learnerDb();
    await assertFails(
      updateDoc(doc(db, "progress", `${LEARNER.uid}_curso-a`), {
        completedAt: "2026-01-01T00:00:00.000Z",
        finalExam: { passed: true, attempts: 1 },
      }),
    );
  });

  it("no puede crear su progreso desde cero", async () => {
    await assertFails(
      setDoc(doc(learnerDb(), "progress", `${LEARNER.uid}_curso-b`), {
        uid: LEARNER.uid,
        finalExam: { passed: true },
      }),
    );
  });

  it("no puede borrar su progreso", async () => {
    await assertFails(deleteDoc(doc(learnerDb(), "progress", `${LEARNER.uid}_curso-a`)));
  });

  it("tampoco puede escribir en su propio documento de cuenta", async () => {
    const db = learnerDb();
    await assertFails(updateDoc(doc(db, "accounts", LEARNER.uid), { role: "admin" }));
    await assertFails(updateDoc(doc(db, "accounts", LEARNER.uid), { status: "disabled" }));
    await assertFails(updateDoc(doc(db, "accounts", LEARNER.uid), { claimsVersion: 99 }));
  });
});

describe("4. progreso de terceros", () => {
  beforeEach(seed);

  it("no puede leer el progreso de otro alumno", async () => {
    await assertFails(getDoc(doc(learnerDb(), "progress", `${OTHER_LEARNER.uid}_curso-a`)));
  });

  it("no puede leer la ficha de otro alumno", async () => {
    await assertFails(getDoc(doc(learnerDb(), "accounts", OTHER_LEARNER.uid)));
  });

  it("no puede escribir el progreso de otro alumno", async () => {
    await assertFails(
      setDoc(doc(otherDb(), "progress", `${LEARNER.uid}_curso-a`), {
        uid: LEARNER.uid,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  });

  it("no puede listar toda la colección de progreso", async () => {
    await assertFails(getDocs(collection(learnerDb(), "progress")));
  });
});

describe("5. escalada de privilegios", () => {
  beforeEach(seed);

  it("un alumno no puede concederse el rol de administrador", async () => {
    await assertFails(updateDoc(doc(learnerDb(), "accounts", LEARNER.uid), { role: "admin" }));
  });

  it("un alumno no puede crearse una ficha nueva como administrador", async () => {
    await assertFails(
      setDoc(doc(learnerDb(), "accounts", "uid-inventado"), {
        uid: "uid-inventado",
        role: "admin",
        status: "active",
        claimsVersion: 1,
      }),
    );
  });

  it("nadie escribe auditoría (ni el administrador)", async () => {
    await assertFails(setDoc(doc(adminDb(), "audits", "falsa"), { type: "people_import" }));
  });
});

describe("6. permisos de administrador", () => {
  beforeEach(seed);

  it("el administrador activo lee cuentas y auditoría", async () => {
    await assertSucceeds(getDoc(doc(adminDb(), "accounts", LEARNER.uid)));
    await assertSucceeds(getDoc(doc(adminDb(), "audits", "a1")));
  });

  it("el administrador no puede escribir cuentas ni progreso desde el cliente", async () => {
    const db = adminDb();
    await assertFails(updateDoc(doc(db, "accounts", LEARNER.uid), { role: "admin" }));
    await assertFails(
      setDoc(doc(db, "progress", `${LEARNER.uid}_curso-x`), { uid: LEARNER.uid }),
    );
  });

  it("un administrador degradado conserva el token pero pierde el acceso", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "accounts", ADMIN.uid), {
        role: "learner",
        claimsVersion: 2,
      });
    });
    // El token sigue diciendo admin/claimsVersion 1.
    await assertFails(getDoc(doc(adminDb(), "accounts", LEARNER.uid)));
    await assertFails(getDoc(doc(adminDb(), "audits", "a1")));
  });

  it("una versión de claims desfasada invalida el acceso", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "accounts", LEARNER.uid), { claimsVersion: 7 });
    });
    await assertFails(getDoc(doc(learnerDb(), "progress", `${LEARNER.uid}_curso-a`)));
  });
});

describe("7. cuentas pendientes y deshabilitadas", () => {
  beforeEach(seed);

  it("una cuenta pendiente de activación no accede a datos", async () => {
    await assertFails(getDoc(doc(pendingDb(), "accounts", PENDING.uid)));
    await assertFails(getDoc(doc(pendingDb(), "courses", "curso-a")));
    await assertFails(getDoc(doc(pendingDb(), "documents", "doc-1")));
  });

  it("una cuenta deshabilitada con token válido no accede a recursos protegidos", async () => {
    const db = disabledDb();
    await assertFails(getDoc(doc(db, "accounts", DISABLED.uid)));
    await assertFails(getDoc(doc(db, "courses", "curso-a")));
    await assertFails(getDoc(doc(db, "documents", "doc-1")));
    await assertFails(getDoc(doc(db, "progress", `${LEARNER.uid}_curso-a`)));
  });

  it("una cuenta sin ficha en la aplicación no accede aunque tenga token", async () => {
    const ghost = testEnv
      .authenticatedContext("uid-sin-ficha", { role: "learner", status: "active", claimsVersion: 1 })
      .firestore();
    await assertFails(getDoc(doc(ghost, "courses", "curso-a")));
  });
});

describe("8. contenido de cursos y matrícula", () => {
  beforeEach(seed);

  it("el alumno matriculado ve el curso publicado y su versión publicada", async () => {
    await assertSucceeds(getDoc(doc(learnerDb(), "courses", "curso-a")));
    await assertSucceeds(getDoc(doc(learnerDb(), "courses", "curso-a", "versions", "1")));
  });

  it("estar publicado no da acceso: sin matrícula no se lee la versión", async () => {
    // OTHER_LEARNER tiene matrícula revocada en curso-a: el curso está
    // publicado, pero el contenido no se lee.
    await assertFails(getDoc(doc(otherDb(), "courses", "curso-a", "versions", "1")));
    await assertSucceeds(getDoc(doc(otherDb(), "courses", "curso-a")));
  });

  it("una matrícula inventada por el cliente no abre el contenido", async () => {
    // El alumno no matriculado no puede crearse la matrícula…
    await assertFails(
      setDoc(doc(otherDb(), "enrollments", `${OTHER_LEARNER.uid}_curso-a`), {
        uid: OTHER_LEARNER.uid,
        courseId: "curso-a",
        status: "active",
      }),
    );
    // …y sin matrícula activa la versión sigue cerrada.
    await assertFails(getDoc(doc(otherDb(), "courses", "curso-a", "versions", "1")));
  });

  it("el alumno no ve borradores", async () => {
    await assertFails(getDoc(doc(learnerDb(), "courses", "curso-borrador")));
    await assertFails(getDoc(doc(learnerDb(), "courses", "curso-a", "versions", "2")));
  });

  it("el administrador sí ve borradores", async () => {
    await assertSucceeds(getDoc(doc(adminDb(), "courses", "curso-borrador")));
    await assertSucceeds(getDoc(doc(adminDb(), "courses", "curso-a", "versions", "2")));
  });

  it("nadie modifica el contenido desde el cliente", async () => {
    await assertFails(
      setDoc(doc(adminDb(), "courses", "curso-a", "versions", "3"), { version: 3, status: "published" }),
    );
    await assertFails(updateDoc(doc(adminDb(), "courses", "curso-a"), { publishedVersion: 2 }));
  });
});

describe("8 bis. matrículas", () => {
  beforeEach(seed);

  it("el alumno lee su matrícula, no la de otro", async () => {
    await assertSucceeds(getDoc(doc(learnerDb(), "enrollments", `${LEARNER.uid}_curso-a`)));
    await assertFails(getDoc(doc(learnerDb(), "enrollments", `${OTHER_LEARNER.uid}_curso-a`)));
  });

  it("el administrador lee todas las matrículas", async () => {
    await assertSucceeds(getDoc(doc(adminDb(), "enrollments", `${OTHER_LEARNER.uid}_curso-a`)));
    await assertSucceeds(getDocs(collection(adminDb(), "enrollments")));
  });

  it("nadie escribe matrículas desde el cliente (ni el administrador)", async () => {
    await assertFails(
      setDoc(doc(adminDb(), "enrollments", "x_curso-a"), {
        uid: "x",
        courseId: "curso-a",
        status: "active",
      }),
    );
    await assertFails(
      updateDoc(doc(adminDb(), "enrollments", `${LEARNER.uid}_curso-a`), { status: "revoked" }),
    );
    await assertFails(deleteDoc(doc(adminDb(), "enrollments", `${LEARNER.uid}_curso-a`)));
  });
});

describe("9. intentos y documentos", () => {
  beforeEach(seed);

  it("el alumno no lee el registro de intentos", async () => {
    await assertFails(getDoc(doc(learnerDb(), "attempts", "intento-1")));
    await assertFails(getDocs(collection(learnerDb(), "attempts")));
  });

  it("el administrador sí lee intentos, pero no los escribe", async () => {
    await assertSucceeds(getDoc(doc(adminDb(), "attempts", "intento-1")));
    await assertFails(setDoc(doc(adminDb(), "attempts", "falso"), { passed: true }));
  });

  it("nadie lee metadatos de documentos desde el cliente (esquema v2)", async () => {
    // Los metadatos incluyen también los de documentos en borrador: si el
    // cliente pudiera leerlos, conocer un id expondría títulos y páginas no
    // publicados. El servidor los lee con el Admin SDK (que no pasa por reglas).
    await assertFails(getDoc(doc(learnerDb(), "documents", "doc-1")));
    await assertFails(getDocs(collection(learnerDb(), "documents")));
    await assertFails(getDoc(doc(adminDb(), "documents", "doc-1")));
    await assertFails(getDoc(doc(disabledDb(), "documents", "doc-1")));
    await assertFails(getDoc(doc(otherDb(), "documents", "doc-1")));
  });

  it("ningún cliente lee fragmentos de PDF, ni siquiera el administrador", async () => {
    // Los PDF viven en Firestore (plan Spark sin Storage): si estas lecturas
    // fueran posibles, un alumno podría descargarse el documento entero.
    await assertFails(getDoc(doc(learnerDb(), "pdfChunks", "doc-1_0")));
    await assertFails(getDocs(collection(learnerDb(), "pdfChunks")));
    await assertFails(getDoc(doc(adminDb(), "pdfChunks", "doc-1_0")));
  });

  it("nadie escribe fragmentos ni el contador de cuota desde el cliente", async () => {
    await assertFails(
      setDoc(doc(learnerDb(), "pdfChunks", "doc-1_0"), { data: new Uint8Array([1]) }),
    );
    await assertFails(setDoc(doc(adminDb(), "pdfChunks", "doc-1_0"), { data: new Uint8Array([1]) }));
    await assertFails(setDoc(doc(adminDb(), "meta", "storage"), { usedBytes: 0 }));
    await assertFails(getDoc(doc(adminDb(), "meta", "storage")));
  });
});

describe("10. rutas no declaradas", () => {
  beforeEach(seed);

  it("cualquier colección nueva está cerrada por defecto", async () => {
    const db = learnerDb();
    await assertFails(getDoc(doc(db, "coleccion-inexistente", "doc")));
    await assertFails(setDoc(doc(db, "coleccion-inexistente", "doc"), { x: 1 }));
    await assertFails(setDoc(doc(adminDb(), "coleccion-inexistente", "doc"), { x: 1 }));
  });
});

describe("11. historial de progreso (progressHistory)", () => {
  beforeEach(seed);

  it("el alumno lee su propio histórico", async () => {
    await assertSucceeds(getDoc(doc(learnerDb(), "progressHistory", `${LEARNER.uid}_curso-a_v1`)));
  });

  it("no lee el histórico de otra persona", async () => {
    await assertFails(
      getDoc(doc(learnerDb(), "progressHistory", `${OTHER_LEARNER.uid}_curso-a_v1`)),
    );
  });

  it("no puede listar el histórico de todo el mundo", async () => {
    await assertFails(getDocs(collection(learnerDb(), "progressHistory")));
  });

  it("puede consultar solo sus registros filtrando por uid", async () => {
    // La consulta real de la aplicación la hace el servidor con Admin SDK, pero
    // si algún día el cliente la repitiera debe funcionar con este filtro y no
    // sin él (la prueba anterior).
    await assertSucceeds(
      getDocs(query(collection(learnerDb(), "progressHistory"), where("uid", "==", LEARNER.uid))),
    );
  });

  it("no puede escribir ni borrar su histórico (es inmutable)", async () => {
    const db = learnerDb();
    const path = `progressHistory/${LEARNER.uid}_curso-a_v1`;
    await assertFails(updateDoc(doc(db, path), { completedAt: "2026-03-01T00:00:00.000Z" }));
    await assertFails(setDoc(doc(db, "progressHistory", `${LEARNER.uid}_curso-b_v1`), { uid: LEARNER.uid }));
    await assertFails(deleteDoc(doc(db, path)));
  });

  it("administración lee el de cualquiera y puede listarlo", async () => {
    await assertSucceeds(
      getDoc(doc(adminDb(), "progressHistory", `${OTHER_LEARNER.uid}_curso-a_v1`)),
    );
    await assertSucceeds(getDocs(collection(adminDb(), "progressHistory")));
  });

  it("administración tampoco escribe el histórico desde el cliente", async () => {
    await assertFails(
      updateDoc(doc(adminDb(), "progressHistory", `${LEARNER.uid}_curso-a_v1`), {
        completedAt: null,
      }),
    );
  });

  it("una cuenta pendiente o deshabilitada no lee ni su propio histórico", async () => {
    await assertFails(getDoc(doc(pendingDb(), "progressHistory", `${PENDING.uid}_curso-a_v1`)));
    await assertFails(getDoc(doc(disabledDb(), "progressHistory", `${DISABLED.uid}_curso-a_v1`)));
  });

  it("con la versión de claims desfasada, el histórico deja de leerse", async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "accounts", LEARNER.uid), { claimsVersion: 5 });
    });
    await assertFails(getDoc(doc(learnerDb(), "progressHistory", `${LEARNER.uid}_curso-a_v1`)));
  });
});

describe("12. auditoría y registros administrativos", () => {
  beforeEach(seed);

  it("el alumno no lee auditoría ni intentos", async () => {
    await assertFails(getDoc(doc(learnerDb(), "audits", "a1")));
    await assertFails(getDocs(collection(learnerDb(), "audits")));
    await assertFails(getDoc(doc(learnerDb(), "attempts", "intento-1")));
  });

  it("una cuenta deshabilitada tampoco los lee", async () => {
    await assertFails(getDoc(doc(disabledDb(), "audits", "a1")));
    await assertFails(getDoc(doc(disabledDb(), "attempts", "intento-1")));
  });

  it("administración lee y lista auditoría e intentos", async () => {
    await assertSucceeds(getDocs(collection(adminDb(), "audits")));
    await assertSucceeds(getDocs(collection(adminDb(), "attempts")));
  });

  it("nadie modifica ni borra la auditoría (ni administración)", async () => {
    await assertFails(updateDoc(doc(adminDb(), "audits", "a1"), { type: "otra_cosa" }));
    await assertFails(deleteDoc(doc(adminDb(), "audits", "a1")));
    await assertFails(deleteDoc(doc(adminDb(), "attempts", "intento-1")));
  });

  it("sin ficha de cuenta, ni siquiera un token de administrador abre la auditoría", async () => {
    const ghostAdmin = testEnv
      .authenticatedContext("admin-sin-ficha", {
        role: "admin",
        status: "active",
        claimsVersion: 1,
      })
      .firestore();
    await assertFails(getDoc(doc(ghostAdmin, "audits", "a1")));
  });
});

describe("13. documentos privados con contenido real", () => {
  beforeEach(seed);

  it("nadie lee fragmentos de PDF aunque el documento exista", async () => {
    // Sembrados en `seed()`: la denegación es de las reglas, no del «no existe».
    await assertFails(getDoc(doc(learnerDb(), "pdfChunks", "doc-1_0")));
    await assertFails(getDoc(doc(adminDb(), "pdfChunks", "doc-1_0")));
    await assertFails(getDocs(collection(learnerDb(), "pdfChunks")));
  });

  it("el contador de cuota no se lee ni se escribe desde el cliente", async () => {
    await assertFails(getDoc(doc(adminDb(), "meta", "storage")));
    await assertFails(setDoc(doc(adminDb(), "meta", "storage"), { usedBytes: 0 }));
    await assertFails(
      setDoc(doc(learnerDb(), "meta", "storage"), { usedBytes: 1024 * 1024 * 1024 }),
    );
  });
});
