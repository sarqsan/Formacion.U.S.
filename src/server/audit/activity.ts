import { DomainError } from "@/domain/text";
import { assertAdmin, type Actor } from "@/domain/auth/authorization";

/**
 * REGISTRO DE ACTIVIDAD (lectura)
 * ===============================
 *
 * Cada operación sensible ya escribía en `audits`: deshabilitar cuentas,
 * reemitir códigos, importar personas, restablecer contraseñas… Pero **nadie
 * podía leerlo**: se escribía para cumplir y se quedaba ahí. Dicho de otro modo,
 * la frase «queda en la auditoría» que aparece en media docena de pantallas no
 * tenía comprobación posible.
 *
 * Esto abre esa puerta, con dos decisiones que importan:
 *
 *   · **Lista blanca de campos.** No se devuelve el documento tal cual: se
 *     construye una vista con los campos conocidos y nada más. Si mañana alguien
 *     guarda por error un dato de más en un evento, no se publica solo por estar
 *     en la base. Hay una prueba que mete un `password` y un `token` en un evento
 *     y comprueba que no salen.
 *   · **Un tipo desconocido no rompe la pantalla.** Un evento de una versión
 *     futura se muestra como «otro evento», con su fecha y su autor. La página
 *     no se cae por un dato que aún no existe.
 */

/** Lo que la pantalla necesita de un evento, ya sin nada sensible. */
export interface ActivityEntry {
  /** Identificador del evento en el almacén, si lo tiene. */
  id: string | null;
  type: string;
  at: string | null;
  /** Quién lo hizo (uid). No se resuelve a nombre aquí: lo hace la pantalla. */
  actorUid: string | null;
  /** Sobre quién, si el evento afecta a una cuenta. */
  targetUid: string | null;
  /** Título corto para la tabla. */
  title: string;
  /** Detalle legible; nunca contiene secretos. */
  detail: string;
  /** Gravedad declarada al escribir, si la hay. */
  severity: string | null;
}

/** Puerto de lectura: el almacén solo tiene que devolver los más recientes. */
export interface AuditReader {
  listRecent(limit: number): Promise<Array<Record<string, unknown>>>;
}

export interface ActivityDependencies {
  audit: AuditReader;
}

/** Tope: la pantalla enseña lo reciente, no la historia completa. */
export const ACTIVITY_DEFAULT_LIMIT = 100;
export const ACTIVITY_MAX_LIMIT = 500;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean === "" ? null : clean;
}

function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Un sufijo con la cuenta afectada, para no repetir el mismo texto en cada caso. */
function aboutUser(targetUid: string | null): string {
  return targetUid ? ` sobre ${targetUid}` : "";
}

/**
 * Traduce un evento del almacén a la vista de la pantalla.
 *
 * Función pura: no lee nada, no ordena, no filtra. Así se puede probar el
 * catálogo entero de eventos sin base de datos.
 */
export function describeAuditEvent(raw: Record<string, unknown>): ActivityEntry {
  const type = text(raw.type) ?? "unknown";
  const at = isoDate(raw.at) ?? isoDate(raw.recordedAt);
  const actorUid = text(raw.actorUid);
  const targetUid = text(raw.targetUid);
  const id = text(raw.id);
  const severity = text(raw.severity);

  const base = { id, type, at, actorUid, targetUid, severity };

  switch (type) {
    case "account_disabled": {
      const reason = text(raw.reason);
      return {
        ...base,
        title: "Cuenta deshabilitada",
        detail: `Se cerró el acceso de la cuenta${aboutUser(targetUid)}${
          reason ? `. Motivo: ${reason}` : ""
        }.`,
      };
    }

    case "account_enabled":
      return {
        ...base,
        title: "Cuenta reactivada",
        detail: `Se devolvió el acceso a la cuenta${aboutUser(targetUid)}. Tendrá que entrar de nuevo.`,
      };

    case "activation_reissued": {
      const revoked = typeof raw.revokedPrevious === "number" ? raw.revokedPrevious : null;
      const expiresAt = isoDate(raw.expiresAt);
      return {
        ...base,
        title: "Código de activación reemitido",
        detail:
          `Se emitió un código nuevo${aboutUser(targetUid)}` +
          (revoked !== null ? ` y se anularon ${revoked} anterior(es)` : "") +
          (expiresAt ? `. Caduca el ${expiresAt.slice(0, 10)}.` : "."),
      };
    }

    case "password_reset_admin":
      return {
        ...base,
        title: "Contraseña restablecida por administración",
        detail: `Se generó una contraseña temporal${aboutUser(targetUid)} y se cerraron sus sesiones. La contraseña no se guarda.`,
      };

    case "certificate_issued": {
      const courseTitle = text(raw.courseTitle) ?? text(raw.courseId) ?? "un curso";
      const version = typeof raw.version === "number" ? raw.version : null;
      return {
        ...base,
        title: "Certificado emitido",
        detail:
          `Se emitió el certificado de «${courseTitle}»` +
          (version !== null ? ` (versión ${version})` : "") +
          `${aboutUser(targetUid)}. La emisión es idempotente: pedirlo otra vez no crea otro.`,
      };
    }

    case "password_changed":
      return {
        ...base,
        title: "Contraseña cambiada por la propia persona",
        detail: "La persona cambió su contraseña desde «Mi cuenta»; sus sesiones se cerraron.",
      };

    case "people_import": {
      const usernames = Array.isArray(raw.createdUsernames)
        ? raw.createdUsernames.filter((item): item is string => typeof item === "string")
        : [];
      const skipped = Array.isArray(raw.skippedRows) ? raw.skippedRows.length : 0;
      return {
        ...base,
        title: "Importación de personas",
        detail:
          `${usernames.length} cuenta(s) creada(s)` +
          (skipped > 0 ? ` · ${skipped} fila(s) omitida(s) como duplicadas` : "") +
          (usernames.length > 0 ? `: ${usernames.slice(0, 5).join(", ")}` : "") +
          (usernames.length > 5 ? "…" : ""),
      };
    }

    case "person_created":
      return {
        ...base,
        title: "Alta de una persona",
        detail: `Se creó la cuenta «${text(raw.username) ?? "—"}» (${text(raw.personRol) ?? "rol sin indicar"}) pendiente de activación.`,
      };

    default:
      // Tipo no reconocido: se dice, no se inventa ni se cae.
      return {
        ...base,
        title: "Otro evento",
        detail: `Tipo de evento no reconocido por esta versión: «${type}».`,
      };
  }
}

/**
 * Últimos eventos, del más reciente al más antiguo.
 *
 * `assertAdmin` va **antes de leer**: un alumno no debe poder ver ni siquiera
 * cuántos eventos hay.
 */
export async function listActivity(
  actor: Actor,
  deps: ActivityDependencies,
  options: { limit?: number } = {},
): Promise<ActivityEntry[]> {
  assertAdmin(actor);

  const requested = options.limit ?? ACTIVITY_DEFAULT_LIMIT;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new DomainError("ACTIVITY_LIMIT_INVALID", "El número de eventos no es válido.", 400);
  }
  const limit = Math.min(Math.floor(requested), ACTIVITY_MAX_LIMIT);

  const raw = await deps.audit.listRecent(limit);

  return raw
    .map(describeAuditEvent)
    .sort((a, b) => {
      // Los que no tienen fecha, al final: no se descartan, se muestran.
      if (a.at === null && b.at === null) return 0;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return b.at.localeCompare(a.at);
    });
}
