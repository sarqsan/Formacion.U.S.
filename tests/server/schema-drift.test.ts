import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  ROOT_COLLECTIONS,
} from "@/server/db/schema.constants";

/**
 * PRUEBAS DE DERIVA
 * =================
 *
 * Firestore no impone esquema: el riesgo real es que el código, las reglas,
 * los índices y la documentación se separen con el tiempo. Estas pruebas leen
 * los ficheros de configuración y fallan si dejan de hablar de las mismas
 * colecciones.
 *
 * Son ejecutables hoy (no necesitan Firebase) y cubren un fallo muy caro:
 * añadir una colección nueva y olvidar su regla (quedaría cerrada, o peor,
 * añadirla a las reglas sin documentarla).
 */

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");

const rules = read("firestore.rules");
const indexes = JSON.parse(read("firestore.indexes.json")) as {
  indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string }> }>;
};
const modelDoc = read("docs/MODELO-DATOS.md");

const collectionNames = Object.values(COLLECTIONS);

describe("reglas de Firestore", () => {
  it("declara explícitamente todas las colecciones del esquema", () => {
    const missing = collectionNames.filter((name) => !rules.includes(`match /${name}/`));
    expect(missing, `colecciones sin regla explícita: ${missing.join(", ")}`).toEqual([]);
  });

  it("no contiene colecciones que ya no existen en el esquema", () => {
    // `match /databases/{database}/...` es la cabecera obligatoria de las
    // reglas, no una colección: se excluye porque el nombre va seguido de `{`.
    const declared = [...rules.matchAll(/match \/([A-Za-z]+)\/(?!\{)/g)]
      .map((match) => match[1])
      .filter((name) => !name.includes("{"));

    const unknown = [...new Set(declared)].filter(
      (name) => !collectionNames.includes(name as (typeof collectionNames)[number]),
    );
    expect(unknown, `reglas para colecciones inexistentes: ${unknown.join(", ")}`).toEqual([]);
  });

  it("mantiene cerrada la colección de claves y la de metadatos", () => {
    expect(rules).toMatch(/match \/answerKeys\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/meta\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/usernames\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/pdfChunks\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    // Esquema v2: los metadatos de documentos tampoco los lee el cliente.
    expect(rules).toMatch(/match \/documents\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/activationTokens\/\{[^}]+\}\s*\{\s*allow read, write: if false;/);
  });

  it("tiene un comodín final que deniega todo lo no declarado", () => {
    expect(rules).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  });

  it("las reglas nuevas consultan la ficha (no solo el token) para cuentas deshabilitadas", () => {
    expect(rules).toContain("get(/databases/$(database)/documents/accounts/$(request.auth.uid))");
    expect(rules).toMatch(/function isActive\(\)/);
    expect(rules).toMatch(/function isAdmin\(\)/);
  });
});

describe("índices", () => {
  it("solo indexa colecciones declaradas en el esquema", () => {
    const unknown = indexes.indexes
      .map((index) => index.collectionGroup)
      .filter((name) => !collectionNames.includes(name as (typeof collectionNames)[number]));
    expect(unknown, `índices sobre colecciones inexistentes: ${unknown.join(", ")}`).toEqual([]);
  });

  it("cada índice compuesto tiene al menos dos campos", () => {
    for (const index of indexes.indexes) {
      expect(index.fields.length, `${index.collectionGroup} con un solo campo (no hace falta índice compuesto)`).toBeGreaterThanOrEqual(2);
    }
  });

  it("no declara índices para el histórico: filtra solo por uid", () => {
    // `listArchivedProgress` hace `where("uid", "==", uid).limit(200)`, sin
    // orderBy: un campo suelto lo indexa Firestore solo. Añadir aquí un índice
    // sería especulativo (y publicarlo, una operación que no toca esta fase).
    const groups = indexes.indexes.map((index) => index.collectionGroup);
    expect(groups).not.toContain("progressHistory");
  });

  it("los índices de progreso e intentos cubren las consultas del código", () => {
    const signature = (group: string) =>
      indexes.indexes
        .filter((index) => index.collectionGroup === group)
        .map((index) => index.fields.map((field) => field.fieldPath).join(","));

    expect(signature("progress")).toContain("uid,updatedAt");
    expect(signature("progress")).toContain("courseId,version,completedAt");
    expect(signature("attempts")).toContain("uid,at");
    expect(signature("attempts")).toContain("courseId,version,at");
    expect(signature("documents")).toContain("courseId,version,topicId");
    // Matrículas activas de un curso: la consulta de `listByCourse` hace
    // where(courseId) + where(status) y necesita este índice compuesto.
    expect(signature("enrollments")).toContain("uid,courseId");
    expect(signature("enrollments")).toContain("courseId,status");
  });
});

describe("documentación del modelo", () => {
  it("documenta todas las colecciones de nivel raíz", () => {
    const missing = ROOT_COLLECTIONS.filter((name) => !modelDoc.includes(`\`${name}/`));
    expect(missing, `colecciones sin documentar: ${missing.join(", ")}`).toEqual([]);
  });

  it("la documentación no referencia colecciones inexistentes", () => {
    const referenced = [...modelDoc.matchAll(/`([a-zA-Z]+)\/\{/g)].map((match) => match[1]);
    const unknown = [...new Set(referenced)].filter(
      (name) => !collectionNames.includes(name as (typeof collectionNames)[number]),
    );
    expect(unknown, `documentación obsoleta: ${unknown.join(", ")}`).toEqual([]);
  });
});

describe("sin dependencia de Firebase Storage (plan Spark)", () => {
  it("no hay configuración de Storage en firebase.json", () => {
    const config = JSON.parse(read("firebase.json")) as {
      storage?: unknown;
      emulators?: Record<string, unknown>;
    };
    expect(config.storage).toBeUndefined();
    expect(config.emulators?.storage).toBeUndefined();
  });

  it("no se administra ningún bucket desde el código", () => {
    const admin = read("src/server/firebase/admin.ts");
    expect(admin).not.toContain("getStorage");
    expect(admin).not.toContain("firebase-admin/storage");
    const env = read(".env.example");
    expect(env).not.toContain("FIREBASE_STORAGE_BUCKET");
    expect(env).not.toContain("FIREBASE_STORAGE_EMULATOR_HOST");
  });

  it("los fragmentos de PDF son solo-servidor en las reglas", () => {
    const block = rules.slice(rules.indexOf("match /pdfChunks/"));
    expect(block.slice(0, 200)).toMatch(/allow read, write: if false;/);
  });
});

describe("scripts operativos", () => {
  it("están expuestos como comandos npm", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const script of ["db:init", "db:check", "test:rules", "emulators", "verify"]) {
      expect(pkg.scripts[script], `falta el script ${script}`).toBeTruthy();
    }
  });

  it("los scripts de base de datos usan el esquema compartido", () => {
    const init = read("scripts/db-init.ts");
    const check = read("scripts/db-check.ts");
    expect(init).toContain("schema.constants");
    expect(check).toContain("schema.constants");
    expect(check).toContain("runChecks");
  });
});
