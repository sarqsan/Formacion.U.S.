import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assessFirebaseReadiness,
  missingConfiguration,
  type FirebaseReadiness,
} from "@/server/firebase/readiness";

/**
 * PREPARACIÓN PARA CONECTAR CON FIREBASE (sin red)
 * ================================================
 *
 * `assessFirebaseReadiness` responde a una pregunta concreta: **¿qué falta para
 * que esta instalación pueda hablar con `formacionus-63555`?** Se comprueba
 * aquí porque es lo que decide si el formulario de acceso se muestra y qué se
 * le dice a quien está desplegando: un error en esta lógica se traduce en «no
 * puedo entrar y no sé por qué».
 *
 * Lo que estas pruebas NO demuestran: que el proyecto responda, que las
 * credenciales sean válidas para Google ni que existan los permisos. Eso exige
 * red y credenciales (`npm run check:firebase`).
 */

const PROJECT = "formacionus-63555";

/** Par RSA real generado en memoria: ninguna clave del repositorio. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const serverEnv = {
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_CLIENT_EMAIL: `formacion@app-123.iam.gserviceaccount.com`,
  FIREBASE_PRIVATE_KEY: privateKey,
};

const webEnv = {
  NEXT_PUBLIC_FIREBASE_API_KEY: `AIza${"x".repeat(35)}`,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1234567890:web:abcdef123456",
  NEXT_PUBLIC_AUTH_EMAIL_DOMAIN: "formacion.invalid",
};

function findings(readiness: FirebaseReadiness, level: "FAILED" | "PASSED") {
  return [...readiness.serverFindings, ...readiness.webFindings]
    .filter((finding) => finding.level === level)
    .map((finding) => finding.id);
}

describe("instalación sin configurar", () => {
  it("no está lista y no dice que lo esté", () => {
    const readiness = assessFirebaseReadiness({});

    expect(readiness.ready).toBe(false);
    expect(readiness.serverReady).toBe(false);
    expect(readiness.webReady).toBe(false);
  });

  it("nombra exactamente lo que falta, en el orden en que se rellena", () => {
    const readiness = assessFirebaseReadiness({});

    expect(readiness.actions[0]).toContain("FIREBASE_PROJECT_ID");
    expect(missingConfiguration(readiness)).toEqual(
      expect.arrayContaining([
        "FIREBASE_PROJECT_ID",
        "FIREBASE_CLIENT_EMAIL",
        "NEXT_PUBLIC_FIREBASE_API_KEY",
        "NEXT_PUBLIC_FIREBASE_APP_ID",
      ]),
    );
  });

  it("cada acción nombra la variable que hay que tocar", () => {
    const readiness = assessFirebaseReadiness({});

    for (const action of readiness.actions) {
      expect(action).toMatch(/^[A-Z0-9_]+\s→/);
    }
  });
});

describe("solo servidor / solo web", () => {
  it("con credenciales de servidor pero sin app web, no está listo", () => {
    const readiness = assessFirebaseReadiness(serverEnv);

    expect(readiness.serverReady).toBe(true);
    expect(readiness.webReady).toBe(false);
    expect(readiness.ready).toBe(false);
    // El servidor ya está bien: no se le pide nada más en las acciones.
    expect(readiness.actions.join(" ")).not.toContain("FIREBASE_PRIVATE_KEY");
    expect(readiness.actions.join(" ")).toContain("NEXT_PUBLIC_FIREBASE_APP_ID");
  });

  it("con app web pero sin credenciales, tampoco", () => {
    const readiness = assessFirebaseReadiness(webEnv);

    expect(readiness.webReady).toBe(true);
    expect(readiness.serverReady).toBe(false);
    expect(readiness.actions.join(" ")).toContain("Cuentas de servicio");
  });

  it("con las dos partes, los valores están completos (aunque no probados)", () => {
    const readiness = assessFirebaseReadiness({ ...serverEnv, ...webEnv });

    expect(readiness.ready).toBe(true);
    expect(readiness.actions).toEqual([]);
    expect(findings(readiness, "FAILED")).toEqual([]);
  });
});

describe("errores de pegado que rompen la conexión sin dar pistas", () => {
  it("un proyecto distinto del previsto se rechaza", () => {
    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      FIREBASE_PROJECT_ID: "otra-aplicacion-123",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "otra-aplicacion-123",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "otra-aplicacion-123.firebaseapp.com",
    });

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("FIREBASE_PROJECT_ID");
  });

  it("cliente y servidor en proyectos distintos se detecta", () => {
    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "otro-proyecto-99999",
    });

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  });

  it("una clave privada que no es PEM se rechaza", () => {
    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      FIREBASE_PRIVATE_KEY: "no-es-una-clave",
    });

    expect(readiness.serverReady).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("FIREBASE_PRIVATE_KEY");
  });

  it("una clave pública pegada por error no pasa como privada", () => {
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      FIREBASE_PRIVATE_KEY: publicKey,
    });

    expect(readiness.serverReady).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("FIREBASE_PRIVATE_KEY");
  });

  it("una API key de otro tipo se rechaza en la parte web", () => {
    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      NEXT_PUBLIC_FIREBASE_API_KEY: "no-es-una-api-key",
    });

    expect(readiness.webReady).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("NEXT_PUBLIC_FIREBASE_API_KEY");
  });

  it("acepta la clave con los \\n escapados, como se pega desde el JSON", () => {
    const readiness = assessFirebaseReadiness({
      ...serverEnv,
      ...webEnv,
      FIREBASE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    });

    expect(readiness.ready).toBe(true);
  });
});

describe("endurecimiento de producción", () => {
  const production = { ...serverEnv, ...webEnv, NODE_ENV: "production" };

  it("en producción sin APP_ORIGIN no está listo", () => {
    const readiness = assessFirebaseReadiness(production);

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("APP_ORIGIN");
  });

  it("en producción sin prefijo __Host- no está listo", () => {
    const readiness = assessFirebaseReadiness({
      ...production,
      APP_ORIGIN: "https://formacion.example",
    });

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("SESSION_COOKIE_NAME");
  });

  it("en producción con http fuera de local no está listo", () => {
    const readiness = assessFirebaseReadiness({
      ...production,
      APP_ORIGIN: "http://formacion.example",
      SESSION_COOKIE_NAME: "__Host-formacion_session",
    });

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("APP_ORIGIN");
  });

  it("en producción con https y __Host- sí está listo", () => {
    const readiness = assessFirebaseReadiness({
      ...production,
      APP_ORIGIN: "https://formacion.example",
      SESSION_COOKIE_NAME: "__Host-formacion_session",
    });

    expect(readiness.ready).toBe(true);
  });

  it("en producción con variables de emulador no está listo", () => {
    const readiness = assessFirebaseReadiness({
      ...production,
      APP_ORIGIN: "https://formacion.example",
      SESSION_COOKIE_NAME: "__Host-formacion_session",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    });

    expect(readiness.ready).toBe(false);
    expect(findings(readiness, "FAILED")).toContain("EMULATOR_IN_PRODUCTION");
  });
});

describe("emulador y demostración", () => {
  it("con emulador no hacen falta credenciales de servicio", () => {
    const readiness = assessFirebaseReadiness({
      ...webEnv,
      FIREBASE_PROJECT_ID: PROJECT,
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    });

    expect(readiness.serverReady).toBe(true);
    expect(readiness.ready).toBe(true);
  });

  it("en modo demostración se avisa de que Firebase no se usará", () => {
    const readiness = assessFirebaseReadiness({ ...serverEnv, ...webEnv, DEMO_MODE: "1" });

    expect(readiness.demoMode).toBe(true);
    expect(readiness.serverFindings.map((finding) => finding.detail).join(" ")).not.toContain(
      "DEMO_MODE",
    );
    // La valoración es de configuración: en la CLI se añade el aviso aparte.
    expect(readiness.ready).toBe(true);
  });

  it("sin DEMO_MODE, demoMode es falso", () => {
    expect(assessFirebaseReadiness({ ...serverEnv, ...webEnv }).demoMode).toBe(false);
  });
});

describe("cuota de PDF", () => {
  it("un presupuesto no numérico se rechaza", () => {
    const readiness = assessFirebaseReadiness({ PDF_STORAGE_BUDGET_MB: "mucho" });

    expect(findings(readiness, "FAILED")).toContain("PDF_STORAGE_BUDGET_MB");
  });

  it("un presupuesto válido se acepta y se explica que se acota", () => {
    const readiness = assessFirebaseReadiness({ PDF_STORAGE_BUDGET_MB: "512" });
    const finding = readiness.serverFindings.find((item) => item.id === "PDF_STORAGE_BUDGET_MB");

    expect(finding?.level).toBe("PASSED");
    expect(finding?.detail).toContain("512 MiB");
  });
});

describe("no filtra secretos", () => {
  it("el detalle de la clave no contiene la clave", () => {
    const readiness = assessFirebaseReadiness({ ...serverEnv, ...webEnv });
    const serialized = JSON.stringify(readiness);

    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain(privateKey.slice(40, 80));
  });

  it("del correo solo se muestra el dominio", () => {
    const readiness = assessFirebaseReadiness({ ...serverEnv, ...webEnv });
    const serialized = JSON.stringify(readiness);

    expect(serialized).not.toContain("formacion@app-123");
    expect(serialized).toContain("gserviceaccount.com");
  });
});
