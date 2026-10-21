import { jsonOk } from "@/server/http";
import { getServerConfig } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Comprobación de vida. Nunca expone credenciales ni detalles internos:
 * solo si la aplicación está configurada para hablar con Firebase.
 */
export async function GET() {
  let configured = true;
  let mode: "emulator" | "firebase" | "unconfigured" = "unconfigured";

  try {
    const config = getServerConfig();
    mode = config.usingEmulator ? "emulator" : "firebase";
    configured = true;
  } catch {
    configured = false;
  }

  return jsonOk({
    ok: true,
    app: "formacion-us",
    configured,
    mode,
    time: new Date().toISOString(),
  });
}
