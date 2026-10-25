import { certificatePdf } from "@/server/certificates/pdf";
import { certificateText, type CertificateRecord } from "@/domain/certificates/certificate";

/**
 * PDF DEL CERTIFICADO
 * ===================
 *
 * Aquí se juntan las dos mitades: el **texto** (que vive en el dominio y se
 * puede probar sin generar bytes) y la **maquetación** (`pdf.ts`, A4 sin
 * dependencias). La pantalla y el PDF dicen exactamente lo mismo, porque salen
 * de la misma función.
 *
 * El enlace de verificación se construye con el origen de la petición, no con
 * una constante: el mismo documento impreso desde local o desde producción debe
 * apuntar a donde de verdad se puede comprobar.
 */

export interface CertificateFile {
  bytes: Uint8Array;
  filename: string;
  /** Enlace público de verificación (el que va impreso en el PDF). */
  verifyUrl: string;
}

/** Quita la barra final para no producir `//verificar`. */
export function normalizeBaseUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(clean)) {
    // Un origen inventado en el PDF sería peor que no generar el documento.
    throw new Error(`Origen no válido para el enlace de verificación: «${baseUrl}»`);
  }
  return clean;
}

export function certificateVerifyUrl(baseUrl: string, code: string): string {
  return `${normalizeBaseUrl(baseUrl)}/verificar/${code}`;
}

/**
 * Nombre del fichero: solo ASCII y sin datos personales.
 *
 * Los navegadores y los sistemas de ficheros se comportan de forma distinta con
 * tildes y comas; el nombre del curso en el fichero no aporta nada y el nombre
 * de la persona, menos todavía.
 */
export function certificateFilename(code: string): string {
  return `certificado-${code}.pdf`;
}

export function certificateFile(
  record: CertificateRecord,
  options: { baseUrl: string },
): CertificateFile {
  const verifyUrl = certificateVerifyUrl(options.baseUrl, record.code);
  const text = certificateText(record, { verifyUrl });

  return {
    bytes: certificatePdf(text),
    filename: certificateFilename(record.code),
    verifyUrl,
  };
}
