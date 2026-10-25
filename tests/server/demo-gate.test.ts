import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideDemoMode, demoEnabled } from "@/server/config/demo-gate";
import { assessFirebaseReadiness } from "@/server/firebase/readiness";

/**
 * CANDADO DE LA DEMOSTRACIÓN
 * ==========================
 *
 * La demostración entra **sin contraseña**: la cookie lleva el uid de una cuenta
 * inventada. En un portátil es una función; en el servidor sería una puerta
 * abierta. Antes bastaba con que alguien escribiera `DEMO_MODE=1` en Vercel.
 *
 * Lo que se fija aquí:
 *   · con `NODE_ENV=production`, la demostración está cerrada **siempre**, aunque
 *     `DEMO_MODE=1` esté definido, y no hay variable que lo salte;
 *   · solo el valor exacto `1` la pide (`true`, `sí`, `yes` no la abren);
 *   · fuera de producción sigue funcionando igual que antes;
 *   · el diagnóstico lo dice en voz alta en vez de ignorarlo en silencio;
 *   · hay **una sola definición** del candado: nadie más lee `DEMO_MODE`.
 */

describe("decisión del candado", () => {
  it("sin DEMO_MODE no hay demostración", () => {
    expect(decideDemoMode({})).toEqual({ enabled: false, reason: "not-requested", warning: null });
    expect(decideDemoMode({ NODE_ENV: "development" }).enabled).toBe(false);
  });

  it("en producción se ignora aunque DEMO_MODE=1 esté puesto", () => {
    const decision = decideDemoMode({ DEMO_MODE: "1", NODE_ENV: "production" });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe("production");
    expect(decision.warning).toContain("se ignora");
  });

  it("no existe ninguna variable de escape", () => {
    // Si alguna vez se añade un «ALLOW_DEMO_IN_PRODUCTION», esta prueba lo caza:
    // el candado no debe poder saltarse desde el entorno.
    const env = {
      DEMO_MODE: "1",
      NODE_ENV: "production",
      DEMO_ALLOW_IN_PRODUCTION: "1",
      ALLOW_DEMO_IN_PRODUCTION: "1",
      DEMO_MODE_ALLOW_PRODUCTION: "true",
      VERCEL_ENV: "preview",
    };
    expect(decideDemoMode(env).enabled).toBe(false);
  });

  it("en desarrollo y en pruebas sí funciona", () => {
    expect(demoEnabled({ DEMO_MODE: "1", NODE_ENV: "development" })).toBe(true);
    expect(demoEnabled({ DEMO_MODE: "1", NODE_ENV: "test" })).toBe(true);
  });

  it("solo el valor exacto «1» la pide", () => {
    for (const value of ["true", "yes", "sí", "SI", "01", "1 ", "0", ""]) {
      expect(demoEnabled({ DEMO_MODE: value, NODE_ENV: "development" }), value).toBe(false);
    }
  });
});

describe("el candado se ve en el diagnóstico", () => {
  const base = {
    FIREBASE_PROJECT_ID: "formacionus-63555",
    FIREBASE_CLIENT_EMAIL: "firebase-adminsdk@formacionus-63555.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----",
    PDF_STORAGE_BUDGET_MB: "200",
    APP_ORIGIN: "https://formacionus.vercel.app",
    SESSION_COOKIE_NAME: "__Host-formacion_session",
    NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyA1234567890abcdefghijklmnopqrstu",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "formacionus-63555.firebaseapp.com",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "formacionus-63555",
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:1234567890:web:abcdef123456",
    NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.invalid",
  };

  it("con DEMO_MODE=1 en producción, la demostración no se usa y se avisa", () => {
    const readiness = assessFirebaseReadiness({
      ...base,
      NODE_ENV: "production",
      DEMO_MODE: "1",
    });

    expect(readiness.demoMode).toBe(false);
    const finding = readiness.serverFindings.find((item) => item.id === "DEMO_MODE_IN_PRODUCTION");
    expect(finding?.level).toBe("FAILED");
    expect(finding?.detail).toContain("NO se está usando");
    expect(readiness.actions.join(" ")).toContain("DEMO_MODE");
  });

  it("sin la variable no hay aviso", () => {
    const readiness = assessFirebaseReadiness({ ...base, NODE_ENV: "production" });
    expect(
      readiness.serverFindings.some((item) => item.id === "DEMO_MODE_IN_PRODUCTION"),
    ).toBe(false);
  });

  it("en desarrollo, DEMO_MODE=1 sí se refleja como demostración activa", () => {
    const readiness = assessFirebaseReadiness({
      ...base,
      NODE_ENV: "development",
      DEMO_MODE: "1",
    });
    expect(readiness.demoMode).toBe(true);
  });
});

describe("una sola definición del candado", () => {
  /** Ficheros de `src/` (sin entrar en pruebas ni en node_modules). */
  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
      else if (/\.(ts|tsx|mts)$/.test(entry)) files.push(full);
    }
    return files;
  }

  it("nadie más lee la variable DEMO_MODE a mano", () => {
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith(join("config", "demo-gate.ts")))
      .filter((file) => readFileSync(file, "utf8").includes("process.env.DEMO_MODE"));

    expect(offenders, `leen DEMO_MODE fuera del candado: ${offenders.join(", ")}`).toEqual([]);
  });

  it("el proxy y las páginas usan el candado", () => {
    const proxy = readFileSync(join(process.cwd(), "src", "proxy.ts"), "utf8");
    expect(proxy).toContain("demoEnabled()");
    expect(proxy).not.toContain('process.env.DEMO_MODE');
  });
});
