import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_READABLE_COLLECTIONS,
  COLLECTIONS,
  SERVER_ONLY_COLLECTIONS,
} from "@/server/db/schema.constants";

/**
 * POLÍTICA DE LAS REGLAS, VERIFICADA SIN EMULADOR
 * ===============================================
 *
 * Las pruebas de `tests/rules/` son las que demuestran de verdad qué permite el
 * motor de Firestore, pero necesitan el emulador (Java + jar) y en este entorno
 * están BLOQUEADAS. Este fichero **no las sustituye**: comprueba otra cosa, que
 * también puede romperse y también es grave:
 *
 *   que las reglas escritas sigan diciendo lo que el diseño exige.
 *
 * Un cambio inocente —añadir un `match` para una colección nueva, aflojar un
 * `allow read` para «probar algo»— no lo detecta el tipado ni el lint, y sin
 * emulador tampoco lo detectaría ninguna prueba. Estas comprobaciones sí se
 * ejecutan en `npm test` y fallan en el acto.
 *
 * Lo que NO puede decir este fichero: si el motor de reglas acepta o rechaza
 * una petición concreta. Eso queda para `npm run test:rules`.
 */

const RULES = readFileSync(join(process.cwd(), "firestore.rules"), "utf8");

/**
 * Reglas sin comentarios. Las comprobaciones de forma (llamadas, operaciones de
 * `allow`) miran el código: un comentario que mencione «claves (…)» no debe
 * parecer una función invocada.
 */
const CODE = RULES.replace(/\/\/[^\n]*/g, "");

/**
 * Extrae el bloque de una colección contando llaves, para no depender de la
 * indentación ni de que el bloque esté en una sola línea.
 */
function block(collection: string): string {
  const start = RULES.indexOf(`match /${collection}/`);
  if (start === -1) throw new Error(`Las reglas no declaran «${collection}».`);

  // La línea del `match` puede llevar comodines (`match /courses/{courseId} {`):
  // la llave que abre el bloque es la ÚLTIMA de esa línea, no la primera.
  const lineEnd = RULES.indexOf("\n", start);
  const open = RULES.lastIndexOf("{", lineEnd === -1 ? RULES.length : lineEnd);
  let depth = 0;
  for (let index = open; index < RULES.length; index += 1) {
    if (RULES[index] === "{") depth += 1;
    if (RULES[index] === "}") {
      depth -= 1;
      if (depth === 0) return RULES.slice(open, index + 1);
    }
  }
  throw new Error(`El bloque de «${collection}» no cierra.`);
}

/** Líneas `allow ...: if <condición>;` de todo el fichero. */
function allowLines(source: string): Array<{ line: string; condition: string }> {
  return [...source.matchAll(/allow\s+([^;]+?):\s*if\s+([^;]+);/g)].map((match) => ({
    line: match[0],
    condition: match[2].trim(),
  }));
}

describe("0. estructura del fichero (sintaxis, no motor)", () => {
  // Un error de sintaxis en `firestore.rules` no lo detecta el tipado, ni el
  // lint, ni el build: hoy solo aparecería al desplegar. Estas comprobaciones
  // son un lint estructural del fichero. NO son el motor de reglas: que esto
  // pase no significa que Firestore acepte las reglas, solo que el texto tiene
  // forma de reglas bien escritas.

  it("llaves y paréntesis equilibrados", () => {
    const count = (character: string) => CODE.split(character).length - 1;
    expect(count("{")).toBe(count("}"));
    expect(count("(")).toBe(count(")"));
  });

  it("cada `match` abre y cierra su bloque", () => {
    const opens = CODE.match(/match\s+\/[^\n]*\{/g) ?? [];
    // Un `match` por colección declarada (el comodín final no cuenta aquí: lo
    // comprueba el bloque 1) más la cabecera `match /databases/{database}/documents`.
    expect(opens.length).toBeGreaterThanOrEqual(Object.values(COLLECTIONS).length + 1);
    expect(RULES.trimEnd().endsWith("}")).toBe(true);
  });

  it("solo usa operaciones de `allow` válidas", () => {
    const operations = [
      ...CODE.matchAll(/allow\s+([^:]+):/g),
    ].flatMap((match) => match[1].split(",").map((piece) => piece.trim()));

    const allowed = new Set(["read", "write", "create", "update", "delete", "get", "list"]);
    expect(operations.filter((operation) => !allowed.has(operation))).toEqual([]);
  });

  it("toda función invocada está definida en el fichero", () => {
    const defined = new Set(
      [...CODE.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]),
    );
    // Funciones propias del lenguaje de reglas.
    const builtin = new Set([
      "get",
      "exists",
      "getAfter",
      "existsAfter",
      "debug",
      "duration",
      "timestamp",
      "int",
      "float",
      "string",
      "bool",
      "bytes",
      "path",
      "map",
      "list",
      "set",
      "math",
      "hashing",
      "debug",
      "is",
      "hasAll",
      "hasAny",
      "hasOnly",
      "size",
      "keys",
      "values",
      "matches",
      "toSet",
      "toLower",
      "toUpper",
      "trim",
      "split",
      "join",
      "concat",
      "date",
      "let",
    ]);

    const called = new Set(
      [...CODE.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]),
    );
    const unknown = [...called].filter(
      (name) =>
        !defined.has(name) &&
        !builtin.has(name) &&
        ![
          "match",
          "allow",
          "function",
          "if",
          "return",
          "service",
          "functions",
          "rules_version",
        ].includes(name),
    );
    expect(unknown, `funciones usadas sin definir: ${unknown.join(", ")}`).toEqual([]);
  });

  it("declara la versión de reglas que exige la sintaxis usada", () => {
    expect(RULES.startsWith("rules_version = '2';")).toBe(true);
  });
});

