import { jsonOk, toErrorResponse, assertTrustedOrigin, readJsonBody } from "@/server/http";
import { requireActor } from "@/server/auth/session";
import { getServerConfig } from "@/server/config";
import { enrollmentDependencies } from "@/server/deps";
import { enrollStudent, revokeEnrollment } from "@/server/enrollments/service";
import { DomainError } from "@/domain/text";
import { assertAdmin } from "@/domain/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EnrollmentBody {
  uid?: unknown;
  courseId?: unknown;
  action?: unknown;
}

/**
 * POST /api/admin/enrollments
 *
 *   { "action": "enroll" | "revoke", "uid": "…", "courseId": "…" }
 *
 * Solo administradores activos. El rol se comprueba **en el servidor** a partir
 * de la sesión: el cuerpo de la petición no puede otorgar permisos.
 * Matricular es idempotente; revocar conserva el progreso.
 */
export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    assertTrustedOrigin(request, config.APP_ORIGIN);
    const actor = await requireActor();
    assertAdmin(actor);

    const body = await readJsonBody<EnrollmentBody>(request);
    const uid = typeof body.uid === "string" ? body.uid.trim() : "";
    const courseId = typeof body.courseId === "string" ? body.courseId.trim() : "";
    const action = body.action;

    if (!uid || !courseId) {
      throw new DomainError(
        "ENROLLMENT_FIELDS_MISSING",
        "Indica «uid» y «courseId».",
        400,
      );
    }

    const deps = enrollmentDependencies();

    if (action === "enroll") {
      const enrollment = await enrollStudent({ actor, uid, courseId }, deps);
      return jsonOk({
        uid: enrollment.uid,
        courseId: enrollment.courseId,
        status: enrollment.status,
      });
    }

    if (action === "revoke") {
      await revokeEnrollment({ actor, uid, courseId }, deps);
      return jsonOk({ uid, courseId, status: "revoked" });
    }

    throw new DomainError(
      "ENROLLMENT_ACTION_INVALID",
      "«action» debe ser «enroll» o «revoke».",
      400,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Consulta de matrículas de un curso — solo administración. */
export async function GET(request: Request) {
  try {
    assertAdmin(await requireActor());

    const url = new URL(request.url);
    const courseId = url.searchParams.get("courseId")?.trim();
    const uid = url.searchParams.get("uid")?.trim();
    const deps = enrollmentDependencies();

    if (courseId) {
      const list = await deps.enrollments.listByCourse(courseId);
      return jsonOk({
        courseId,
        students: list.map((enrollment) => ({
          uid: enrollment.uid,
          status: enrollment.status,
          enrolledAt: enrollment.enrolledAt,
        })),
      });
    }

    if (uid) {
      const list = await deps.enrollments.listByUser(uid);
      return jsonOk({
        uid,
        courses: list.map((enrollment) => ({
          courseId: enrollment.courseId,
          status: enrollment.status,
        })),
      });
    }

    throw new DomainError(
      "ENROLLMENT_FILTER_REQUIRED",
      "Indica «courseId» o «uid».",
      400,
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
