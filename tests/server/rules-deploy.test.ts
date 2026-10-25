import { describe, expect, it } from "vitest";
import {
  classifyRulesTestExit,
  decideRulesDeploy,
  EXPECTED_RULES_PROJECT,
} from "../../scripts/lib/rules-deploy-core.mjs";

/**
 * PUBLICAR REGLAS: LA DECISIÓN
 * ============================
 *
 * La política del proyecto es que **no se publican reglas sin probarlas**. Hasta
 * ahora eso era una frase en la documentación: `firebase deploy` a mano publica
 * igual aunque las 57 pruebas estén BLOCKED, es decir, aunque no se haya probado
 * nada.
 *
 * Estas pruebas fijan la matriz de decisión del script que lo impide. Lo que no
 * demuestran: que Firestore acepte las reglas después (eso es `npm run
 * test:rules` con emulador, todavía BLOCKED en este entorno).
 */

const base = {
  testExitCode: 0,
  projectId: EXPECTED_RULES_PROJECT,
  confirm: true,
  dryRun: false,
};

describe("publicar reglas: se permite", () => {
  it("con pruebas PASSED, --yes y el proyecto esperado", () => {
    const decision = decideRulesDeploy(base);
    expect(decision.allowed).toBe(true);
    expect(decision.exitCode).toBe(0);
    expect(decision.blockers).toEqual([]);
    expect(decision.steps.join(" ")).toContain("PASSED");
  });

  it("en simulación no hace falta --yes ni resultado de pruebas, y no publica", () => {
    const decision = decideRulesDeploy({
      testExitCode: null,
      projectId: EXPECTED_RULES_PROJECT,
      confirm: false,
      dryRun: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.steps.join(" ")).toContain("No se ejecuta ni se publica nada");
    expect(decision.steps.join(" ")).not.toContain("Se publicará");
  });

  it("en simulación sigue avisando si el proyecto no es el esperado", () => {
    const decision = decideRulesDeploy({
      testExitCode: null,
      projectId: "otro",
      confirm: false,
      dryRun: true,
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("publicar reglas: se niega", () => {
  it("sin --yes no se publica, aunque todo lo demás esté bien", () => {
    const decision = decideRulesDeploy({ ...base, confirm: false });
    expect(decision.allowed).toBe(false);
    expect(decision.exitCode).toBe(3);
    expect(decision.blockers.join(" ")).toContain("--yes");
  });

  it("con las pruebas BLOCKED (sin emulador) no se publica nada", () => {
    const decision = decideRulesDeploy({ ...base, testExitCode: 2 });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("BLOCKED");
    expect(decision.blockers.join(" ")).toContain("no se ha probado nada");
  });

  it("con las pruebas en rojo no se publica nada", () => {
    const decision = decideRulesDeploy({ ...base, testExitCode: 1 });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("han fallado");
  });

  it("sin resultado de pruebas no se publica nada", () => {
    expect(decideRulesDeploy({ ...base, testExitCode: null }).allowed).toBe(false);
    // `undefined` es el caso real de «no se ha llegado a ejecutar».
    expect(
      decideRulesDeploy({ ...base, testExitCode: undefined as unknown as null }).allowed,
    ).toBe(false);
  });

  it("sin proyecto no se sabe dónde publicar", () => {
    const decision = decideRulesDeploy({ ...base, projectId: "" });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("FIREBASE_PROJECT_ID");
  });

  it("en un proyecto distinto al esperado no se publica", () => {
    const decision = decideRulesDeploy({ ...base, projectId: "otro-proyecto" });
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("otro-proyecto");
  });

  it("acumula todos los motivos en vez de parar en el primero", () => {
    const decision = decideRulesDeploy({
      testExitCode: 2,
      projectId: "",
      confirm: false,
      dryRun: false,
    });
    expect(decision.blockers).toHaveLength(3);
  });
});

describe("traducción del código de salida de las pruebas", () => {
  it("distingue PASSED, BLOCKED, FAILED y no ejecutado", () => {
    expect(classifyRulesTestExit(0)).toBe("PASSED");
    expect(classifyRulesTestExit(2)).toBe("BLOCKED");
    expect(classifyRulesTestExit(1)).toBe("FAILED");
    expect(classifyRulesTestExit(7)).toBe("FAILED");
    expect(classifyRulesTestExit(null)).toBe("NOT_RUN");
  });
});
