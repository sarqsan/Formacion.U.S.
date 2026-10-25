import { describe, expect, it } from "vitest";
import type { Actor } from "@/domain/auth/authorization";
import {
  CERTIFICATE_CODE_LENGTH,
  assertCertificateComplete,
  certificateCode,
  certificateText,
  formatCertificateDate,
  isCertificateCode,
  maskName,
  type CertificateRecord,
} from "@/domain/certificates/certificate";
import { certificatePdf } from "@/server/certificates/pdf";
import {
  certificateFile,
  certificateFilename,
  certificateVerifyUrl,
  normalizeBaseUrl,
} from "@/server/certificates/file";
import {
  certificateForDownload,
  issueCertificate,
  verifyCertificate,
  type CertificateAudit,
  type CertificateDependencies,
  type CertificateStore,
} from "@/server/certificates/service";
import { describeAuditEvent } from "@/server/audit/activity";
import type { CourseCatalogStore, CourseSummary } from "@/server/courses/catalog";
import type { LearningStore, StoredProgress } from "@/server/learning/store";
import { initProgress } from "@/domain/progress/course-progress";

/**
 * CERTIFICADOS
 * ============
 *
 * Lo que estas pruebas fijan, y por qué importa:
 *
 *   · **el código se deriva del contenido**: mismo alumno, mismo curso y misma
 *     versión dan siempre el mismo documento; cambiar cualquiera de los tres da
 *     otro distinto;
 *   · **no se certifica lo que no está completado**, y no se certifica a otra
 *     persona aunque se tenga sesión;
 *   · **una emisión, un documento**: pedirlo dos veces no duplica ni audita dos
 *     veces;
 *   · **la verificación pública no identifica**: nombre enmascarado, sin
 *     usuario y sin nombre completo;
 *   · **el PDF es un PDF**: cabecera, `startxref` y tabla de referencias con
 *     desplazamientos en bytes correctos (es lo que rompe los generadores
 *     caseros).
 */

const UID = "uid-alumno-0001";
const COURSE_ID = "curso-prevencion-riesgos";
const CODE = certificateCode({ uid: UID, courseId: COURSE_ID, version: 2 });

const LEARNER: Actor = { uid: UID, role: "learner", status: "active" };
const OTHER_LEARNER: Actor = { uid: "uid-alumno-0002", role: "learner", status: "active" };
const ADMIN: Actor = { uid: "uid-admin-0001", role: "admin", status: "active" };
const DISABLED: Actor = { uid: UID, role: "learner", status: "disabled" };

function record(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    code: CODE,
    uid: UID,
    username: "rol1.garcia",
    displayName: "García López, María",
    courseId: COURSE_ID,
    courseTitle: "Prevención de riesgos en el puesto de trabajo",
    version: 2,
    completedAt: "2026-10-01T09:00:00.000Z",
    issuedAt: "2026-10-02T09:00:00.000Z",
    issuedBy: UID,
    ...overrides,
  };
}

