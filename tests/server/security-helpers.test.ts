import { afterEach, describe, expect, it } from "vitest";
import {
  activationExpiry,
  activationTokenMatches,
  generateActivationToken,
  generateUnusablePassword,
  hashActivationToken,
  isValidActivationTokenFormat,
  shortFingerprint,
} from "@/server/auth/tokens";
import {
  getServerConfig,
  normalizePrivateKey,
  resetServerConfigCache,
} from "@/server/config";
import { assertTrustedOrigin } from "@/server/http";
import { DomainError } from "@/domain/text";

afterEach(() => {
  resetServerConfigCache();
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.APP_ORIGIN;
});

describe("tokens de activación", () => {
  it("genera tokens de 256 bits en base64url", () => {
    const token = generateActivationToken();
    expect(token).toHaveLength(43);
    expect(isValidActivationTokenFormat(token)).toBe(true);
    expect(token).not.toBe(generateActivationToken());
  });

  it("guarda solo el hash, nunca el token", () => {
    const token = generateActivationToken();
    const hash = hashActivationToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashActivationToken(token)).toBe(hash);
  });

  it("compara sin filtrar el token y rechaza valores falsos", () => {
    const token = generateActivationToken();
    const hash = hashActivationToken(token);
    expect(activationTokenMatches(token, hash)).toBe(true);
    expect(activationTokenMatches(generateActivationToken(), hash)).toBe(false);
    expect(activationTokenMatches("basura", hash)).toBe(false);
    expect(activationTokenMatches(token, "")).toBe(false);
    expect(activationTokenMatches(token, "zz")).toBe(false);
  });

  it("rechaza formatos inválidos", () => {
    for (const value of ["", "corto", "a".repeat(43) + "==", "ñ".repeat(43), null, 123]) {
      expect(isValidActivationTokenFormat(value)).toBe(false);
    }
  });

  it("calcula caducidad", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(activationExpiry(now, 72).toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(() => activationExpiry(now, 0)).toThrow();
  });

  it("genera contraseñas temporales largas y distintas", () => {
    const a = generateUnusablePassword();
    const b = generateUnusablePassword();
    expect(a.length).toBeGreaterThanOrEqual(60);
    expect(a).not.toBe(b);
  });

  it("la huella corta no expone el valor", () => {
    const token = generateActivationToken();
    const fingerprint = shortFingerprint(token);
    expect(fingerprint).toHaveLength(12);
    expect(token.startsWith(fingerprint)).toBe(false);
  });
});

