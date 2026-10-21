import type { Enrollment } from "@/domain/courses/enrollment";
import type { EnrollmentStore } from "@/server/enrollments/store";

/**
 * Matrículas en memoria con las mismas invariantes que el adaptador Firestore:
 * id determinista (una por usuario y curso), revocar no borra, y `get` devuelve
 * el estado real aunque esté revocado.
 */
export class InMemoryEnrollmentStore implements EnrollmentStore {
  private items = new Map<string, Enrollment>();
  writes = 0;

  private key(uid: string, courseId: string) {
    return `${uid}@${courseId}`;
  }

  async get(uid: string, courseId: string): Promise<Enrollment | null> {
    const found = this.items.get(this.key(uid, courseId));
    return found ? { ...found } : null;
  }

  async upsert(enrollment: Enrollment): Promise<void> {
    this.writes += 1;
    this.items.set(this.key(enrollment.uid, enrollment.courseId), { ...enrollment });
  }

  async revoke(input: {
    uid: string;
    courseId: string;
    revokedAt: string;
    revokedBy: string;
  }): Promise<void> {
    const key = this.key(input.uid, input.courseId);
    const found = this.items.get(key);
    if (!found) return;
    this.writes += 1;
    this.items.set(key, {
      ...found,
      status: "revoked",
      updatedAt: input.revokedAt,
    });
  }

  async listByUser(uid: string): Promise<Enrollment[]> {
    return [...this.items.values()].filter((item) => item.uid === uid);
  }

  async listByCourse(courseId: string): Promise<Enrollment[]> {
    return [...this.items.values()].filter(
      (item) => item.courseId === courseId && item.status === "active",
    );
  }

  /** Atajo de prueba. */
  seed(uid: string, courseId: string, status: Enrollment["status"] = "active"): void {
    this.items.set(this.key(uid, courseId), {
      uid,
      courseId,
      status,
      version: 1,
      enrolledAt: "2026-03-01T10:00:00.000Z",
      enrolledBy: "admin-uid-0001",
      updatedAt: "2026-03-01T10:00:00.000Z",
    });
  }
}
