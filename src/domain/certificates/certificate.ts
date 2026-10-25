import { createHash } from "node:crypto";
import { DomainError } from "@/domain/text";

/**
 * CERTIFICADOS
 * ============
 *
 * Decisiones tomadas aquí, y por qué:
 *
 *   · **El código se deriva del contenido.** `sha256(uid | curso | versión)`
 *     recortado a 20 caracteres hexadecimales. Así la emisión es **idempotente
 *     sin necesidad de buscar**: pedir dos veces el mismo certificado devuelve el
 *     mismo documento, no un duplicado, y no hace falta un índice nuevo ni una
 *     transacción entre colecciones. Además el código no se puede adivinar sin
 *     conocer el identificador interno de la cuenta (que no es público).
 *   · **El certificado es un hecho, no una plantilla.** Guarda el título del
 *     curso y la versión en el momento de emitirlo: si el curso se republica, el
 *     certificado sigue diciendo lo que se cursó, no lo que hay ahora.
 *   · **La verificación no revela a quién pertenece.** La página pública enseña
 *     curso, versión, fecha y un nombre **enmascarado**; el nombre completo y el
 *     PDF exigen sesión. Un código filtrado no se convierte en un listado de
 *     personas.
 */

/**
 * Alfabeto del código: hexadecimal en minúsculas. Sin saltos de línea ni
 * caracteres que se confundan al dictarlos (no hay `0`/`O` ni `1`/`l` que
 * distinguir, porque no se usan letras fuera de a-f).
 */
export const CERTIFICATE_CODE_LENGTH = 20;

/** Campos que identifican de forma única lo que se certifica. */
export interface CertificateIdentity {
  uid: string;
  courseId: string;
  version: number;
}

/**
 * Código determinista del certificado.
 *
 * Incluye un prefijo de versión (`formacion-us/cert/v1`) para que un cambio de
 * formato en el futuro no colisione con los códigos ya emitidos.
 */
export function certificateCode(identity: CertificateIdentity): string {
  const { uid, courseId, version } = identity;
  if (!uid || !courseId || !Number.isInteger(version) || version <= 0) {
    throw new DomainError(
      "CERTIFICATE_IDENTITY_INVALID",
      "No se puede identificar el certificado: falta la cuenta, el curso o la versión.",
      400,
    );
  }

  return createHash("sha256")
    .update(`formacion-us/cert/v1|${uid}|${courseId}|${version}`, "utf8")
    .digest("hex")
    .slice(0, CERTIFICATE_CODE_LENGTH);
}

/** ¿Tiene forma de código? (se usa antes de ir a la base de datos). */
export function isCertificateCode(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{20}$/.test(value);
}

/**
 * Enmascara un nombre para la página pública.
 *
 * «García López, María» → «G***** L*****, M****». Se conservan la primera letra
 * de cada palabra y la puntuación; el resto se tapa con asteriscos, uno por
 * letra. Basta para que quien verifica reconozca el documento, y no permite
 * reconstruir el nombre desde un código filtrado.
 */
export function maskName(displayName: string): string {
  const clean = displayName.trim();
  if (!clean) return "—";

  return clean
    .split(/\s+/)
    .map((word) => {
      let seenLetter = false;
      return [...word]
        .map((character) => {
          // La puntuación se conserva: sin la coma, «López, María» parece una
          // errata y el nombre deja de ser reconocible.
          if (!/\p{L}/u.test(character)) return character;
          if (!seenLetter) {
            seenLetter = true;
            return character;
          }
          return "*";
        })
        .join("");
    })
    .join(" ");
}

/** Datos del certificado tal y como se guardan y se muestran. */
export interface CertificateRecord {
  /** Código determinista; es también el id del documento. */
  code: string;
  uid: string;
  username: string;
  /** Nombre completo en la ficha de la persona (nunca se publica entero). */
  displayName: string;
  courseId: string;
  courseTitle: string;
  version: number;
  /** Cuándo completó el curso (dato del progreso, no de la emisión). */
  completedAt: string;
  /** Cuándo se emitió el documento. */
  issuedAt: string;
  /** Uid de quien lo pidió, o `"system"` si se emitió al completar. */
  issuedBy: string;
}

/**
 * Comprobaciones mínimas de forma antes de escribir.
 *
 * No se valida el contenido del curso (eso lo hace el servicio con los datos
 * reales): esto solo impide guardar un documento con huecos.
 */
export function assertCertificateComplete(record: CertificateRecord): void {
  const missing = (
    ["code", "uid", "username", "displayName", "courseId", "courseTitle"] as const
  ).filter((field) => !record[field] || String(record[field]).trim() === "");

  if (missing.length > 0) {
    throw new DomainError(
      "CERTIFICATE_INCOMPLETE",
      "El certificado no se puede emitir: faltan datos de la persona o del curso.",
      400,
      { missing },
    );
  }
  if (!isCertificateCode(record.code)) {
    throw new DomainError("CERTIFICATE_CODE_INVALID", "El código del certificado no es válido.", 400);
  }
  if (!Number.isInteger(record.version) || record.version <= 0) {
    throw new DomainError("CERTIFICATE_VERSION_INVALID", "La versión del curso no es válida.", 400);
  }

  for (const field of ["completedAt", "issuedAt"] as const) {
    const date = new Date(record[field]);
    if (Number.isNaN(date.getTime())) {
      throw new DomainError(
        "CERTIFICATE_DATE_INVALID",
        "El certificado tiene una fecha que no se puede leer.",
        400,
        { field },
      );
    }
  }
}

/** Fecha larga en castellano, sin depender de la zona del navegador. */
export function formatCertificateDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Texto del certificado. Está aquí, y no en la plantilla PDF, para poder
 * comprobarlo y para que el PDF y la pantalla digan exactamente lo mismo.
 */
export interface CertificateText {
  heading: string;
  title: string;
  holder: string;
  body: string;
  footer: string;
  verification: string;
}

export function certificateText(
  record: CertificateRecord,
  options: { verifyUrl: string },
): CertificateText {
  return {
    heading: "Formación U.G.–U.S.",
    title: "Certificado de aprovechamiento",
    holder: record.displayName,
    body:
      `ha completado el curso «${record.courseTitle}» (versión ${record.version}), ` +
      `superando todos los temas obligatorios y el examen final, ` +
      `con fecha de finalización ${formatCertificateDate(record.completedAt)}.`,
    footer:
      "Documento emitido automáticamente por la aplicación de formación de la U.G.–U.S. " +
      "No lleva firma manuscrita: su autenticidad se comprueba con el código de verificación.",
    verification: `Código ${record.code} · ${options.verifyUrl}`,
  };
}
