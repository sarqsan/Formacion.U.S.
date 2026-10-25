import { jsonOk } from "@/server/http";
import { getServerConfig } from "@/server/config";
import { assessFirebaseReadiness } from "@/server/firebase/readiness";
import { decideDemoMode } from "@/server/config/demo-gate";
import { geminiStatus } from "@/server/ai/status";

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

  // `demo` dice si el modo demostración está **en uso**, no si está pedido: en
  // producción el candado lo niega aunque alguien deje DEMO_MODE=1 puesto. Es la
  // forma de comprobarlo desde fuera, sin acceso a las variables del despliegue.
  const demo = decideDemoMode(process.env);

  // Gemini: si está configurado, qué modelo y si la cuenta responde. Nunca la
  // clave. La comprobación se cachea unos minutos, así que esto no golpea la
  // API externa en cada visita.
  const gemini = await geminiStatus();

  const ai = {
    provider: gemini.provider,
    providerLabel: gemini.providerLabel,
    configured: gemini.configured,
    model: gemini.model,
    reachable: gemini.reachable,
    modelAvailable: gemini.modelAvailable,
    checkedAt: gemini.checkedAt,
    message: gemini.message,
  };

  return jsonOk({
    ok: true,
    app: "formacion-us",
    configured,
    ready,
    mode,
    demo: demo.enabled,
    ai,
    // Mismo contenido con el nombre histórico: alguna herramienta externa ya
    // lee `gemini` y no cuesta nada mantenerlo.
    gemini: ai,
    time: new Date().toISOString(),
  });
}
