import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Seguridad del workflow de diagnóstico (`.github/workflows/firebase-check.yml`).
 *
 * Estas pruebas leen el YAML y comprueban las propiedades que no pueden
 * depender de la buena voluntad de quien edite el fichero:
 *
 *   - solo se dispara a mano, desde `main`, y no acepta parámetros;
 *   - el trabajo no tiene permisos de escritura;
 *   - los secretos existen únicamente en los pasos que los necesitan y nunca
 *     se imprimen ni se escriben en artefactos;
 *   - no se ejecutan comandos arbitrarios (`run` estáticos, sin entradas);
 *   - el comando es `check:firebase`, que es de solo lectura.
 *
 * Lo que NO demuestran: que el entorno `production-audit` exista, que tenga
 * revisores ni que los secretos estén cargados. Eso es configuración externa.
 */

const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/firebase-check.yml");
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, string>;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      if?: string;
      environment?: string;
      "runs-on"?: string;
      "timeout-minutes"?: number;
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

const workflow = parse(workflowText) as Workflow;
const job = workflow.jobs?.check;
const steps = job?.steps ?? [];

const stepByName = (prefix: string): WorkflowStep => {
  const found = steps.find((step) => step.name?.startsWith(prefix));
  if (!found) throw new Error(`No existe el paso «${prefix}» en el workflow`);
  return found;
};

const ALLOWED_ACTIONS: Record<string, string> = {
  "actions/checkout": "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
  "actions/setup-node": "a0853c24544627f65ddf259abe73b1d18a591444",
};

describe("disparo", () => {
  it("solo workflow_dispatch, sin entradas", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    // Sin `inputs`: no hay forma de pasar comandos, proyecto ni refs.
    expect(workflow.on?.workflow_dispatch).toBeNull();
  });

  it("no se dispara por push, PR, programación ni workflow_run", () => {
    expect(workflowText).not.toMatch(
      /^\s{2}(push|pull_request|pull_request_target|schedule|repository_dispatch|workflow_run):/m,
    );
  });

  it("solo ejecuta en main", () => {
    expect(job?.if).toContain("refs/heads/main");
  });
});

describe("permisos y entorno", () => {
  it("solo lectura de contenidos", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("usa el entorno protegido production-audit", () => {
    expect(job?.environment).toBe("production-audit");
  });

  it("no pide credenciales persistentes al descargar el repositorio", () => {
    // YAML interpreta `false` como booleano: se acepta el valor tal cual, pero
    // nunca `true` ni una cadena que no desactive la persistencia.
    const value = stepByName("Descargar").with?.["persist-credentials"];
    expect(String(value)).toBe("false");
  });
});

describe("secretos", () => {
  const secretSteps = steps.filter((step) =>
    Object.values(step.env ?? {}).some((value) => value.includes("secrets.")),
  );

  it("solo los pasos de comprobación y diagnóstico ven secretos", () => {
    expect(secretSteps.map((step) => step.name)).toEqual([
      "Comprobar que la configuración de entrada está completa",
      "Diagnóstico de solo lectura",
    ]);
  });

  it("la instalación de dependencias no recibe secretos", () => {
    const install = stepByName("Instalar dependencias");
    expect(JSON.stringify(install.env ?? {})).not.toContain("secrets.");
  });

  it("usa exclusivamente los secretos del entorno, con nombre propio", () => {
    const used = new Set<string>();
    for (const step of steps) {
      for (const value of Object.values(step.env ?? {})) {
        for (const match of value.matchAll(/secrets\.([A-Z0-9_]+)/g)) used.add(match[1]);
      }
    }
    expect([...used].sort()).toEqual([
      "DB_AUDIT_FIREBASE_CLIENT_EMAIL",
      "DB_AUDIT_FIREBASE_PRIVATE_KEY",
    ]);
  });

  it("ningún secreto se imprime ni se escribe en la salida", () => {
    for (const step of steps) {
      const script = step.run ?? "";
      for (const name of ["CLIENT_EMAIL", "PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) {
        // Comparaciones de vacío sí; volcados o impresiones del valor, no.
        expect(script).not.toMatch(new RegExp(`echo\\s+"?\\$\\{?${name}`, "i"));
        expect(script).not.toMatch(new RegExp(`printf[^\\n]*\\$\\{?${name}\\}?["']?\\s*$`, "m"));
        expect(script).not.toMatch(new RegExp(`cat\\s+.*${name}`, "i"));
      }
      expect(script).not.toMatch(/\bset\s+-x\b/);
      expect(script).not.toMatch(/\benv\b\s*$/m);
    }
  });

  it("no sube artefactos ni escribe fuera de GITHUB_OUTPUT/GITHUB_STEP_SUMMARY", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/upload-artifact/);
      // Cada redirección de escritura debe apuntar a una de las dos salidas
      // que GitHub proporciona; cualquier otro destino se considera una fuga.
      for (const match of (step.run ?? "").matchAll(/>>\s*([^\s]+)/g)) {
        expect(["$GITHUB_OUTPUT", '"$GITHUB_OUTPUT"', "$GITHUB_STEP_SUMMARY", '"$GITHUB_STEP_SUMMARY"'])
          .toContain(match[1]);
      }
    }
    expect(steps.some((step) => (step.uses ?? "").includes("upload-artifact"))).toBe(false);
  });
});

describe("comandos", () => {
  it("las únicas acciones son checkout y setup-node, fijadas por SHA", () => {
    for (const step of steps) {
      if (!step.uses) continue;
      const [name, ref] = step.uses.split("@");
      expect(ALLOWED_ACTIONS[name]).toBe(ref);
    }
  });

  it("ejecuta `check:firebase` y nada más que pueda escribir", () => {
    const scripts = steps.map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain("npm run check:firebase");
    for (const forbidden of [
      "db:init",
      "db:check",
      "firebase deploy",
      "npm publish",
      "git push",
      "curl ",
      "wget ",
      "createUser",
      "setCustomUserClaims",
      "BOOTSTRAP_CONFIRM",
    ]) {
      expect(scripts).not.toContain(forbidden);
    }
    expect(workflowText).not.toMatch(/check:firebase[^\n]*--(?!json)/);
  });

  it("un fallo del diagnóstico se propaga como código de salida", () => {
    const check = stepByName("Diagnóstico");
    expect(check.run).toContain('exit "$CODE"');
  });

  it("si falta configuración, se detiene antes de intentar conectar", () => {
    const preflight = stepByName("Comprobar que la configuración");
    expect(preflight.run).toContain("ready=false");
    expect(preflight.run).toContain("exit 1");
    const check = stepByName("Diagnóstico");
    expect(check.if).toContain("steps.preflight.outputs.ready == 'true'");
  });

  it("el proyecto está fijado y se comprueba antes de usarlo", () => {
    expect(job?.env?.FIREBASE_PROJECT_ID).toBe("formacionus-63555");
    expect(job?.env?.NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("formacionus-63555");
    expect(stepByName("Comprobar que la configuración").run).toContain("formacionus-63555");
  });

  it("el resumen solo publica estado y código, nunca el registro completo", () => {
    const summary = stepByName("Resumen");
    expect(summary.run).toContain("GITHUB_STEP_SUMMARY");
    expect(summary.run).not.toContain("OUTPUT");
  });
});
