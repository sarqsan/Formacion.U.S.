import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPublicFirebaseConfig } from "@/server/firebase/public-config";

/**
 * DIAGNÓSTICO DE CONEXIÓN: SOLO LECTURA Y SIN ERRORES DE PEGADO
 * ============================================================
 *
 * Dos garantías que el usuario pidió expresamente:
 *
 *   1. `npm run check:firebase` **no escribe**: se comprueba leyendo el propio
 *      script y buscando cualquier operación de escritura. Si alguien añade un
 *      `.set()` o un `runTransaction`, esta prueba falla.
 *   2. La configuración pública del SDK web se valida **antes** de conectar:
 *      un `appId` de otro proyecto o un `apiKey` pegado a medias se detectan
 *      sin gastar lecturas ni dar un error confuso de Firebase.
 *
 * No hay red en estas pruebas: son análisis de texto y lógica pura.
 */

function scriptSource(): string {
  const path = fileURLToPath(new URL("../../scripts/firebase-check.ts", import.meta.url));
  return readFileSync(path, "utf8");
}

/** Quita comentarios para no confundir la documentación con código. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const code = stripComments(scriptSource());

describe("el diagnóstico no escribe", () => {
  const writeCalls = [
    ".set(",
    ".add(",
    ".update(",
    ".delete(",
    ".create(",
    ".commit(",
    "runTransaction(",
    "writeBatch(",
    "bulkWriter(",
    "recursiveDelete(",
    "createUser(",
    "updateUser(",
    "deleteUser(",
    "setCustomUserClaims(",
    "revokeRefreshTokens(",
  ];

  it("no contiene ninguna operación de escritura", () => {
    for (const call of writeCalls) {
      expect(code, `el script contiene ${call}`).not.toContain(call);
    }
  });

  it("no invoca tareas que modifican el proyecto", () => {
    expect(code).not.toContain("db:init");
    expect(code).not.toContain("deploy");
    expect(code).not.toContain("seed");
    expect(code).not.toContain("import confirm");
  });

  it("usa solo lecturas", () => {
    expect(code).toContain("listCollections(");
    expect(code).toContain(".count()");
    expect(code).toContain(".get()");
    expect(code).toContain("listUsers(");
  });

  it("lo declara en la salida", () => {
    expect(code).toContain("SOLO LECTURA");
    expect(code).toContain("No se ha escrito nada");
  });
});

describe("modo sin red (--setup)", () => {
  it("existe el comando y no intenta conectar", () => {
    expect(code).toContain("--setup");
    expect(code).toContain("setupOnly");
    // El intento de conexión tiene que quedar detrás de la condición: si se
    // llamara siempre, `check:setup` no sería seguro antes de tener credenciales.
    expect(code).toMatch(/configOnly \|\| setupOnly/);
  });

  it("usa la misma valoración de preparación que la pantalla de acceso", () => {
    expect(code).toContain("assessFirebaseReadiness");
  });

  it("avisa de que las secretas no se pegan en el chat", () => {
    // La salida se copia y se pega en conversaciones e informes: el aviso tiene
    // que estar en el propio comando, no solo en la documentación.
    expect(code).toContain("pendingSecrets");
    expect(code).toContain("[SECRETA]");
    expect(code).toContain("se pegan en el chat");
  });

  it("la comprobación de preparación no importa nada de Firestore", () => {
    const readiness = readFileSync(
      fileURLToPath(new URL("../../src/server/firebase/readiness.ts", import.meta.url)),
      "utf8",
    );
    expect(readiness).not.toContain("firebase-admin");
    expect(readiness).not.toContain("getFirestore");
    expect(readiness).not.toContain("getAdminDb");
  });

  it("el script npm existe y apunta al modo sin red", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:setup"]).toContain("--setup");
  });
});

describe("validación de la configuración pública", () => {
  const valid = {
    FIREBASE_PROJECT_ID: "formacionus-63555",
    NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "formacionus-63555.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "formacionus-63555",
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:123456789012:web:abcdef1234567890",
    AUTH_EMAIL_DOMAIN: "formacion.invalid",
    NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.invalid",
  } as const;

  const field = (env: Record<string, string>, name: string) =>
    checkPublicFirebaseConfig(env).issues.find((issue) => issue.field === name);

  it("acepta una configuración completa y coherente", () => {
    const result = checkPublicFirebaseConfig({ ...valid });
    expect(result.ok).toBe(true);
    expect(result.issues.every((issue) => issue.ok)).toBe(true);
  });

  it("detecta que el cliente apunta a otro proyecto", () => {
    const result = checkPublicFirebaseConfig({
      ...valid,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "otro-proyecto",
    });
    expect(result.ok).toBe(false);
    expect(field({ ...valid, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "otro-proyecto" }, "NEXT_PUBLIC_FIREBASE_PROJECT_ID")).toMatchObject(
      { ok: false },
    );
  });

  it("detecta una apiKey que no es de Firebase", () => {
    expect(field({ ...valid, NEXT_PUBLIC_FIREBASE_API_KEY: "AIza-corta" }, "NEXT_PUBLIC_FIREBASE_API_KEY")).toMatchObject({ ok: false });
    expect(field({ ...valid, NEXT_PUBLIC_FIREBASE_API_KEY: "pegaso-123" }, "NEXT_PUBLIC_FIREBASE_API_KEY")).toMatchObject({ ok: false });
  });

  it("detecta un authDomain pegado con https:// o con barra", () => {
    expect(
      field(
        { ...valid, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "https://formacionus-63555.firebaseapp.com" },
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ),
    ).toMatchObject({ ok: false });
    expect(
      field(
        { ...valid, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "formacionus-63555.firebaseapp.com/" },
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      ),
    ).toMatchObject({ ok: false });
  });

  it("detecta un appId mal formado", () => {
    expect(
      field({ ...valid, NEXT_PUBLIC_FIREBASE_APP_ID: "formacionus-63555" }, "NEXT_PUBLIC_FIREBASE_APP_ID"),
    ).toMatchObject({ ok: false });
  });

  it("detecta que el dominio de correo no coincide con el del servidor", () => {
    const result = checkPublicFirebaseConfig({
      ...valid,
      NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "otro.invalid",
    });
    expect(result.ok).toBe(false);
    expect(
      field({ ...valid, NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "otro.invalid" }, "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN"),
    ).toMatchObject({ ok: false });
  });

  it("informa de cada valor que falta, con la ruta de la consola", () => {
    const result = checkPublicFirebaseConfig({});
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(5);
    for (const issue of result.issues) {
      expect(issue.ok).toBe(false);
      expect(issue.fix).toBeTruthy();
    }
  });

  it("avisa si se usa un dominio de correo real en lugar de .invalid", () => {
    const result = checkPublicFirebaseConfig({
      ...valid,
      AUTH_EMAIL_DOMAIN: "formacion.example.org",
      NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.example.org",
    });
    expect(result.ok).toBe(true);
    expect(result.issues.find((issue) => issue.field === "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN")?.detail).toMatch(
      /invalid/,
    );
  });
});

describe("el identificador del proyecto está alineado en todo el repositorio", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));

  function read(relative: string): string {
    return readFileSync(`${root}${relative}`, "utf8");
  }

  it("EXPECTED_PROJECT coincide con .firebaserc", () => {
    const firebaserc = JSON.parse(read(".firebaserc")) as { projects: { default: string } };
    expect(scriptSource()).toContain(`const EXPECTED_PROJECT = "${firebaserc.projects.default}"`);
  });

  it("FIREBASE_PROJECT_ID y NEXT_PUBLIC_FIREBASE_PROJECT_ID de .env.example son el mismo", () => {
    const example = read(".env.example");
    const server = /^FIREBASE_PROJECT_ID=(.+)$/m.exec(example)?.[1]?.trim();
    const client = /^NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)$/m.exec(example)?.[1]?.trim();
    expect(server).toBeTruthy();
    expect(client).toBe(server);
    expect(scriptSource()).toContain(`const EXPECTED_PROJECT = "${server}"`);
  });

  it("el ID tiene forma de identificador de proyecto de Firebase", () => {
    const firebaserc = JSON.parse(read(".firebaserc")) as { projects: { default: string } };
    expect(firebaserc.projects.default).toMatch(/^[a-z0-9][a-z0-9-]{2,39}$/);
  });

  it("no queda ninguna referencia al identificador antiguo", () => {
    const offenders = [".firebaserc", ".env.example", "firebase.json", "scripts/firebase-check.ts",
      "src/server/firebase/public-config.ts", "docs/CONEXION-FIREBASE.md", "docs/INFORME-FASE-8.md"]
      .filter((file) => /formacionus(?!-63555)/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

describe("el script usa la validación", () => {
  it("importa la comprobación pública", () => {
    expect(scriptSource()).toContain("checkPublicFirebaseConfig");
  });

  it("compara el proyecto configurado con el previsto", () => {
    expect(scriptSource()).toContain('const EXPECTED_PROJECT = "formacionus-63555"');
  });
});
