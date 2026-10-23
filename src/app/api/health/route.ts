import { jsonOk } from "@/server/http";
import { getServerConfig } from "@/server/config";
import { assessFirebaseReadiness } from "@/server/firebase/readiness";

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

  // `ready` responde a «¿está todo rellenado?», no a «¿funciona la conexión?»:
  // eso último exige red y lo responde `npm run check:firebase`. No se exponen
  // nombres de variables ni valores: solo un booleano.
  let ready = false;
  try {
    ready = assessFirebaseReadiness(process.env).ready;
  } catch {
    ready = false;
  }

  return jsonOk({
    ok: true,
    app: "formacion-us",
    configured,
    ready,
    mode,
    time: new Date().toISOString(),
  });
}
