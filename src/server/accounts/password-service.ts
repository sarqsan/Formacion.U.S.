import { DomainError } from "@/domain/text";
import { assertActiveAccount, type Actor } from "@/domain/auth/authorization";
import { assertPasswordAcceptable } from "@/domain/auth/activation";
import type { CredentialService } from "@/server/auth/activation-service";

/**
 * CAMBIO DE CONTRASEÑA POR EL PROPIO USUARIO
 * ==========================================
 *
 * Hasta ahora una contraseña solo se podía fijar por dos caminos: activarse la
 * primera vez, o que un administrador ejecutara el script de terminal. Quien
 * estaba dentro y quería cambiar la suya no podía, y una cuenta activada por
 * otra persona conservaba la contraseña ajena indefinidamente.
 *
 * Decisiones que importan:
 *
 *   · **Se exige la contraseña actual.** Sin esto, una sesión robada serviría
 *     para apropiarse de la cuenta para siempre. La comprobación se hace en el
 *     servidor, no en el navegador.
 *   · **La contraseña nueva no puede ser la actual**, y cumple la misma
 *     política que `/activar`: una sola definición, no dos que se desvíen.
 *   · **La nueva contraseña no se registra** en auditoría ni se devuelve.
 *   · **Cerrar todas las sesiones.** Al terminar se revocan los refresh tokens
 *     y se invalida la cookie propia: si alguien más estaba dentro con esa
 *     cuenta, deja de estarlo en la siguiente petición. El usuario vuelve a
 *     entrar con la contraseña nueva.
 *   · **Quien escribe es quien cambia.** No hay parámetro de «a quién»: el uid
 *     sale del actor autenticado, nunca del cuerpo de la petición.
 */

/** Solo lo que el servicio necesita; el almacén real cumple de sobra. */
export interface PasswordStore {
  getAccount(uid: string): Promise<{ username: string; status: string } | null>;
}

export interface PasswordAudit {
  record(event: {
    type: "password_changed";
    actorUid: string;
    at: string;
  }): Promise<void>;
}

export interface PasswordChangeDependencies {
  store: PasswordStore;
  credentials: CredentialService;
  /** Comprueba la contraseña actual contra Firebase Auth. */
  verifyPassword: (email: string, password: string) => Promise<boolean>;
  audit: PasswordAudit;
  authEmailDomain: string;
  now?: () => Date;
}

export interface PasswordChangeInput {
  // Opcionales porque llegan de un cuerpo JSON: el servicio valida su presencia
  // y su tipo, no confía en que el cliente los mande.
  currentPassword?: unknown;
  newPassword?: unknown;
  newPasswordRepeat?: unknown;
}

export interface PasswordChangeResult {
  username: string;
  changedAt: string;
}

function asPassword(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DomainError("PASSWORD_REQUIRED", `Falta ${label}.`, 400);
  }
  return value;
}

export async function changeOwnPassword(
  actor: Actor | null,
  input: PasswordChangeInput,
  deps: PasswordChangeDependencies,
): Promise<PasswordChangeResult> {
  const current = assertActiveAccount(actor);

  const account = await deps.store.getAccount(current.uid);
  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND", "No se ha encontrado la cuenta.", 404);
  }
  if (account.status !== "active") {
    throw new DomainError("ACCOUNT_NOT_ACTIVE", "La cuenta no está activa.", 403);
  }

  const currentPassword = asPassword(input.currentPassword, "la contraseña actual");
  const newPassword = asPassword(input.newPassword, "la contraseña nueva");
  const repeat = asPassword(input.newPasswordRepeat, "la repetición de la contraseña nueva");

  if (newPassword !== repeat) {
    throw new DomainError("PASSWORD_MISMATCH", "Las dos contraseñas nuevas no coinciden.", 400);
  }

  // Misma política que la activación, y sin reutilizar contraseñas anteriores
  // conocidas por el servicio: la actual no puede repetirse.
  assertPasswordAcceptable(newPassword, {
    username: account.username,
    previousPasswords: [currentPassword],
  });

  const matches = await deps.verifyPassword(
    `${account.username.toLowerCase()}@${deps.authEmailDomain}`,
    currentPassword,
  );
  if (!matches) {
    throw new DomainError("PASSWORD_INCORRECT", "La contraseña actual no es correcta.", 401);
  }

  await deps.credentials.setPassword(current.uid, newPassword);
  // Cierra las demás sesiones; la propia la invalida la ruta al borrar la cookie.
  await deps.credentials.revokeRefreshTokens(current.uid);

  const at = (deps.now ?? (() => new Date()))().toISOString();
  await deps.audit.record({ type: "password_changed", actorUid: current.uid, at });

  return { username: account.username, changedAt: at };
}
