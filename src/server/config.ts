import { z } from "zod";
import { DomainError } from "@/domain/text";

/**
 * CONFIGURACIÓN DEL SERVIDOR
 * ==========================
 *
 * Todo se lee de variables de entorno y NADA se define por defecto con valor
 * usable en producción. Si falta configuración, el sistema falla cerrado con
 * un 503 explícito en lugar de arrancar a medias.
 *
 * No hay ningún secreto en el repositorio: `.env.example` solo documenta
 * nombres y `.env*` está ignorado por git.
 */

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== "" ? value.trim() : undefined));

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: optionalNonEmpty,
  FIREBASE_PRIVATE_KEY: optionalNonEmpty,

  FIREBASE_AUTH_EMULATOR_HOST: optionalNonEmpty,
  FIRESTORE_EMULATOR_HOST: optionalNonEmpty,

  /** Dominio interno de los correos sintéticos de Firebase Auth. */
  AUTH_EMAIL_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Dominio de correo interno no válido")
    .default("formacion.invalid"),

  SESSION_COOKIE_NAME: z.string().min(3).default("formacion_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 14).default(12),

  /** Origen público de la app, para comprobar el origen de las peticiones. */
  APP_ORIGIN: optionalNonEmpty,

  /**
   * Presupuesto de almacenamiento para PDF, en MiB. Se acota en
   * `budgetBytesFromMiB` al máximo seguro de la cuota gratuita. No hay
   * Storage: los PDF viven fragmentados en Firestore.
   */
  PDF_STORAGE_BUDGET_MB: z.coerce.number().int().min(1).optional(),
});

export type ServerConfig = z.infer<typeof serverEnvSchema> & {
  usingEmulator: boolean;
};

let cached: ServerConfig | null = null;

/**
 * Origen público configurado (`APP_ORIGIN`), **sin** exigir el resto de la
 * configuración.
 *
 * Hace falta en los endpoints que también funcionan en la demostración: allí no
 * hay Firebase ni credenciales, así que `getServerConfig()` fallaría con un 503
 * por motivos que no tienen nada que ver con la petición. La comprobación de
 * origen sigue siendo la misma (`assertTrustedOrigin`), y en modo real el resto
 * del camino (`requireActor`) vuelve a exigir la configuración completa, incluido
 * el endurecimiento de producción (APP_ORIGIN obligatorio y https).
 */
export function configuredAppOrigin(env: ServerEnvInput = process.env): string | undefined {
  const value = env.APP_ORIGIN?.trim();
  return value ? value : undefined;
}

export type ServerEnvInput = Record<string, string | undefined>;

export function getServerConfig(env: ServerEnvInput = process.env): ServerConfig {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new DomainError(
      "SERVER_NOT_CONFIGURED",
      `Configuración del servidor incompleta (${missing}). Revisa .env.example.`,
      503,
    );
  }

  const config = parsed.data;

  if (!config.FIREBASE_AUTH_EMULATOR_HOST) {
    if (!config.FIREBASE_CLIENT_EMAIL || !config.FIREBASE_PRIVATE_KEY) {
      throw new DomainError(
        "SERVER_NOT_CONFIGURED",
        "Faltan credenciales de Firebase Admin (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).",
        503,
      );
    }
  }

  const usingEmulator = Boolean(
    config.FIREBASE_AUTH_EMULATOR_HOST || config.FIRESTORE_EMULATOR_HOST,
  );

  if (config.NODE_ENV === "production" && usingEmulator) {
    throw new DomainError(
      "SERVER_CONFIG_UNSAFE",
      "No se pueden usar emuladores en producción.",
      503,
    );
  }

  if (config.NODE_ENV === "production") {
    assertProductionHardening(config);
  }

  cached = { ...config, usingEmulator };
  return cached;
}

/**
 * Endurecimiento obligatorio en producción.
 *
 * Son dos requisitos que, si faltan, degradan la seguridad sin que se note:
 *
 *   · `APP_ORIGIN`: sin él, la comprobación de origen (CSRF) solo puede
 *     apoyarse en la cabecera `Host`. Con proxy de por medio, fijarlo es la
 *     única forma de saber cuál es el dominio legítimo.
 *   · prefijo `__Host-` en la cookie de sesión: impide que un subdominio
 *     (o un atacante con control de un subdominio) sobrescriba la cookie
 *     aprovechando que las cookies no distinguen puertos ni subdominios.
 *
 * Se falla cerrado: es preferible no arrancar a arrancar sin estas garantías.
 */
function assertProductionHardening(config: z.infer<typeof serverEnvSchema>): void {
  if (!config.APP_ORIGIN) {
    throw new DomainError(
      "SERVER_CONFIG_UNSAFE",
      "Falta APP_ORIGIN: en producción es obligatorio para validar el origen de las peticiones que escriben.",
      503,
    );
  }

  let origin: URL;
  try {
    origin = new URL(config.APP_ORIGIN);
  } catch {
    throw new DomainError(
      "SERVER_CONFIG_UNSAFE",
      "APP_ORIGIN no es una URL válida (ejemplo: https://formacion.example).",
      503,
    );
  }

  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !isLocal) {
    throw new DomainError(
      "SERVER_CONFIG_UNSAFE",
      "APP_ORIGIN debe usar https fuera de local.",
      503,
    );
  }

  if (!config.SESSION_COOKIE_NAME.startsWith("__Host-")) {
    throw new DomainError(
      "SERVER_CONFIG_UNSAFE",
      "En producción SESSION_COOKIE_NAME debe empezar por __Host- (por ejemplo __Host-formacion_session) y la cookie se emite con Secure.",
      503,
    );
  }
}

/** Solo para pruebas. */
export function resetServerConfigCache(): void {
  cached = null;
}

/**
 * La clave privada llega como una sola línea con `\n` escapados en la mayoría
 * de plataformas. Se normaliza aquí y NUNCA se registra en logs.
 */
export function normalizePrivateKey(privateKey: string): string {
  return privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
}