function progress(overrides: Partial<StoredProgress> = {}): StoredProgress {
  return {
    ...initProgress(COURSE_ID, 2, ["riesgos"]),
    uid: UID,
    documents: {},
    updatedAt: "2026-10-01T09:00:00.000Z",
    completedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

function memoryStore(initial: CertificateRecord[] = []) {
  const map = new Map(initial.map((item) => [item.code, item]));
  const writes: CertificateRecord[] = [];

  const store: CertificateStore = {
    async get(code) {
      return map.get(code) ?? null;
    },
    async create(item) {
      if (map.has(item.code)) return { created: false };
      map.set(item.code, item);
      writes.push(item);
      return { created: true };
    },
  };

  return { store, map, writes };
}

interface Harness {
  deps: CertificateDependencies;
  audits: Array<Parameters<CertificateAudit["record"]>[0]>;
  writes: CertificateRecord[];
  map: Map<string, CertificateRecord>;
}

function harness(options: {
  completedAt?: string | null;
  course?: CourseSummary | null;
  version?: number;
  person?: { username: string; displayName: string } | null;
  initial?: CertificateRecord[];
  /** Histórico de versiones anteriores, por si el curso se republicó. */
  archived?: Array<{ courseId: string; version: number; completedAt: string; archivedAt: string }>;
} = {}): Harness {
  const status = options.completedAt === undefined ? "2026-10-01T09:00:00.000Z" : options.completedAt;
  const course: CourseSummary = options.course ?? {
    courseId: COURSE_ID,
    title: "Prevención de riesgos (título actual)",
    publishedVersion: 2,
    lastDraftVersion: null,
  };
  const { store, map, writes } = memoryStore(options.initial);
  const audits: Harness["audits"] = [];

  const catalog: CourseCatalogStore = {
    async getCourse(courseId: string) {
      return courseId === course.courseId ? course : null;
    },
    async getVersion(courseId: string, version: number) {
      if (courseId !== course.courseId) return null;
      return {
        courseId: course.courseId,
        version,
        status: "published",
        // El título de la versión cursada es el que debe quedar certificado.
        title: "Prevención de riesgos en el puesto de trabajo",
        description: null,
        topics: [],
        finalExam: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "uid-admin-0001",
        publishedAt: "2026-01-01T00:00:00.000Z",
        publishedBy: "uid-admin-0001",
      };
    },
    async listVersions() {
      return [];
    },
    async getAnswerKeys() {
      return null;
    },
    async saveVersion() {
      throw new Error("no se usa");
    },
    async replaceDraftVersion() {
      throw new Error("no se usa");
    },
    async publish() {
      throw new Error("no se usa");
    },
  } as unknown as CourseCatalogStore;

  const learning = {
    async getProgress(uid: string, courseId: string) {
      if (uid !== UID || courseId !== COURSE_ID) return null;
      if (status === null) return null;
      return progress({ version: options.version ?? 2, completedAt: status });
    },
    async listArchivedProgress(uid: string) {
      if (uid !== UID) return [];
      return (options.archived ?? []).map((item) => ({
        ...progress({ courseId: item.courseId, version: item.version, completedAt: item.completedAt }),
        archivedAt: item.archivedAt,
      }));
    },
  } as unknown as LearningStore;

  const deps: CertificateDependencies = {
    certificates: store,
    catalog,
    learning,
    people: {
      async find(uid) {
        if (options.person === null) return null;
        if (uid !== UID) return null;
        return options.person ?? { username: "rol1.garcia", displayName: "García López, María" };
      },
    },
    audit: {
      async record(event) {
        audits.push(event);
      },
    },
    now: () => new Date("2026-10-02T09:00:00.000Z"),
  };

  return { deps, audits, writes, map };
}

describe("código del certificado", () => {
  it("es determinista: los mismos datos dan siempre el mismo código", () => {
    const one = certificateCode({ uid: UID, courseId: COURSE_ID, version: 2 });
    const two = certificateCode({ uid: UID, courseId: COURSE_ID, version: 2 });
    expect(one).toBe(two);
    expect(one).toHaveLength(CERTIFICATE_CODE_LENGTH);
    expect(one).toMatch(/^[0-9a-f]{20}$/);
  });

  it("cambia si cambia la persona, el curso o la versión", () => {
    const base = certificateCode({ uid: UID, courseId: COURSE_ID, version: 2 });
    expect(certificateCode({ uid: "uid-alumno-0002", courseId: COURSE_ID, version: 2 })).not.toBe(base);
    expect(certificateCode({ uid: UID, courseId: "otro-curso", version: 2 })).not.toBe(base);
    expect(certificateCode({ uid: UID, courseId: COURSE_ID, version: 3 })).not.toBe(base);
  });

  it("no se puede pedir para datos incompletos", () => {
    expect(() => certificateCode({ uid: "", courseId: COURSE_ID, version: 1 })).toThrow();
    expect(() => certificateCode({ uid: UID, courseId: COURSE_ID, version: 0 })).toThrow();
    expect(() => certificateCode({ uid: UID, courseId: COURSE_ID, version: 1.5 })).toThrow();
  });

  it("reconoce solo la forma válida", () => {
    expect(isCertificateCode(CODE)).toBe(true);
    expect(isCertificateCode(CODE.toUpperCase())).toBe(false);
    expect(isCertificateCode("")).toBe(false);
    expect(isCertificateCode(null)).toBe(false);
    expect(isCertificateCode(`${CODE} `)).toBe(false);
    expect(isCertificateCode("z".repeat(20))).toBe(false);
  });
});

describe("nombre enmascarado", () => {
  it("conserva la inicial y oculta el resto", () => {
    expect(maskName("García López, María")).toBe("G***** L****, M****");
  });

  it("no deja ver un nombre de una letra", () => {
    expect(maskName("A B")).toBe("A B");
  });

  it("aguanta un nombre vacío sin romper", () => {
    expect(maskName("   ")).toBe("—");
  });
});

describe("texto del certificado", () => {
  it("dice curso, versión, fecha y enlace de verificación", () => {
    const text = certificateText(record(), {
      verifyUrl: "https://formacionus.vercel.app/verificar/" + CODE,
    });

    expect(text.title).toBe("Certificado de aprovechamiento");
    expect(text.holder).toBe("García López, María");
    expect(text.body).toContain("Prevención de riesgos en el puesto de trabajo");
    expect(text.body).toContain("versión 2");
    expect(text.body).toContain("1 de octubre de 2026");
    expect(text.verification).toContain(CODE);
    expect(text.verification).toContain("https://formacionus.vercel.app/verificar/" + CODE);
    expect(text.footer).toContain("No lleva firma manuscrita");
  });

  it("un curso republicado no cambia un certificado ya emitido", () => {
    const issued = record({ courseTitle: "Título que se cursó", version: 2 });
    const text = certificateText(issued, { verifyUrl: "https://example.test/verificar/x" });
    expect(text.body).toContain("«Título que se cursó»");
    expect(text.body).toContain("versión 2");
  });

  it("la fecha se escribe en castellano y en UTC", () => {
    expect(formatCertificateDate("2026-10-01T23:30:00.000Z")).toBe("1 de octubre de 2026");
    expect(formatCertificateDate("no es una fecha")).toBe("—");
  });
});

describe("documento completo antes de escribir", () => {
  it("acepta un certificado con todos los datos", () => {
    expect(() => assertCertificateComplete(record())).not.toThrow();
  });

  it("rechaza huecos, código mal formado y fechas ilegibles", () => {
    expect(() => assertCertificateComplete(record({ displayName: "  " }))).toThrow();
    expect(() => assertCertificateComplete(record({ code: "no-es-un-codigo" }))).toThrow();
    expect(() => assertCertificateComplete(record({ version: 0 }))).toThrow();
    expect(() => assertCertificateComplete(record({ completedAt: "ayer" }))).toThrow();
  });
});

describe("PDF", () => {
  const pdf = certificatePdf(
    certificateText(record(), { verifyUrl: "https://example.test/verificar/" + CODE }),
  );
  const text = Buffer.from(pdf).toString("latin1");

  it("empieza y termina como un PDF", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("la tabla de referencias apunta a los objetos de verdad", () => {
    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(startxref)).toBe(true);
    // `startxref` debe caer exactamente sobre la palabra `xref`.
    expect(text.slice(startxref, startxref + 4)).toBe("xref");

    const table = text.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) n\s*$/gm)].map((match) => ({
      offset: Number(match[1]),
    }));
    expect(entries.length).toBeGreaterThanOrEqual(5);

    // El desplazamiento es en bytes: si se calculara con longitudes de cadena,
    // las tildes lo desviarían y el PDF no abriría en un visor estricto.
    entries.forEach((entry, index) => {
      const at = text.slice(entry.offset, entry.offset + 20);
      expect(at, `objeto ${index + 1}`).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it("lleva el texto del certificado en WinAnsi (Latin-1)", () => {
    expect(text).toContain("Certificado de aprovechamiento");
    expect(text).toContain("García López, María");
    expect(text).toContain("Prevenci");
    expect(text).toContain(CODE);
    // La «ó» debe ir como un solo byte 0xF3, no como dos bytes UTF-8.
    expect(text).not.toContain(Buffer.from("FORMACIÓN", "utf8").toString("latin1"));
  });

  it("no arrastra saltos de línea fuera de las cadenas", () => {
    // Un `\n` sin escapar dentro de una cadena rompe el flujo de contenido.
    expect(text).not.toContain("(\\n");
  });
});

describe("fichero del certificado", () => {
  it("el nombre es ASCII y no lleva datos personales", () => {
    expect(certificateFilename(CODE)).toBe(`certificado-${CODE}.pdf`);
  });

  it("el enlace de verificación no duplica barras", () => {
    expect(normalizeBaseUrl("https://example.test/")).toBe("https://example.test");
    expect(certificateVerifyUrl("https://example.test/", CODE)).toBe(
      `https://example.test/verificar/${CODE}`,
    );
  });

  it("un origen inventado no se imprime en el PDF", () => {
    expect(() => normalizeBaseUrl("")).toThrow();
    expect(() => normalizeBaseUrl("no es una url")).toThrow();
  });

  it("devuelve bytes de PDF con su nombre de fichero", () => {
    const file = certificateFile(record(), { baseUrl: "https://example.test" });
    expect(file.bytes.length).toBeGreaterThan(500);
    expect(file.filename).toBe(`certificado-${CODE}.pdf`);
    expect(file.verifyUrl).toBe(`https://example.test/verificar/${CODE}`);
    expect(Buffer.from(file.bytes).toString("latin1").startsWith("%PDF-1.4")).toBe(true);
  });
});

describe("emisión", () => {
  it("emite cuando el curso está completado y guarda una instantánea de los hechos", async () => {
    const { deps, writes, audits } = harness();
    const result = await issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps);

    expect(result.created).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      uid: UID,
      courseId: COURSE_ID,
      version: 2,
      // El título certificado es el de la versión cursada, no el del curso
      // (que en la prueba está cambiado a propósito).
      courseTitle: "Prevención de riesgos en el puesto de trabajo",
      completedAt: "2026-10-01T09:00:00.000Z",
      issuedAt: "2026-10-02T09:00:00.000Z",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ type: "certificate_issued", code: CODE, targetUid: UID });
  });

  it("pedirlo dos veces devuelve el mismo documento y no audita dos veces", async () => {
    const { deps, writes, audits } = harness();
    const first = await issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps);
    const second = await issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.code).toBe(first.record.code);
    expect(writes).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("no certifica un curso sin completar", async () => {
    const { deps, writes } = harness({ completedAt: null });
    await expect(
      issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps),
    ).rejects.toMatchObject({ code: "CERTIFICATE_NOT_COMPLETED", status: 409 });
    expect(writes).toHaveLength(0);
  });

  it("no deja que un alumno pida el certificado de otra persona", async () => {
    const { deps } = harness();
    await expect(
      issueCertificate({ actor: OTHER_LEARNER, uid: UID, courseId: COURSE_ID }, deps),
    ).rejects.toMatchObject({ code: "CERTIFICATE_FORBIDDEN", status: 403 });
  });

  it("administración sí puede emitirlo para otra persona", async () => {
    const { deps, writes } = harness();
    const result = await issueCertificate({ actor: ADMIN, uid: UID, courseId: COURSE_ID }, deps);
    expect(result.created).toBe(true);
    expect(writes[0].issuedBy).toBe("uid-admin-0001");
  });

  it("una cuenta deshabilitada no emite nada", async () => {
    const { deps } = harness();
    await expect(
      issueCertificate({ actor: DISABLED, uid: UID, courseId: COURSE_ID }, deps),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("un curso inexistente es 404, no un certificado vacío", async () => {
    const { deps } = harness();
    await expect(
      issueCertificate({ actor: LEARNER, uid: UID, courseId: "curso-que-no-existe" }, deps),
    ).rejects.toMatchObject({ code: "COURSE_NOT_FOUND", status: 404 });
  });

  it("certifica la versión completada aunque el curso se haya republicado", async () => {
    // Terminó la v1, se publicó la v2 y su progreso vivo volvió a empezar: la
    // prueba de que completó la v1 está en el histórico, y ahí hay que mirar.
    const { deps, writes } = harness({
      completedAt: null,
      course: {
        courseId: COURSE_ID,
        title: "Prevención de riesgos (v2)",
        publishedVersion: 2,
        lastDraftVersion: null,
      },
      archived: [
        {
          courseId: COURSE_ID,
          version: 1,
          completedAt: "2026-02-01T09:00:00.000Z",
          archivedAt: "2026-03-01T09:00:00.000Z",
        },
      ],
    });

    const result = await issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps);
    expect(result.created).toBe(true);
    expect(writes[0].version).toBe(1);
    expect(writes[0].completedAt).toBe("2026-02-01T09:00:00.000Z");
  });

  it("si hay varias versiones completadas, certifica la más reciente", async () => {
    const { deps, writes } = harness({
      archived: [
        {
          courseId: COURSE_ID,
          version: 1,
          completedAt: "2026-02-01T09:00:00.000Z",
          archivedAt: "2026-03-01T09:00:00.000Z",
        },
      ],
    });

    await issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps);
    expect(writes[0].version).toBe(2);
  });

  it("el histórico de otros cursos no cuenta", async () => {
    const { deps } = harness({
      completedAt: null,
      archived: [
        {
          courseId: "otro-curso",
          version: 1,
          completedAt: "2026-02-01T09:00:00.000Z",
          archivedAt: "2026-03-01T09:00:00.000Z",
        },
      ],
    });
    await expect(
      issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps),
    ).rejects.toMatchObject({ code: "CERTIFICATE_NOT_COMPLETED" });
  });

  it("si la ficha de la persona no existe, no se emite a medias", async () => {
    const { deps } = harness({ person: null });
    await expect(
      issueCertificate({ actor: LEARNER, uid: UID, courseId: COURSE_ID }, deps),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", status: 404 });
  });
});

