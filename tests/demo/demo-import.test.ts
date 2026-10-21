import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePeopleWorkbook } from "@/server/import/excel";
import { buildImportPreview, type ImportDependencies } from "@/server/import/service";
import { DEMO_ACCOUNTS } from "@/demo/content";

/**
 * IMPORTACIÓN DE EJEMPLO
 * ======================
 *
 * El fichero `public/demo/personas-sinteticas.xlsx` es el que se descarga en la
 * pantalla de importación. Esta prueba comprueba que el lector real lo entiende
 * y que la vista previa marca correctamente lo que se verá en la demostración.
 */

const ADMIN = { uid: "demo-admin", role: "admin" as const, status: "active" as const };

function demoDependencies(): ImportDependencies {
  const usernames = () => new Set(DEMO_ACCOUNTS.map((account) => account.username));
  return {
    directory: {
      listTakenUsernames: async () => usernames(),
      isUsernameTaken: async (username: string) => usernames().has(username),
    },
    provisioner: {
      createAccount: async () => {
        throw new Error("no se crean cuentas en la demostración");
      },
      rollbackAccount: async () => undefined,
    },
    audit: { record: async () => undefined },
    authEmailDomain: "formacion.invalid",
    activationTtlHours: 24,
  };
}

describe("Excel de ejemplo de la demostración", () => {
  const buffer = readFileSync(join(process.cwd(), "public/demo/personas-sinteticas.xlsx"));

  it("se lee con el mismo lector que la importación real", async () => {
    const parsed = await parsePeopleWorkbook(buffer);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 2, rol: "ROL 1", apellido: "Ejemplo" });
  });

  it("marca el rol no admitido y detecta las cuentas que ya existen", async () => {
    const parsed = await parsePeopleWorkbook(buffer);
    const { preview } = await buildImportPreview(
      { rows: parsed.rows, actor: ADMIN },
      demoDependencies(),
    );

    expect(preview.summary.totalRows).toBe(4);
    expect(preview.summary.invalid).toBe(1);
    expect(preview.summary.valid).toBe(1); // «Muestra» es la única nueva
    expect(preview.summary.duplicates).toBe(2);
    // Los duplicados quedan pendientes de decisión: la confirmación se bloquea.
    expect(preview.summary.confirmable).toBe(false);

    const invalid = preview.rows.find((row) => row.status === "error");
    expect(invalid?.status === "error" && invalid.issues[0].code).toBe("ROL_INVALID");
  });

  it("todos los datos del ejemplo son ficticios", () => {
    const text = DEMO_ACCOUNTS.map((account) => account.username).join(" ");
    expect(text).not.toMatch(/@/);
    expect(DEMO_ACCOUNTS.every((account) => account.username.includes("."))).toBe(true);
  });
});
