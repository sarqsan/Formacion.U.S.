import { headers } from "next/headers";
import { normalizeBaseUrl } from "@/server/certificates/file";

/**
 * Origen de la petición en curso (`https://formacionus.vercel.app`).
 *
 * Sirve para construir el enlace de verificación que se imprime en el PDF y se
 * enseña en pantalla: tiene que apuntar al dominio desde el que se ha pedido el
 * documento, no a una constante que se quede vieja al cambiar de entorno.
 *
 * Detrás del proxy de Vercel, `Host` no basta: el protocolo viaja en
 * `x-forwarded-proto`.
 */
export async function requestOrigin(request?: Request): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto =
    headerList.get("x-forwarded-proto") ??
    (request ? new URL(request.url).protocol.replace(":", "") : "https");

  if (host) return normalizeBaseUrl(`${proto}://${host}`);
  if (request) return normalizeBaseUrl(new URL(request.url).origin);

  // Sin cabeceras utilizables no se inventa un dominio: un enlace falso en un
  // certificado es peor que un error visible.
  throw new Error("No se ha podido determinar el dominio de la aplicación.");
}
