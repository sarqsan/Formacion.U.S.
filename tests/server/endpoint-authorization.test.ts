import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AUDITORÍA AUTOMÁTICA DE ENDPOINTS
 * =================================
 *
 * Estas pruebas analizan el código fuente de `src/app/api` y comprueban que
 * cada método HTTP exportado declara el control que le corresponde.
 *
 * Es una prueba real y ejecutable hoy: si mañana alguien añade un endpoint que
 * escribe datos sin exigir sesión, esta prueba falla y señala el fichero.
 *
 * Lo que NO demuestra: que el guard funcione en tiempo de ejecución (eso lo
 * cubren las pruebas de servicio) ni que las reglas de Firestore permitan lo
 * que el endpoint necesita (eso requiere el emulador; ver PRUEBAS.md).
 */

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Endpoints públicos por diseño. Cada uno debe justificar por qué no exige
 * sesión: si se añade uno nuevo aquí sin motivo, la revisión lo verá.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "health/route.ts": "comprobación de vida; no devuelve datos ni permite escribir",
  "auth/session/route.ts": "crea/destruye la sesión; exige ID token de Firebase y origen de confianza",
  "activate/route.ts": "activación con token de un solo uso; el usuario aún no tiene sesión",
};

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const READ_ONLY = ["GET", "HEAD", "OPTIONS"];

interface RouteFile {
  file: string;
  relativePath: string;
  source: string;
  methods: string[];
}

function findRouteFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findRouteFiles(full));
    } else if (entry === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

function loadRoutes(): RouteFile[] {
  return findRouteFiles(API_ROOT).map((file) => {
    const source = readFileSync(file, "utf8");
    const methods = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(
      (match) => match[1],
    );
    return {
      file,
      relativePath: relative(API_ROOT, file).replace(/\\/g, "/"),
      source,
      methods: [...new Set(methods)],
    };
  });
}

const routes = loadRoutes();

describe("inventario de endpoints", () => {
  it("encuentra las rutas esperadas", () => {
    const paths = routes.map((route) => route.relativePath).sort();
    expect(paths).toEqual([
      "account/password/route.ts",
      "activate/route.ts",
      "admin/courses/[courseId]/ai/topics/batch/route.ts",
      "admin/courses/[courseId]/ai/topics/plan/route.ts",
      "admin/courses/[courseId]/ai/topics/save/route.ts",
      "admin/documents/[documentId]/attach/route.ts",
      "admin/documents/route.ts",
      "admin/documents/uploads/[documentId]/abort/route.ts",
      "admin/documents/uploads/[documentId]/finalize/route.ts",
      "admin/documents/uploads/[documentId]/parts/[index]/route.ts",
      "admin/documents/uploads/route.ts",
      "admin/enrollments/route.ts",
      "admin/exports/activity/route.ts",
      "admin/exports/progress/route.ts",
      "admin/import/confirm/route.ts",
      "admin/import/preview/route.ts",
      "auth/session/route.ts",
      "certificates/[code]/file/route.ts",
      "documents/[documentId]/file/route.ts",
      "documents/[documentId]/pages/route.ts",
      "health/route.ts",
      "me/route.ts",
    ]);
  });

  it("ninguna ruta está vacía", () => {
    for (const route of routes) {
      expect(route.methods.length, `${route.relativePath} no exporta métodos HTTP`).toBeGreaterThan(0);
    }
  });
});

describe("endpoints que escriben estado", () => {
  const mutatingRoutes = routes.filter((route) =>
    route.methods.some((method) => MUTATING.includes(method)),
  );

  it("todos comprueban el origen de la petición (CSRF)", () => {
    for (const route of mutatingRoutes) {
      expect(
        route.source.includes("assertTrustedOrigin("),
        `${route.relativePath} modifica estado sin comprobar el origen`,
      ).toBe(true);
    }
  });

  it("todos exigen sesión salvo los públicos por diseño", () => {
    for (const route of mutatingRoutes) {
      const isPublic = route.relativePath in PUBLIC_BY_DESIGN;
      if (isPublic) continue;

      const hasGuard =
        route.source.includes("requireActor(") ||
        route.source.includes("requirePortalActor(") ||
        route.source.includes("getActor(") ||
        route.source.includes("verifyIdToken(");

      expect(
        hasGuard,
        `${route.relativePath} modifica estado sin exigir autenticación`,
      ).toBe(true);
    }
  });

  it("los públicos por diseño están justificados y siguen exigiendo controles propios", () => {
    for (const route of mutatingRoutes) {
      const justification = PUBLIC_BY_DESIGN[route.relativePath];
      if (!justification) continue;

      expect(justification.length).toBeGreaterThan(10);
      expect(route.source.includes("assertTrustedOrigin(")).toBe(true);
    }
  });

  it("la lista de públicos por diseño no contiene rutas inexistentes", () => {
    const existing = new Set(routes.map((route) => route.relativePath));
    for (const declared of Object.keys(PUBLIC_BY_DESIGN)) {
      expect(existing.has(declared), `la ruta exenta ${declared} ya no existe`).toBe(true);
    }
  });
});

describe("endpoints de administración", () => {
  const adminRoutes = routes.filter((route) => route.relativePath.startsWith("admin/"));

  it("todos exigen sesión", () => {
    for (const route of adminRoutes) {
      expect(
        route.source.includes("requireActor(") || route.source.includes("requirePortalActor("),
        `${route.relativePath} sin requireActor`,
      ).toBe(true);
    }
  });

  it("todos delegan la comprobación de rol de administrador en el servicio", () => {
    for (const route of adminRoutes) {
      const delegates =
        route.source.includes("buildImportPreview(") ||
        route.source.includes("confirmImport(") ||
        route.source.includes("uploadPdfDocument(") ||
        route.source.includes("adminCreatePdfUpload(") ||
        route.source.includes("adminUploadPdfDocument(") ||
        route.source.includes("adminPutPdfPart(") ||
        route.source.includes("adminFinalizePdfUpload(") ||
        route.source.includes("adminAbortPdfUpload(") ||
        route.source.includes("adminAttachDocument(") ||
        // Temas por tandas: cada paso delega en una función del portal que
        // empieza por `assertAdmin` (vía `loadDraft`).
        route.source.includes("aiTopicBatchPlan(") ||
        route.source.includes("aiProposeTopicBatch(") ||
        route.source.includes("aiSaveProposedTopics(") ||
        route.source.includes("assertAdmin(");
      expect(
        delegates,
        `${route.relativePath} no delega en un servicio que llame a assertAdmin`,
      ).toBe(true);
    }
  });

  it("el servicio de documentos comprueba el rol de administrador", () => {
    const service = readFileSync(
      join(process.cwd(), "src", "server", "documents", "service.ts"),
      "utf8",
    );

    for (const functionName of [
      "uploadPdfDocument",
      "archivePdfDocument",
      "createPdfUpload",
      "putPdfUploadPart",
      "finalizePdfUpload",
      "abortPdfUpload",
    ]) {
      const start = service.indexOf(`export async function ${functionName}`);
      expect(start, `no se encuentra ${functionName}`).toBeGreaterThan(-1);
      const body = service.slice(start, start + 700);
      expect(body.includes("assertAdmin("), `${functionName} no comprueba el rol`).toBe(true);
    }

    // La lectura exige cuenta activa y matrícula en el curso, no rol de administrador.
    const readStart = service.indexOf("export async function readDocumentPages");
    expect(readStart).toBeGreaterThan(-1);
    expect(service.slice(readStart, readStart + 900)).toContain("assertActiveAccount(");
    expect(service.slice(readStart, readStart + 900)).toContain("assertCourseAccess(");
  });

  it("cada servicio de importación comprueba el rol en su primera línea útil", () => {
    const service = readFileSync(join(process.cwd(), "src", "server", "import", "service.ts"), "utf8");

    for (const functionName of ["buildImportPreview", "confirmImport"]) {
      const start = service.indexOf(`export async function ${functionName}`);
      expect(start, `no se encuentra ${functionName}`).toBeGreaterThan(-1);
      const body = service.slice(start, start + 700);
      expect(body.includes("assertAdmin("), `${functionName} no comprueba el rol`).toBe(true);
    }
  });
});

describe("endpoints de lectura", () => {
  it("los que no son públicos exigen sesión o no devuelven datos privados", () => {
    const readRoutes = routes.filter(
      (route) =>
        route.methods.some((method) => READ_ONLY.includes(method)) &&
        !(route.relativePath in PUBLIC_BY_DESIGN),
    );

    for (const route of readRoutes) {
      expect(
        route.source.includes("getActor(") ||
          route.source.includes("requireActor(") ||
          route.source.includes("requirePortalActor("),
        `${route.relativePath} lee datos sin resolver el actor`,
      ).toBe(true);
    }
  });

  it("/api/me no devuelve datos de terceros", () => {
    const me = routes.find((route) => route.relativePath === "me/route.ts");
    expect(me).toBeTruthy();
    expect(me?.source).toContain("actor.uid");
    expect(me?.source).not.toContain("collection(\"accounts\").get()");
  });
});

describe("certificados", () => {
  it("la descarga exige sesión y la comprobación vive en el servicio", () => {
    const route = routes.find((item) => item.relativePath === "certificates/[code]/file/route.ts");
    expect(route).toBeTruthy();
    expect(route?.methods).toEqual(["GET"]);
    // La sesión se resuelve en la ruta…
    expect(route?.source).toContain("requirePortalActor(");
    // …y quién puede ver el documento lo decide `certificateForDownload`, no
    // la ruta: el código del certificado no es una contraseña.
    expect(route?.source).toContain("certificateRecordFor(");
    expect(route?.source).toContain('"Cache-Control": "no-store, max-age=0, private"');
  });

  it("la verificación pública no resuelve actor ni devuelve el nombre completo", () => {
    const page = readFileSync(
      join(process.cwd(), "src", "app", "verificar", "[code]", "page.tsx"),
      "utf8",
    );
    expect(page).toContain("certificateVerification(");
    expect(page).not.toContain("getUiSession(");
    expect(page).toContain("holderMasked");
    expect(page).not.toContain("displayName");
  });
});

describe("superficie de escritura desde el cliente", () => {
  it("el código de navegador no escribe directamente en Firestore", () => {
    // Toda escritura va por el servidor: si alguien importara escrituras de
    // Firestore en el cliente, las reglas lo bloquearían igualmente, pero
    // conviene detectarlo aquí.
    const clientFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(entry)) clientFiles.push(full);
      }
    };
    walk(join(process.cwd(), "src", "app"));
    walk(join(process.cwd(), "src", "lib"));

    const offenders = clientFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      if (!source.includes('"use client"')) return false;
      return /firebase\/firestore/.test(source) && /(addDoc|setDoc|updateDoc|deleteDoc)/.test(source);
    });

    expect(offenders).toEqual([]);
  });
});
