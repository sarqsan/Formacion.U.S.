import { FieldValue } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import { COLLECTIONS } from "@/server/db/schema.constants";
import { enrollmentDocId, type Enrollment } from "@/domain/courses/enrollment";
import { getAdminDb } from "@/server/firebase/admin";
import { guard } from "@/server/firebase/repositories";
import type { EnrollmentStore } from "@/server/enrollments/store";

/**
 * MATRÍCULAS EN FIRESTORE (adaptador)
 * ==================================
 *
 * Colección `enrollments`, documento `{uid}_{courseId}`.
 *
 * El id compuesto permite dos cosas: que la regla de Firestore autorice con
 * `exists(...)` sin leer otro documento, y que no pueda haber dos matrículas
 * del mismo usuario en el mismo curso (la escritura es un `set` sobre un id
 * determinista, no un `add`).
 */
export class FirestoreEnrollmentStore implements EnrollmentStore {
  private docRef(uid: string, courseId: string) {
    return getAdminDb().collection(COLLECTIONS.enrollments).doc(enrollmentDocId(uid, courseId));
  }

  async get(uid: string, courseId: string): Promise<Enrollment | null> {
    return guard(async () => {
      const snapshot = await this.docRef(uid, courseId).get();
      if (!snapshot.exists) return null;
      const data = snapshot.data() as Partial<Enrollment> | undefined;
      if (!data) return null;

      return {
        uid: String(data.uid ?? uid),
        courseId: String(data.courseId ?? courseId),
        status: (data.status as Enrollment["status"]) ?? "revoked",
        version: typeof data.version === "number" ? data.version : null,
        enrolledAt: String(data.enrolledAt ?? ""),
        enrolledBy: String(data.enrolledBy ?? ""),
        updatedAt: String(data.updatedAt ?? ""),
      };
    });
  }

  async upsert(enrollment: Enrollment): Promise<void> {
    await guard(async () => {
      await this.docRef(enrollment.uid, enrollment.courseId).set(
        {
          uid: enrollment.uid,
          courseId: enrollment.courseId,
          status: "active",
          version: enrollment.version,
          enrolledAt: enrollment.enrolledAt,
          enrolledBy: enrollment.enrolledBy,
          updatedAt: enrollment.updatedAt,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async revoke(input: {
    uid: string;
    courseId: string;
    revokedAt: string;
    revokedBy: string;
  }): Promise<void> {
    await guard(async () => {
      const ref = this.docRef(input.uid, input.courseId);
      const snapshot = await ref.get();
      if (!snapshot.exists) {
        throw new DomainError("ENROLLMENT_NOT_FOUND", "Esa matrícula no existe.", 404);
      }

      await ref.set(
        {
          status: "revoked",
          updatedAt: input.revokedAt,
          revokedAt: input.revokedAt,
          revokedBy: input.revokedBy,
          updatedAtServer: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async listByUser(uid: string): Promise<Enrollment[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.enrollments)
        .where("uid", "==", uid)
        .get();

      return snapshot.docs.map((doc) => this.toEnrollment(doc.id, doc.data()));
    });
  }

  async listByCourse(courseId: string): Promise<Enrollment[]> {
    return guard(async () => {
      const snapshot = await getAdminDb()
        .collection(COLLECTIONS.enrollments)
        .where("courseId", "==", courseId)
        .where("status", "==", "active")
        .get();

      return snapshot.docs.map((doc) => this.toEnrollment(doc.id, doc.data()));
    });
  }

  private toEnrollment(id: string, data: FirebaseFirestore.DocumentData): Enrollment {
    return {
      uid: String(data.uid ?? id.split("_")[0] ?? ""),
      courseId: String(data.courseId ?? ""),
      status: (data.status as Enrollment["status"]) ?? "revoked",
      version: typeof data.version === "number" ? data.version : null,
      enrolledAt: String(data.enrolledAt ?? ""),
      enrolledBy: String(data.enrolledBy ?? ""),
      updatedAt: String(data.updatedAt ?? ""),
    };
  }
}