describe("configuración del servidor", () => {
  it("falla cerrado sin configuración", () => {
    expect(() => getServerConfig({})).toThrowError(
      expect.objectContaining({ code: "SERVER_NOT_CONFIGURED" }),
    );
  });

  it("exige credenciales si no hay emulador", () => {
    expect(() => getServerConfig({ FIREBASE_PROJECT_ID: "demo-formacion" })).toThrowError(
      expect.objectContaining({ code: "SERVER_NOT_CONFIGURED" }),
    );
  });

  it("acepta configuración completa", () => {
    const config = getServerConfig({
      FIREBASE_PROJECT_ID: "demo-formacion",
      FIREBASE_CLIENT_EMAIL: "sdk@demo.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      AUTH_EMAIL_DOMAIN: "formacion.invalid",
      NODE_ENV: "production",
      APP_ORIGIN: "https://formacion.example",
      SESSION_COOKIE_NAME: "__Host-formacion_session",
    });
    expect(config.usingEmulator).toBe(false);
    expect(config.AUTH_EMAIL_DOMAIN).toBe("formacion.invalid");
    expect(config.SESSION_TTL_HOURS).toBe(12);
  });

  it("exige APP_ORIGIN en producción (CSRF sin depender de Host)", () => {
    expect(() =>
      getServerConfig({
        FIREBASE_PROJECT_ID: "demo-formacion",
        FIREBASE_CLIENT_EMAIL: "sdk@demo.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        NODE_ENV: "production",
        SESSION_COOKIE_NAME: "__Host-formacion_session",
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVER_CONFIG_UNSAFE" }));
  });

  it("exige prefijo __Host- en la cookie de sesión de producción", () => {
    expect(() =>
      getServerConfig({
        FIREBASE_PROJECT_ID: "demo-formacion",
        FIREBASE_CLIENT_EMAIL: "sdk@demo.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        NODE_ENV: "production",
        APP_ORIGIN: "https://formacion.example",
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVER_CONFIG_UNSAFE" }));
  });

  it("exige https en APP_ORIGIN fuera de local", () => {
    expect(() =>
      getServerConfig({
        FIREBASE_PROJECT_ID: "demo-formacion",
        FIREBASE_CLIENT_EMAIL: "sdk@demo.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
        NODE_ENV: "production",
        APP_ORIGIN: "http://formacion.example",
        SESSION_COOKIE_NAME: "__Host-formacion_session",
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVER_CONFIG_UNSAFE" }));
  });

  it("acepta emulador sin credenciales reales en desarrollo", () => {
    const config = getServerConfig({
      FIREBASE_PROJECT_ID: "demo-formacion",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      NODE_ENV: "development",
    });
    expect(config.usingEmulator).toBe(true);
  });

  it("prohíbe emuladores en producción", () => {
    expect(() =>
      getServerConfig({
        FIREBASE_PROJECT_ID: "demo-formacion",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
        NODE_ENV: "production",
      }),
    ).toThrowError(expect.objectContaining({ code: "SERVER_CONFIG_UNSAFE" }));
  });

  it("rechaza dominios de correo interno inválidos", () => {
    expect(() =>
      getServerConfig({
        FIREBASE_PROJECT_ID: "demo-formacion",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
        AUTH_EMAIL_DOMAIN: "localhost",
      }),
    ).toThrow(DomainError);
  });

  it("normaliza la clave privada con saltos escapados", () => {
    expect(normalizePrivateKey("linea1\\nlinea2")).toBe("linea1\nlinea2");
    expect(normalizePrivateKey("linea1\nlinea2")).toBe("linea1\nlinea2");
  });
});

describe("comprobación de origen", () => {
  const makeRequest = (headers: Record<string, string>) =>
    new Request("https://formacion.example/api/x", { method: "POST", headers });

  it("acepta el origen configurado", () => {
    expect(() =>
      assertTrustedOrigin(
        makeRequest({ origin: "https://formacion.example" }),
        "https://formacion.example",
      ),
    ).not.toThrow();
  });

  it("acepta el mismo host de la petición", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest({ origin: "https://app.local", host: "app.local" }), undefined),
    ).not.toThrow();
  });

  it("rechaza orígenes ajenos", () => {
    expect(() =>
      assertTrustedOrigin(makeRequest({ origin: "https://evil.example" }), "https://formacion.example"),
    ).toThrowError(expect.objectContaining({ code: "ORIGIN_FORBIDDEN" }));
  });

  it("rechaza peticiones sin origen ni referer", () => {
    expect(() => assertTrustedOrigin(makeRequest({}), "https://formacion.example")).toThrowError(
      expect.objectContaining({ code: "ORIGIN_MISSING" }),
    );
  });

  it("rechaza si no se puede verificar ningún origen", () => {
    expect(() => assertTrustedOrigin(makeRequest({ origin: "https://x.example" }), undefined)).toThrowError(
      expect.objectContaining({ code: "ORIGIN_UNVERIFIABLE" }),
    );
  });

  it("no acepta un X-Forwarded-Host inventado por el llamante", () => {
    // Sin esta corrección, una página ajena podía enviar
    // `X-Forwarded-Host: evil.example` y su propio `Origin` pasaba el filtro.
    expect(() =>
      assertTrustedOrigin(
        makeRequest({
          origin: "https://evil.example",
          host: "formacion.example",
          "x-forwarded-host": "evil.example",
        }),
        "https://formacion.example",
      ),
    ).toThrowError(expect.objectContaining({ code: "ORIGIN_FORBIDDEN" }));
  });

  it("rechaza orígenes malformados", () => {
    expect(() => assertTrustedOrigin(makeRequest({ origin: "no-es-url" }), "https://x.example")).toThrow(
      DomainError,
    );
  });
});
