import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Seguridad del workflow de auditoría (`.github/workflows/db-audit.yml`).
 *
 * Estas pruebas no "buscan cadenas": interpretan el YAML y ejecutan los mismos
 * bloques `run` con un `npm` sustituido, para comprobar el comportamiento de
 * seguridad (qué se publica, qué se descarta y con qué código se sale).
 *
 * Lo que NO pueden demostrar: que el entorno `production-audit` exista, que el
 * revisor esté configurado, que los secretos existan ni que GitHub ejecute el
 * trabajo. Eso es configuración externa, documentada en la entrega.
 */

const WORKFLOW_PATH = resolve(process.cwd(), ".github/workflows/db-audit.yml");
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
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
      env?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

const workflow = parse(workflowText) as Workflow;
const job = workflow.jobs?.audit;
const steps = job?.steps ?? [];

const stepByName = (name: string): WorkflowStep => {
  const found = steps.find((step) => step.name?.startsWith(name));
  if (!found) throw new Error(`No existe el paso «${name}» en el workflow`);
  return found;
};

const auditStep = stepByName("Auditar");
const summaryStep = stepByName("Resumen del trabajo");

/** SHA de la versión que declara `using: node24` en cada acción. */
const ALLOWED_ACTIONS: Record<string, { sha: string; major: number }> = {
  "actions/checkout": { sha: "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09", major: 5 },
  "actions/setup-node": { sha: "a0853c24544627f65ddf259abe73b1d18a591444", major: 5 },
};

describe("disparo del workflow", () => {
  it("solo admite workflow_dispatch, sin parámetros", () => {
    const triggers = Object.keys(workflow.on ?? {});
    expect(triggers).toEqual(["workflow_dispatch"]);
    // Sin `inputs`: no se aceptan proyecto, comandos ni refs como parámetro.
    expect(workflow.on?.workflow_dispatch).toBeNull();
  });

  it("no tiene otros disparadores en el texto (push, schedule, pull_request…)", () => {
    expect(workflowText).not.toMatch(/^\s{2}(push|pull_request|schedule|repository_dispatch|workflow_run):/m);
  });
});