describe("1. denegar por defecto", () => {
  it("tiene un comodín final que cierra todo lo no declarado", () => {
    expect(RULES).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  });

  it("declara las catorce colecciones del esquema", () => {
    const missing = Object.values(COLLECTIONS).filter(
      (name) => !RULES.includes(`match /${name}/`),
    );
    expect(missing).toEqual([]);
  });
});

describe("2. ninguna escritura desde el cliente", () => {
  it("todas las reglas de escritura son «if false»", () => {
    // El servidor escribe con el Admin SDK, que no pasa por reglas. Una regla
    // de escritura distinta de `false` sería una puerta para el navegador.
    const writes = allowLines(RULES).filter((entry) =>
      /\b(write|create|update|delete)\b/.test(entry.line.split(":")[0]),
    );

    expect(writes.length).toBeGreaterThan(0);
    const open = writes.filter((entry) => entry.condition !== "false");
    expect(open.map((entry) => entry.line), "escrituras permitidas al cliente").toEqual([]);
  });

  it("no hay ninguna regla con condición literalmente verdadera", () => {
    expect(allowLines(RULES).filter((entry) => entry.condition === "true")).toEqual([]);
  });

  it("las escrituras de cada colección son explícitamente falsas", () => {
    for (const collection of Object.values(COLLECTIONS)) {
      const source = block(collection);
      const writes = allowLines(source).filter((entry) =>
        /\b(write|create|update|delete)\b/.test(entry.line.split(":")[0]),
      );
      expect(writes.length, `«${collection}» sin regla de escritura explícita`).toBeGreaterThan(0);
      expect(writes.filter((entry) => entry.condition !== "false")).toEqual([]);
    }
  });
});

describe("3. colecciones solo de servidor", () => {
  it("están cerradas por completo (lectura y escritura)", () => {
    for (const collection of SERVER_ONLY_COLLECTIONS) {
      const source = block(collection);
      const read = allowLines(source).filter((entry) =>
        /\bread\b/.test(entry.line.split(":")[0]),
      );
      expect(read.length, `«${collection}» sin regla de lectura`).toBeGreaterThan(0);
      expect(read.filter((entry) => entry.condition !== "false")).toEqual([]);
    }
  });

  it("las claves de corrección no son legibles ni por administración", () => {
    expect(block(COLLECTIONS.answerKeys)).toMatch(/allow read, write: if false;/);
  });

  it("los PDF y sus fragmentos no son legibles desde el cliente", () => {
    for (const collection of [COLLECTIONS.documents, COLLECTIONS.pdfChunks]) {
      const source = block(collection);
      const reads = allowLines(source).filter((entry) =>
        /\bread\b/.test(entry.line.split(":")[0]),
      );
      expect(reads.map((entry) => entry.condition)).toEqual(["false"]);
    }
  });
});

