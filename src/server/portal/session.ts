import { DomainError } from "@/domain/text";
import type { Actor } from "@/domain/auth/authorization";
import { getDemoActor, isDemoMode } from "@/demo/session";

/**
 * SESIÓN DE LOS ENDPOINTS DE ADMINISTRACIÓN
 * ========================================
 *
 * Los endpoints existen para el panel de administración y tienen que funcionar
 * con los mismos datos que la interfaz: en modo real, con la cookie de sesión de
 * Firebase; en la demostración, con la cookie de la demo.
 *
 * `requireActor()` (que solo entiende de Firebase) se usa tal cual en modo real:
 * verifica la cookie de sesión contra Firebase Auth y lee la ficha de la cuenta.
 * En la demostración se resuelve el actor de la demo, sin tocar Firebase ni
 * exigir configuración de proyecto.
 *
 * La autorización **no** se decide aquí: estas funciones solo dicen quién eres.
 * El rol se comprueba en el servicio (`assertAdmin`), dentro del mismo camino que
 * ya usan las acciones de servidor.
 */
export async function requirePortalActor(): Promise<Actor> {
  if (isDemoMode()) {
    const actor = await getDemoActor();
    if (!actor) {
      throw new DomainError("UNAUTHENTICATED", "Debes iniciar sesión.", 401);
    }
    return actor;
  }

  // Import dinámico: en la demostración no se carga el módulo de Firebase.
  const { requireActor } = await import("@/server/auth/session");
  return requireActor();
}