describe("permisos", () => {
  it("declara exactamente contents: read", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("ningún paso ni job pide permisos adicionales", () => {
    expect(workflowText).not.toMatch(/write-all/);
    expect(workflowText).not.toMatch(/^\s+[\w-]+:\s*write\s*$/m);
    expect(workflowText).not.toMatch(/id-token:/);
    expect(workflowText).not.toMatch(/pull-requests:|issues:|packages:/);
  });
});

describe("condición de ejecución", () => {
  it("solo se ejecuta desde main", () => {
    expect(job?.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("exige el entorno production-audit (aprobación externa)", () => {
    expect(job?.environment).toBe("production-audit");
  });

  it("fija el proyecto y la autorización de producción en el propio YAML", () => {
    expect(job?.env).toMatchObject({
      FIREBASE_PROJECT_ID: "formacionus-63555",
      DB_ALLOW_PROD: "yes",
    });
  });
});

describe("acciones", () => {
  it("todas están fijadas por SHA completo, con comentario de versión", () => {
    const usesLines = workflowText.split("\n").filter((line) => /^\s*uses:/.test(line));
    expect(usesLines.length).toBeGreaterThanOrEqual(2);

    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+/);
      expect(line).not.toMatch(/@(v\d+|main|master|latest)\b/);
    }
  });

  it("usa las versiones con runtime node24 y no las de Node 20", () => {
    for (const [action, expected] of Object.entries(ALLOWED_ACTIONS)) {
      const step = steps.find((candidate) => candidate.uses?.startsWith(`${action}@`));
      expect(step, `Falta la acción ${action}`).toBeDefined();
      expect(step?.uses).toBe(`${action}@${expected.sha}`);
    }

    // Las versiones anteriores (node20) no deben reaparecer.
    expect(workflowText).not.toContain("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683");
    expect(workflowText).not.toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
  });

  it("checkout no conserva credenciales", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("no publica ni descarga artefactos", () => {
    expect(workflowText).not.toMatch(/upload-artifact|download-artifact|actions\/cache/);
    for (const step of steps) {
      expect(step.name ?? "").not.toMatch(/artefacto|artifact/i);
    }
  });
});

describe("secretos", () => {
  const referenced = [...workflowText.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
    (match) => match[1],
  );

  it("solo referencia los dos secretos exclusivos de la auditoría", () => {
    expect(new Set(referenced)).toEqual(
      new Set(["DB_AUDIT_FIREBASE_CLIENT_EMAIL", "DB_AUDIT_FIREBASE_PRIVATE_KEY"]),
    );
  });

  it("no usa los nombres genéricos que podrían heredarse del repositorio", () => {
    expect(referenced).not.toContain("FIREBASE_CLIENT_EMAIL");
    expect(referenced).not.toContain("FIREBASE_PRIVATE_KEY");
    expect(workflowText).not.toMatch(/secrets\.FIREBASE_(CLIENT_EMAIL|PRIVATE_KEY)/);
  });

  it("los secretos solo se exponen al paso de auditoría, mapeados a las variables del verificador", () => {
    for (const step of steps) {
      const env = step.env ?? {};
      const secretEntries = Object.entries(env).filter(([, value]) => value.includes("secrets."));
      if (step === auditStep) {
        expect(secretEntries).toEqual([
          ["FIREBASE_CLIENT_EMAIL", "${{ secrets.DB_AUDIT_FIREBASE_CLIENT_EMAIL }}"],
          ["FIREBASE_PRIVATE_KEY", "${{ secrets.DB_AUDIT_FIREBASE_PRIVATE_KEY }}"],
        ]);
        continue;
      }
      expect(secretEntries, `El paso «${step.name}» no debe recibir secretos`).toEqual([]);
    }
  });

  it("ningún paso imprime el valor de una credencial", () => {
    const installStep = stepByName("Instalar dependencias");
    for (const script of [installStep.run ?? "", auditStep.run ?? "", summaryStep.run ?? ""]) {
      expect(script).not.toMatch(/echo[^\n]*\$(\{)?(FIREBASE_CLIENT_EMAIL|FIREBASE_PRIVATE_KEY)/);
      expect(script).not.toMatch(/set -x|env\s*$|printenv/);
    }
  });

  it("no escribe variables de entorno persistentes entre pasos", () => {
    expect(workflowText).not.toContain("GITHUB_ENV");
  });
});

describe("ejecución del verificador", () => {
  it("lanza el verificador existente con --redact", () => {
    expect(auditStep.run).toContain("npm run db:check -- --redact");
  });

  it("propaga el código de salida del verificador", () => {
    expect(auditStep.run).toMatch(/exit "\$CODE"/);
  });

  it("toma la última línea de estado y la valida antes de publicarla", () => {
    expect(auditStep.run).toMatch(/grep -E '\^AUDITORÍA: ' \| tail -n 1/);
    expect(auditStep.run).toMatch(/STATUS_PATTERN='\^AUDITORÍA: \(AUDIT_BLOCKED\|NO_ADMIN\|ADMIN_COUNT \[0-9\]\+\)/);
    expect(auditStep.run).toMatch(/grep -qE "\$STATUS_PATTERN"/);
  });

  it("el resumen solo publica las variables ya validadas, nunca la salida cruda", () => {
    expect(summaryStep.run).not.toContain("$OUTPUT");
    expect(summaryStep.run).toMatch(/STATUS="\$\{STATUS:-\}"/);
    expect(summaryStep.run).toMatch(/grep -qE "\$STATUS_PATTERN"/);
    expect(summaryStep.run).toContain("AUDIT_BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// Comportamiento real de los bloques `run` (con un `npm` sustituido)
// ---------------------------------------------------------------------------

const canRunShell = process.platform !== "win32" && existsSync("/bin/bash");

describe.skipIf(!canRunShell)("comportamiento de los pasos del workflow", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "db-audit-test-"));
    writeFileSync(join(dir, "audit.sh"), auditStep.run ?? "");
    writeFileSync(join(dir, "summary.sh"), summaryStep.run ?? "");
    // `npm` sustituido: imprime lo que diga STUB_OUTPUT y sale con STUB_EXIT.
    writeFileSync(
      join(dir, "npm"),
      '#!/usr/bin/env bash\ncat "$STUB_OUTPUT"\nexit "${STUB_EXIT:-0}"\n',
    );
    chmodSync(join(dir, "npm"), 0o755);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  interface Outcome {
    status: string;
    summary: string;
    code: string;
    exitCode: number;
    stepSummary: string;
  }

  const runWorkflow = (output: string, exit: number): Outcome => {
    const outputFile = join(dir, "gh-output.txt");
    const summaryFile = join(dir, "step-summary.md");
    const stubFile = join(dir, "stub-output.txt");
    writeFileSync(stubFile, output);
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");

    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_OUTPUT: stubFile,
      STUB_EXIT: String(exit),
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    };

    let exitCode = 0;
    try {
      execFileSync("bash", [join(dir, "audit.sh")], { env, stdio: "pipe" });
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 1;
    }

    const parsed = Object.fromEntries(
      readFileSync(outputFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );

    try {
      execFileSync("bash", [join(dir, "summary.sh")], {
        env: {
          ...env,
          STATUS: parsed.status ?? "",
          SUMMARY: parsed.summary ?? "",
          CODE: parsed.code ?? "",
        },
        stdio: "pipe",
      });
    } catch {
      // El paso de resumen no debe fallar; si fallara, la prueba lo delata abajo.
    }

    return {
      status: parsed.status ?? "",
      summary: parsed.summary ?? "",
      code: parsed.code ?? "",
      exitCode,
      stepSummary: readFileSync(summaryFile, "utf8"),
    };
  };

  const REAL_STATUS = "AUDITORÍA: ADMIN_COUNT 2 · ESQUEMA: OK · ÍNDICES: OK";

  it("ejecución correcta: publica el estado y el resumen", () => {
    const result = runWorkflow(
      `· [info] INDEXES_OK: ok\nResumen: 0 error(es), 0 aviso(s), 7 informativo(s).\n${REAL_STATUS}\nResultado: sin errores.\n`,
      0,
    );

    expect(result.status).toBe(REAL_STATUS);
    expect(result.summary).toBe("Resumen: 0 error(es), 0 aviso(s), 7 informativo(s).");
    expect(result.code).toBe("0");
    expect(result.exitCode).toBe(0);
    expect(result.stepSummary).toContain(REAL_STATUS);
  });

  it("sin administradores: NO_ADMIN, exit 1 y no se confunde con un bloqueo", () => {
    const result = runWorkflow(
      `✖ [error] NO_ADMIN: No hay ninguna cuenta administradora.\nResumen: 1 error(es), 0 aviso(s), 6 informativo(s).\nAUDITORÍA: NO_ADMIN · ESQUEMA: OK · ÍNDICES: OK\n`,
      1,
    );

    expect(result.status).toBe("AUDITORÍA: NO_ADMIN · ESQUEMA: OK · ÍNDICES: OK");
    expect(result.exitCode).toBe(1);
    expect(result.stepSummary).not.toContain("AUDIT_BLOCKED");
  });

  it("fallo técnico: AUDIT_BLOCKED y nunca NO_ADMIN", () => {
    const result = runWorkflow(
      `✖ Faltan FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.\n\nAUDITORÍA: AUDIT_BLOCKED · ESQUEMA: NO COMPROBABLE · ÍNDICES: NO COMPROBABLE\n`,
      1,
    );

    expect(result.status).toContain("AUDIT_BLOCKED");
    expect(result.stepSummary).toContain("AUDIT_BLOCKED");
    expect(result.stepSummary).not.toContain("NO_ADMIN");
    expect(result.exitCode).toBe(1);
  });

  it("sin salida (por ejemplo, el proceso ni arranca): AUDIT_BLOCKED", () => {
    const result = runWorkflow("", 127);
    expect(result.status).toBe("AUDITORÍA: AUDIT_BLOCKED · ESQUEMA: NO COMPROBABLE · ÍNDICES: NO COMPROBABLE");
    expect(result.summary).toBe("");
    expect(result.exitCode).toBe(127);
    expect(result.stepSummary).toContain("AUDIT_BLOCKED");
  });

  it("línea de estado falsa antes de la real: gana la última", () => {
    const result = runWorkflow(
      `AUDITORÍA: ADMIN_COUNT 99 · ESQUEMA: OK · ÍNDICES: OK\n${REAL_STATUS}\n`,
      0,
    );
    expect(result.status).toBe(REAL_STATUS);
  });

  it("una línea de estado con datos personales se rechaza y el job queda bloqueado", () => {
    const result = runWorkflow(
      "AUDITORÍA: NO_ADMIN · ESQUEMA: OK · ÍNDICES: OK ana.garcia@example.com\nResumen: 0 error(es), 0 aviso(s), 1 informativo(s).\n",
      1,
    );

    expect(result.status).toBe("AUDITORÍA: AUDIT_BLOCKED · ESQUEMA: NO COMPROBABLE · ÍNDICES: NO COMPROBABLE");
    expect(result.stepSummary).not.toContain("ana.garcia@example.com");
    expect(result.summary).toBe("Resumen: 0 error(es), 0 aviso(s), 1 informativo(s).");
  });

  it("el resumen no admite un estado inventado con formato válido pero no emitido", () => {
    // El paso de resumen revalida: si le llega basura, publica AUDIT_BLOCKED.
    writeFileSync(join(dir, "summary-blocked.md"), "");
    const outputFile = join(dir, "gh-output-2.txt");
    writeFileSync(outputFile, "");

    execFileSync("bash", [join(dir, "summary.sh")], {
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: join(dir, "summary-blocked.md"),
        STATUS: "AUDITORÍA: ADMIN_COUNT 999 · ESQUEMA: OK · ÍNDICES: OK\n- línea inyectada",
        SUMMARY: "Resumen: 9 error(es), 9 aviso(s), 9 informativo(s).",
        CODE: "0",
      },
      stdio: "pipe",
    });

    const summary = readFileSync(join(dir, "summary-blocked.md"), "utf8");
    expect(summary).toContain("AUDIT_BLOCKED");
    expect(summary).not.toContain("ADMIN_COUNT 999");
    expect(summary).not.toContain("línea inyectada");
  });
});