describe("verificación pública", () => {
  it("devuelve los datos del certificado con el nombre enmascarado", async () => {
    const { deps } = harness({ initial: [record()] });
    const result = await verifyCertificate(CODE, deps);

    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("debía ser válido");
    expect(result.holderMasked).toBe("G***** L****, M****");
    expect(JSON.stringify(result)).not.toContain("García López, María");
    expect(JSON.stringify(result)).not.toContain("rol1.garcia");
    expect(result.courseTitle).toBe("Prevención de riesgos en el puesto de trabajo");
    expect(result.version).toBe(2);
  });

  it("un código con mala forma no consulta la base", async () => {
    let reads = 0;
    const result = await verifyCertificate("no-es-un-codigo", {
      certificates: {
        async get() {
          reads += 1;
          return null;
        },
        async create() {
          return { created: false };
        },
      },
    });
    expect(result).toEqual({ valid: false, code: null });
    expect(reads).toBe(0);
  });

  it("un código válido que no existe no es válido", async () => {
    const { deps } = harness();
    const result = await verifyCertificate(CODE, deps);
    expect(result).toEqual({ valid: false, code: CODE });
  });
});

describe("descarga del PDF", () => {
  it("el titular puede descargarlo", async () => {
    const { deps } = harness({ initial: [record()] });
    const found = await certificateForDownload({ actor: LEARNER, code: CODE }, deps);
    expect(found.displayName).toBe("García López, María");
  });

  it("administración también", async () => {
    const { deps } = harness({ initial: [record()] });
    const found = await certificateForDownload({ actor: ADMIN, code: CODE }, deps);
    expect(found.code).toBe(CODE);
  });

  it("otra persona no: el código se puede reenviar", async () => {
    const { deps } = harness({ initial: [record()] });
    await expect(
      certificateForDownload({ actor: OTHER_LEARNER, code: CODE }, deps),
    ).rejects.toMatchObject({ code: "CERTIFICATE_FORBIDDEN", status: 403 });
  });

  it("un código inexistente o mal formado es 404", async () => {
    const { deps } = harness();
    await expect(
      certificateForDownload({ actor: LEARNER, code: CODE }, deps),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      certificateForDownload({ actor: LEARNER, code: "arriba" }, deps),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sin sesión no hay descarga", async () => {
    const { deps } = harness({ initial: [record()] });
    await expect(
      certificateForDownload(
        { actor: { uid: "", role: "learner", status: "disabled" }, code: CODE },
        deps,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("registro de actividad", () => {
  it("un certificado emitido se lee como un evento más", () => {
    const entry = describeAuditEvent({
      type: "certificate_issued",
      actorUid: "uid-admin-0001",
      targetUid: UID,
      at: "2026-10-02T09:00:00.000Z",
      code: CODE,
      courseId: COURSE_ID,
      courseTitle: "Prevención de riesgos",
      version: 2,
    });

    expect(entry.title).toBe("Certificado emitido");
    expect(entry.detail).toContain("Prevención de riesgos");
    expect(entry.detail).toContain("versión 2");
    expect(entry.detail).toContain(UID);
    // El código del certificado no es un secreto, pero tampoco hace falta aquí.
    expect(entry.detail).not.toContain(CODE);
  });
});
