import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/text";
import { verifyAccountPassword } from "@/server/auth/identity-toolkit";

/**
 * COMPROBACIÓN DE LA CONTRASEÑA ACTUAL
 * ====================================
 *
 * El SDK de Admin no sabe verificar contraseñas, así que la comprobación se hace
 * contra Identity Toolkit con la clave web del proyecto. Estas pruebas fijan lo
 * importante **sin red**: qué se considera «contraseña incorrecta», qué es un
 * problema temporal y qué no se puede afirmar.
 *
 * La distinción no es cosmética: decir «contraseña incorrecta» cuando Firebase
 * está limitando los intentos haría que el usuario cambiara una contraseña que
 * era correcta.
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function stub(
  status: number,
  payload: unknown,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const INPUT = { email: "persona1@formacion.invalid", password: "ClaveActual2025", apiKey: "AIzaClavePublica" };

async function expectError(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toBeInstanceOf(DomainError);
  await promise.catch((error: DomainError) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
}

describe("contraseña actual: se acepta", () => {
  it("devuelve true cuando Firebase acepta las credenciales", async () => {
    const { fetchImpl, calls } = stub(200, { localId: "uid-1", idToken: "…" });
    const ok = await verifyAccountPassword({ ...INPUT, fetchImpl });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("accounts:signInWithPassword");
    expect(calls[0]?.url).toContain("key=AIzaClavePublica");
    expect(calls[0]?.body).toEqual({ email: INPUT.email, password: INPUT.password });
  });
});

describe("contraseña actual: se rechaza", () => {
  it.each([
    ["INVALID_PASSWORD", 400],
    ["EMAIL_NOT_FOUND", 400],
    ["INVALID_LOGIN_CREDENTIALS", 400],
    ["INVALID_EMAIL", 400],
  ])("%s devuelve false sin lanzar", async (code, status) => {
    const { fetchImpl } = stub(status, { error: { message: `${code} : mensaje interno` } });
    await expect(verifyAccountPassword({ ...INPUT, fetchImpl })).resolves.toBe(false);
  });

  it("un 400 sin código conocido no se interpreta como «contraseña incorrecta»", async () => {
    const { fetchImpl } = stub(400, { error: { message: "API_KEY_INVALID : clave mal" } });
    await expectError(verifyAccountPassword({ ...INPUT, fetchImpl }), "AUTH_UNAVAILABLE", 503);
  });
});

describe("contraseña actual: no se puede afirmar nada", () => {
  it("los intentos limitados se informan como tales, no como contraseña incorrecta", async () => {
    const { fetchImpl } = stub(429, { error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } });
    await expectError(verifyAccountPassword({ ...INPUT, fetchImpl }), "RATE_LIMITED", 429);
  });

  it("una cuenta deshabilitada en Auth se distingue", async () => {
    const { fetchImpl } = stub(400, { error: { message: "USER_DISABLED" } });
    await expectError(verifyAccountPassword({ ...INPUT, fetchImpl }), "ACCOUNT_DISABLED", 403);
  });

  it("un fallo de red no se convierte en «contraseña incorrecta»", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expectError(verifyAccountPassword({ ...INPUT, fetchImpl }), "AUTH_UNAVAILABLE", 503);
  });

  it("un 500 no se convierte en «contraseña incorrecta»", async () => {
    const { fetchImpl } = stub(500, {});
    await expectError(verifyAccountPassword({ ...INPUT, fetchImpl }), "AUTH_UNAVAILABLE", 503);
  });
});
