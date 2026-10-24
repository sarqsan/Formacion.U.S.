import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  describeAuditEvent,
  listActivity,
  type AuditReader,
} from "@/server/audit/activity";

/**
 * REGISTRO DE ACTIVIDAD
 * =====================
 *
 * Todo lo sensible escribía en `audits` y nadie lo leía. Ahora hay una pantalla,
 * y estas pruebas fijan lo que no puede salir mal en ella:
 *
 *   · solo administración, y comprobado **antes** de leer;
 *   · **lista blanca de campos**: aunque el documento tenga un `password` o un
 *     `token`, no se publica;
 *   · un tipo de evento desconocido se muestra como «otro evento», no rompe la
 *     pantalla ni se inventa un significado;
 *   · el orden es del más reciente al más antiguo, y los eventos sin fecha no se
 *     pierden: se van al final;
 *   · el tope de eventos es real (`limit` no puede pedir la colección entera).
 */

const ADMIN: Actor = { uid: "admin-1", role: "admin", status: "active" };
const LEARNER: Actor = { uid: "alumno-1", role: "learner", status: "active" };

function reader(events: Array<Record<string, unknown>>, calls?: { limit: number }[]): AuditReader {
  return {
    async listRecent(limit) {
      calls?.push({ limit });
      return events.slice(0, limit);
    },
  };
}

describe("qué se enseña de cada evento", () => {
  it("cuenta deshabilitada, con su motivo", () => {
    const entry = describeAuditEvent({
      type: "account_disabled",
      actorUid: "admin-1",
      targetUid: "uid-9",
      at: "2026-10-24T09:00:00.000Z",
      reason: "baja del servicio",
      claimsVersion: 3,
    });

    expect(entry.title).toBe("Cuenta deshabilitada");
    expect(entry.detail).toContain("uid-9");
    expect(entry.detail).toContain("baja del servicio");
    expect(entry.at).toBe("2026-10-24T09:00:00.000Z");
    expect(entry.actorUid).toBe("admin-1");
  });

  it("deshabilitar sin motivo no deja un «null» escrito", () => {
    const entry = describeAuditEvent({
      type: "account_disabled",
      actorUid: "admin-1",
      targetUid: "uid-9",
      at: "2026-10-24T09:00:00.000Z",
      reason: null,
    });
    expect(entry.detail).not.toContain("null");
    expect(entry.detail).not.toContain("Motivo");
  });

  it("contraseña restablecida por administración: dice que no se guarda", () => {
    const entry = describeAuditEvent({
      type: "password_reset_admin",
      actorUid: "admin-1",
      targetUid: "uid-9",
      at: "2026-10-24T09:00:00.000Z",
      source: "generated",
    });
    expect(entry.title).toContain("Contraseña restablecida");
    expect(entry.detail).toContain("no se guarda");
  });

  it("importación: resume cuántas cuentas y cuántas filas omitidas", () => {
    const entry = describeAuditEvent({
      type: "people_import",
      actorUid: "admin-1",
      at: "2026-10-24T09:00:00.000Z",
      createdUsernames: ["rol1.garcia", "rol2.perez", "rol1.lopez"],
      skippedRows: [7, 9],
    });
    expect(entry.detail).toContain("3 cuenta(s)");
    expect(entry.detail).toContain("2 fila(s)");
    expect(entry.detail).toContain("rol1.garcia");
  });

  it("alta individual: usuario y rol, pendiente de activación", () => {
    const entry = describeAuditEvent({
      type: "person_created",
      actorUid: "admin-1",
      at: "2026-10-24T09:00:00.000Z",
      uid: "uid-9",
      username: "rol1.garcia",
      personRol: "ROL 1",
    });
    expect(entry.detail).toContain("rol1.garcia");
    expect(entry.detail).toContain("ROL 1");
    expect(entry.detail).toContain("pendiente de activación");
  });

  it("reemisión de código: no enseña el código", () => {
    const entry = describeAuditEvent({
      type: "activation_reissued",
      actorUid: "admin-1",
      targetUid: "uid-9",
      at: "2026-10-24T09:00:00.000Z",
      expiresAt: "2026-10-27T09:00:00.000Z",
      revokedPrevious: 2,
      // Si alguien guardara el token por error, no debe salir:
      token: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abc",
    });
    expect(entry.detail).toContain("2 anterior");
    expect(entry.detail).toContain("2026-10-27");
    expect(JSON.stringify(entry)).not.toContain("AbCdEfGh");
  });

  it("un tipo desconocido no rompe nada ni se inventa el significado", () => {
    const entry = describeAuditEvent({
      type: "evento_del_futuro",
      actorUid: "admin-1",
      at: "2026-10-24T09:00:00.000Z",
    });
    expect(entry.title).toBe("Otro evento");
    expect(entry.detail).toContain("evento_del_futuro");
    expect(entry.at).toBe("2026-10-24T09:00:00.000Z");
  });

  it("un documento sin tipo ni fecha no lanza", () => {
    const entry = describeAuditEvent({});
    expect(entry.type).toBe("unknown");
    expect(entry.at).toBeNull();
    expect(entry.detail).toContain("unknown");
  });

  it("nunca devuelve los campos que no están en la lista blanca", () => {
    const entry = describeAuditEvent({
      type: "password_changed",
      actorUid: "uid-1",
      at: "2026-10-24T09:00:00.000Z",
      password: "ClaveSecretisima2026",
      newPassword: "OtraClave2026",
      currentPassword: "ClaveActual2025",
      claims: { role: "admin" },
      email: "persona@ejemplo.com",
    });

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("ClaveSecretisima2026");
    expect(serialized).not.toContain("OtraClave2026");
    expect(serialized).not.toContain("ClaveActual2025");
    expect(serialized).not.toContain("persona@ejemplo.com");
    expect(Object.keys(entry).sort()).toEqual(
      ["actorUid", "at", "detail", "id", "severity", "targetUid", "title", "type"].sort(),
    );
  });
});