describe("4. datos personales: solo los propios, o administración", () => {
  for (const collection of [
    COLLECTIONS.progress,
    COLLECTIONS.progressHistory,
    COLLECTIONS.enrollments,
  ]) {
    it(`«${collection}» exige cuenta activa y comparar el uid del documento`, () => {
      const source = block(collection);
      const reads = allowLines(source).filter((entry) =>
        /\bread\b/.test(entry.line.split(":")[0]),
      );
      expect(reads).toHaveLength(1);

      const condition = reads[0].condition;
      expect(condition).toContain("isActive()");
      // El uid se compara con el del documento, no con el que llega en la ruta.
      expect(condition).toContain("resource.data.uid == request.auth.uid");
      // Y administración pasa por `isAdmin()`, que vuelve a mirar la ficha.
      expect(condition).toContain("isAdmin()");
    });
  }

  it("«accounts» solo la lee su dueño o administración, y nunca se escribe", () => {
    const source = block(COLLECTIONS.accounts);
    expect(source).toMatch(/allow read: if isAdmin\(\) \|\| \(isActive\(\) && isSelf\(uid\)\);/);
    expect(source).toMatch(/allow write: if false;/);
  });

  it("toda colección legible por el cliente exige cuenta activa o administración", () => {
    // Si mañana alguien añade una colección a `CLIENT_READABLE_COLLECTIONS`
    // (o afloja una regla), esta comprobación lo delata sin emulador.
    for (const collection of CLIENT_READABLE_COLLECTIONS) {
      const reads = allowLines(block(collection)).filter((entry) =>
        /\bread\b/.test(entry.line.split(":")[0]),
      );
      expect(reads.length, `«${collection}» sin regla de lectura`).toBeGreaterThan(0);
      for (const read of reads) {
        expect(
          read.condition.includes("isActive()") || read.condition.includes("isAdmin()"),
          `«${collection}» se lee sin comprobar la cuenta: ${read.condition}`,
        ).toBe(true);
        expect(read.condition).not.toContain("request.auth != null)");
      }
    }
  });

  it("«attempts» y «audits» solo los lee administración", () => {
    for (const collection of [COLLECTIONS.attempts, COLLECTIONS.audits]) {
      const reads = allowLines(block(collection)).filter((entry) =>
        /\bread\b/.test(entry.line.split(":")[0]),
      );
      expect(reads.map((entry) => entry.condition)).toEqual(["isAdmin()"]);
    }
  });
});

describe("5. contenido: publicado y con matrícula", () => {
  it("el curso solo se lee si tiene versión publicada", () => {
    expect(block(COLLECTIONS.courses)).toMatch(/resource\.data\.publishedVersion != null/);
  });

  it("la versión exige matrícula activa y estado publicado", () => {
    const source = block(COLLECTIONS.courses);
    expect(source).toContain("isEnrolled(courseId)");
    expect(source).toContain("resource.data.status == 'published'");
  });

  it("la matrícula se comprueba por documento, estado y uid", () => {
    expect(RULES).toMatch(/function isEnrolled\(courseId\)/);
    const fn = RULES.slice(RULES.indexOf("function isEnrolled"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    expect(body).toContain("isActive()");
    expect(body).toContain("enrollmentDoc(courseId).status == 'active'");
    expect(body).toContain("enrollmentDoc(courseId).uid == request.auth.uid");
  });
});

describe("6. cuenta deshabilitada: se mira la ficha, no solo el token", () => {
  it("«isActive» cruza token, ficha y versión de claims", () => {
    const fn = RULES.slice(RULES.indexOf("function isActive"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    expect(body).toContain("request.auth.token.status == 'active'");
    expect(body).toContain("account().status == 'active'");
    expect(body).toContain("claimsMatchAccount()");
  });

  it("«claimsMatchAccount» compara la versión del token con la de la ficha", () => {
    expect(RULES).toMatch(
      /request\.auth\.token\.claimsVersion\s*==\s*account\(\)\.claimsVersion/,
    );
  });

  it("«isAdmin» exige rol en el token y en la ficha, además de cuenta activa", () => {
    const fn = RULES.slice(RULES.indexOf("function isAdmin"));
    const body = fn.slice(0, fn.indexOf("\n    }"));
    expect(body).toContain("isActive()");
    expect(body).toContain("request.auth.token.role == 'admin'");
    expect(body).toContain("account().role == 'admin'");
  });

  it("la ficha de cuenta es obligatoria: sin ella, la lectura falla en cerrado", () => {
    // `get()` de un documento inexistente provoca error de evaluación, y un
    // error deniega: una cuenta de Authentication sin alta no accede.
    expect(RULES).toContain(
      "get(/databases/$(database)/documents/accounts/$(request.auth.uid))",
    );
  });
});

describe("7. el histórico no se puede ordenar desde el cliente", () => {
  it("ninguna regla de lectura del histórico depende de archivado o fechas", () => {
    const source = block(COLLECTIONS.progressHistory);
    expect(source).not.toMatch(/archivedAt/);
    expect(source).not.toMatch(/orderBy/);
  });
});
