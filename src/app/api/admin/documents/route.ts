import { NextResponse } from "next/server";
import { jsonOk, toErrorResponse, assertTrustedOrigin } from "@/server/http";
import { requireActor } from "@/server/auth/session";
import { assertAdmin } from "@/domain/auth/authorization";
import { getServerConfig } from "@/server/config";
import { documentDependencies } from "@/server/deps";
import { readPdfUploadForm } from "@/server/documents/request";
import { storageUsage, uploadPdfDocument } from "@/server/documents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/documents
 * Sube un PDF y lo guarda fragmentado en Firestore (no en Storage).
 *
 * Solo administradores activos. El servidor valida la firma `%PDF-`, el tamaño,
 * las páginas y la cuota, y calcula el SHA-256. La respuesta NO incluye ninguna
 * ubicación del fichero: solo tamaño, fragmentos y huella.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);
    const actor = await requireActor();

    const form = await readPdfUploadForm(request);
    const deps = documentDependencies();
    const result = await uploadPdfDocument({ ...form, actor }, deps);
    const usage = await storageUsage(deps);

    return jsonOk({
      documentId: result.documentId,
      bytes: result.bytes,
      chunks: result.chunks,
      sha256: result.sha256,
      usage: {
        usedBytes: usage.usedBytes,
        budgetBytes: usage.budgetBytes,
        percent: usage.percent,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * GET /api/admin/documents
 * Uso de la cuota de PDF (sin exponer rutas ni fragmentos).
 */
export async function GET() {
  try {
    // La cuota es información de administración: no se muestra a un alumno.
    assertAdmin(await requireActor());
    const usage = await storageUsage(documentDependencies());
    return jsonOk({
      usedBytes: usage.usedBytes,
      budgetBytes: usage.budgetBytes,
      freeBytes: usage.freeBytes,
      percent: usage.percent,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Evita que Next intente cachear respuestas de documentos. */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