describe("quién puede ver el registro", () => {
  it("un alumno no puede leerlo, ni siquiera para contar eventos", async () => {
    let read = false;
    const audit: AuditReader = {
      async listRecent() {
        read = true;
        return [];
      },
    };

    await expect(listActivity(LEARNER, { audit })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    expect(read).toBe(false);
  });

  it("un administrador recibe los eventos ordenados del más reciente al más antiguo", async () => {
    const events = [
      { id: "a", type: "account_enabled", at: "2026-10-20T09:00:00.000Z" },
      { id: "b", type: "account_disabled", at: "2026-10-24T09:00:00.000Z" },
      { id: "c", type: "person_created", at: "2026-10-22T09:00:00.000Z" },
    ];

    const entries = await listActivity(ADMIN, { audit: reader(events) });
    expect(entries.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("un evento sin fecha no se descarta: se queda al final", async () => {
    const events = [
      { id: "sin-fecha", type: "unknown" },
      { id: "con-fecha", type: "account_enabled", at: "2026-10-24T09:00:00.000Z" },
    ];

    const entries = await listActivity(ADMIN, { audit: reader(events) });
    expect(entries.map((entry) => entry.id)).toEqual(["con-fecha", "sin-fecha"]);
    expect(entries[1]?.at).toBeNull();
  });
});

describe("cuántos eventos se piden", () => {
  it("por defecto, un tope acotado", async () => {
    const calls: Array<{ limit: number }> = [];
    await listActivity(ADMIN, { audit: reader([], calls) });
    expect(calls[0]?.limit).toBe(ACTIVITY_DEFAULT_LIMIT);
  });

  it("no se puede pedir más del máximo", async () => {
    const calls: Array<{ limit: number }> = [];
    await listActivity(ADMIN, { audit: reader([], calls) }, { limit: 10_000 });
    expect(calls[0]?.limit).toBe(ACTIVITY_MAX_LIMIT);
  });

  it("un límite absurdo se rechaza antes de leer", async () => {
    let read = false;
    const audit: AuditReader = {
      async listRecent() {
        read = true;
        return [];
      },
    };

    await expect(listActivity(ADMIN, { audit }, { limit: 0 })).rejects.toMatchObject({
      code: "ACTIVITY_LIMIT_INVALID",
      status: 400,
    });
    expect(read).toBe(false);
  });
});
