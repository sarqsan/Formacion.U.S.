import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  normalizePrivateKey,
  resolveAdminCredentials,
} from "../../scripts/lib/bootstrap-admin-core.mjs";

const ESCAPED_NEWLINE = String.raw`\n`;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-cred-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const serviceAccount = {
  project_id: "formacionus-63555",
  client_email: "bootstrap@formacionus-63555.iam.gserviceaccount.com",
  private_key: `-----BEGIN PRIVATE KEY-----${ESCAPED_NEWLINE}MIIE${ESCAPED_NEWLINE}-----END PRIVATE KEY-----${ESCAPED_NEWLINE}`,
};

describe("credenciales del alta de administradores", () => {
  it("sin nada devuelve null en vez de inventar credenciales", () => {
    expect(resolveAdminCredentials({})).toBeNull();
    expect(resolveAdminCredentials({ FIREBASE_PROJECT_ID: "solo-proyecto" })).toBeNull();
  });

  it("acepta las tres variables sueltas e indica su origen", () => {
    expect(
      resolveAdminCredentials({
        FIREBASE_PROJECT_ID: "formacionus-63555",
        FIREBASE_CLIENT_EMAIL: "bot@ejemplo.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY: "clave",
      }),
    ).toEqual({
      projectId: "formacionus-63555",
      clientEmail: "bot@ejemplo.iam.gserviceaccount.com",
      privateKey: "clave",
      source: "env",
    });
  });

  it("lee el fichero de cuenta de servicio de la consola", () => {
    const dir = tempDir();
    const file = join(dir, "cuenta.json");
    writeFileSync(file, JSON.stringify(serviceAccount));

    expect(resolveAdminCredentials({ FIREBASE_SERVICE_ACCOUNT_FILE: file })).toEqual({
      projectId: "formacionus-63555",
      clientEmail: "bootstrap@formacionus-63555.iam.gserviceaccount.com",
      privateKey: serviceAccount.private_key,
      source: "file",
    });
  });

  it("el fichero tiene prioridad sobre las variables sueltas", () => {
    const dir = tempDir();
    const file = join(dir, "cuenta.json");
    writeFileSync(file, JSON.stringify(serviceAccount));

    const result = resolveAdminCredentials({
      FIREBASE_SERVICE_ACCOUNT_FILE: file,
      FIREBASE_PROJECT_ID: "otro-proyecto",
      FIREBASE_CLIENT_EMAIL: "otro@ejemplo.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: "otra",
    });

    expect(result).toMatchObject({ projectId: "formacionus-63555", source: "file" });
  });

  it("avisa si el fichero no existe o no es JSON, sin volcar su contenido", () => {
    expect(() => resolveAdminCredentials({ FIREBASE_SERVICE_ACCOUNT_FILE: "/no/existe.json" })).toThrow(
      /FIREBASE_SERVICE_ACCOUNT_FILE/,
    );

    const dir = tempDir();
    const broken = join(dir, "roto.json");
    writeFileSync(broken, "{no es json");
    expect(() => resolveAdminCredentials({ FIREBASE_SERVICE_ACCOUNT_FILE: broken })).toThrow(
      /FIREBASE_SERVICE_ACCOUNT_FILE/,
    );
  });

  it("rechaza un fichero al que le faltan campos", () => {
    const dir = tempDir();
    const incomplete = join(dir, "incompleto.json");
    writeFileSync(incomplete, JSON.stringify({ project_id: "formacionus-63555" }));

    expect(() => resolveAdminCredentials({ FIREBASE_SERVICE_ACCOUNT_FILE: incomplete })).toThrow(
      /project_id, client_email y private_key/,
    );
  });

  it("normaliza los saltos de línea escapados de la clave PEM", () => {
    const normalized = normalizePrivateKey(serviceAccount.private_key);
    expect(normalized.split("\n")).toHaveLength(4);
    expect(normalized).not.toContain(ESCAPED_NEWLINE);
    expect(normalizePrivateKey(normalized)).toBe(normalized);
  });

  it("no toca una clave que ya trae saltos reales", () => {
    const real = "linea1\nlinea2";
    expect(normalizePrivateKey(real)).toBe(real);
  });
});
