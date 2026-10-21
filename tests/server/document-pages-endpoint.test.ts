import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readPagesQuery } from "@/server/documents/request";
import { toErrorResponse } from "@/server/http";
import { DomainError } from "@/domain/text";

/**
 * ENDPOINT DE PÁGINAS — contrato externo
 * ======================================
 *
 * Comprueba lo que se puede comprobar sin arrancar Next ni Firestore:
 *
 *   · el parseo de la query (solo enteros; el resto lo decide el servidor);
 *   · que la ruta existe, sustituye a la antigua `/window` y no acepta estado
 *     del cliente;
 *   · las cabeceras que impiden cachear o interpretar el binario;
 *   · que los errores se traducen sin filtrar contenido ni detalles internos.
 *
 * NO comprueba el comportamiento HTTP completo (sesión, matrícula y progreso
 * contra Firestore): eso lo cubren `document-service.test.ts` con dobles y,
 * cuando se pueda ejecutar, las pruebas de reglas. Se declara aquí para no
 * dar por probado lo que no lo está.
 */

const API_DIR = join(process.cwd(), "src", "app", "api", "documents", "[documentId]");
const ROUTE = join(API_DIR, "pages", "route.ts");
const LEGACY = join(API_DIR, "window", "route.ts");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("query de páginas", () => {
  const request = (query: string) =>
    new Request(`https://formacion.example/api/documents/doc-1/pages${query}`);

  it("lee from y to enteros", () => {
    expect(readPagesQuery(request("?from=1&to=20"))).toEqual({ from: 1, to: 20 });
  });

  it("no acepta valores ausentes, vacíos, decimales ni texto", () => {
    for (const query of ["", "?from=1", "?to=2", "?from=&to=2", "?from=1.5&to=2", "?from=a&to=b"]) {
      expect(() => readPagesQuery(request(query)), query).toThrow(DomainError);
    }
  });

  it("el error de parseo es 400 y no reproduce el valor recibido", () => {
    try {
      readPagesQuery(request("?from=<script>&to=2"));
      throw new Error("debería haber lanzado");
    } catch (error) {
      expect((error as DomainError).status).toBe(400);
      expect((error as DomainError).code).toBe("PAGE_INVALID");
      expect((error as DomainError).message).not.toContain("script");
    }
  });

  it("ignora cualquier parámetro que no sea from/to (no se puede pedir cuota ni usuario)", () => {
    const parsed = readPagesQuery(
      new Request(
        "https://formacion.example/api/documents/doc-1/pages?from=1&to=2&uid=otro&cost=0&admin=true&limit=99999",
      ),
    );

    // Solo salen las dos claves que el servicio usa; el resto se descarta aquí
    // y no llega a ninguna decisión de autorización ni de cuota.
    expect(parsed).toEqual({ from: 1, to: 2 });
    expect(Object.keys(parsed).sort()).toEqual(["from", "to"]);
  });

  it("los negativos y el rango invertido los rechaza el servicio, no el parser", () => {
    // El parser solo garantiza enteros: quien conoce el documento y el
    // progreso es el servicio (ver document-service.test.ts).
    expect(readPagesQuery(request("?from=-5&to=3"))).toEqual({ from: -5, to: 3 });
    expect(readPagesQuery(request("?from=9&to=2"))).toEqual({ from: 9, to: 2 });
  });
});

describe("ruta /api/documents/[documentId]/pages", () => {
  it("existe y sustituye a la antigua ruta de ventanas de bytes", () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(existsSync(LEGACY)).toBe(false);
  });

  it("solo expone GET: la lectura no cambia estado", () => {
    const text = source(ROUTE);
    expect(text).toContain("export async function GET");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(text.includes(`export async function ${method}`), method).toBe(false);
    }
  });

  it("exige sesión y delega en el servicio autorizado", () => {
    const text = source(ROUTE);
    expect(text).toContain("requireActor(");
    expect(text).toContain("readDocumentPages(");
    expect(text).toContain("readPagesQuery(");
  });

  it("no acepta página, progreso ni APTO enviados por el cliente", () => {
    const text = source(ROUTE);
    // La ruta solo lee `from`/`to` de la query: nada de cuerpo ni de campos
    // como lastPageViewed, completedAt o passed.
    for (const forbidden of ["lastPageViewed", "completedAt", "passed", "request.json(", "formData("]) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("responde con cabeceras que impiden cachear o interpretar el binario", () => {
    const text = source(ROUTE);
    expect(text).toContain('"Cache-Control": "no-store');
    expect(text).toContain('"X-Content-Type-Options": "nosniff"');
    expect(text).toContain('"Content-Type": "application/pdf"');
    expect(text).toContain('"Content-Length"');
    // Sin enlaces: nada de URLs firmadas ni rutas de Storage.
    expect(text.toLowerCase()).not.toContain("signedurl");
    expect(text).not.toContain("storage.googleapis.com");
  });

  it("traduce cualquier error sin revelar el stack ni datos internos", async () => {
    const internal = new Error("Falta el fragmento 3 de /pdfChunks/doc-1_3: sha256 abc123");
    // El servidor sí registra el detalle en su log; se silencia aquí para no
    // ensuciar la salida de `npm run verify`.
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = toErrorResponse(internal);
    logger.mockRestore();
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(payload)).not.toContain("pdfChunks");
    expect(JSON.stringify(payload)).not.toContain("abc123");
  });

  it("un error de dominio llega con su código y su estado, no con contenido", async () => {
    const response = toErrorResponse(
      new DomainError("COURSE_NOT_AUTHORIZED", "No tienes acceso a este curso.", 403),
    );
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("COURSE_NOT_AUTHORIZED");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
