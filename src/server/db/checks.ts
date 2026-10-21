/**
 * COMPROBACIONES DE INTEGRIDAD DE LA BASE DE DATOS (puras)
 * ======================================================
 *
 * Este módulo NO importa nada: recibe datos ya leídos y devuelve hallazgos.
 * Lo usan `npm run db:check` (con datos reales del proyecto) y las pruebas
 * unitarias (con datos sintéticos). Esa separación es lo que permite probar la
 * lógica de auditoría hoy, aunque no haya Firebase conectado.
 *
 * Niveles:
 *   error   → el sistema puede estar inseguro o incoherente; hay que corregir
 *   warning  → revisar (puede ser legítimo, pero no debería ser lo normal)
 *   info     → inventario, útil para el informe
 */

export type FindingLevel = "error" | "warning" | "info";

export interface Finding {
  level: FindingLevel;
  code: string;
  message: string;
  /** Referencias afectadas (ids), para localizar el problema. */
  refs?: string[];
}

export interface Summary {
  errors: number;
  warnings: number;
  infos: number;
  ok: boolean;
}

export function summarize(findings: readonly Finding[]): Summary {
  const errors = findings.filter((finding) => finding.level === "error").length;
  const warnings = findings.filter((finding) => finding.level === "warning").length;
  const infos = findings.filter((finding) => finding.level === "info").length;
  return { errors, warnings, infos, ok: errors === 0 };
}

// ---------------------------------------------------------------------------
// Tipos mínimos de entrada (subconjuntos de los documentos reales)
// ---------------------------------------------------------------------------

export interface AccountLite {
  uid: string;
  username?: string;
  role?: string;
  status?: string;
  claimsVersion?: unknown;
  createdBy?: string;
}

export interface CourseLite {
  courseId: string;
  publishedVersion?: number | null;
}

export interface VersionLite {
  courseId: string;
  version: number;
  status?: string;
}

export interface ProgressLite {
  uid: string;
  courseId: string;
  version: number;
  completedAt?: string | null;
}

export interface AttemptLite {
  uid: string;
  courseId: string;
  version: number;
  assessmentType?: string;
  passed?: boolean;
  correctCount?: number;
  totalQuestions?: number;
  gradedBy?: string;
}

export interface AnswerKeysLite {
  courseId: string;
  version: number;
}

// ---------------------------------------------------------------------------
// 1. Esquema inicializado y versión correcta
// ---------------------------------------------------------------------------

export function checkSchema(
  meta: { schemaVersion?: unknown; initializedAt?: unknown } | null,
  expectedVersion: number,
): Finding[] {
  if (!meta) {
    return [
      {
        level: "error",
        code: "SCHEMA_NOT_INITIALIZED",
        message:
          "No existe el documento meta/schema. Ejecuta `npm run db:init -- --apply` antes de usar la base de datos.",
      },
    ];
  }

  const findings: Finding[] = [];

  if (typeof meta.schemaVersion !== "number") {
    findings.push({
      level: "error",
      code: "SCHEMA_VERSION_MISSING",
      message: "meta/schema no tiene un schemaVersion numérico.",
    });
  } else if (meta.schemaVersion > expectedVersion) {
    findings.push({
      level: "error",
      code: "SCHEMA_VERSION_NEWER",
      message: `La base de datos tiene el esquema v${meta.schemaVersion}, más nuevo que el código (v${expectedVersion}). Actualiza la aplicación antes de continuar.`,
    });
  } else if (meta.schemaVersion < expectedVersion) {
    findings.push({
      level: "warning",
      code: "SCHEMA_VERSION_OLDER",
      message: `La base de datos está en v${meta.schemaVersion} y el código espera v${expectedVersion}: hay una migración pendiente.`,
    });
  } else {
    findings.push({
      level: "info",
      code: "SCHEMA_VERSION_OK",
      message: `Esquema v${expectedVersion} correcto.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 2. Administradores: ningún admin debe venir de una importación
// ---------------------------------------------------------------------------

/**
 * Los administradores iniciales los crea `scripts/bootstrap-admins.mjs`, que
 * marca `createdBy: "bootstrap-script"`. Cualquier otra cuenta con rol admin
 * debe revisarse: la importación de Excel solo puede crear `learner`.
 */
export function checkAdminOrigins(accounts: readonly AccountLite[]): Finding[] {
  const admins = accounts.filter((account) => account.role === "admin");

  if (admins.length === 0) {
    return [
      {
        level: "error",
        code: "NO_ADMIN",
        message:
          "No hay ninguna cuenta administradora. Ejecuta `npm run bootstrap:admins` antes de nada.",
      },
    ];
  }

  const findings: Finding[] = [
    {
      level: "info",
      code: "ADMIN_COUNT",
      message: `Hay ${admins.length} cuenta(s) administradora(s).`,
      refs: admins.map((admin) => admin.username ?? admin.uid),
    },
  ];

  const suspicious = admins.filter((admin) => admin.createdBy !== "bootstrap-script");
  if (suspicious.length > 0) {
    findings.push({
      level: "warning",
      code: "ADMIN_ORIGIN_UNEXPECTED",
      message:
        "Hay administradores que no fueron creados por el procedimiento de arranque. La importación nunca concede admin: revisa cómo se crearon.",
      refs: suspicious.map((admin) => `${admin.username ?? admin.uid} (${admin.createdBy ?? "sin createdBy"})`),
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 3. Coherencia de cuentas
// ---------------------------------------------------------------------------

export function checkAccounts(accounts: readonly AccountLite[]): Finding[] {
  const findings: Finding[] = [];
  const usernames = new Map<string, number>();

  for (const account of accounts) {
    if (!account.username) {
      findings.push({
        level: "error",
        code: "ACCOUNT_WITHOUT_USERNAME",
        message: "Cuenta sin nombre de usuario.",
        refs: [account.uid],
      });
      continue;
    }

    usernames.set(account.username, (usernames.get(account.username) ?? 0) + 1);

    if (account.role !== "admin" && account.role !== "learner") {
      findings.push({
        level: "error",
        code: "ACCOUNT_INVALID_ROLE",
        message: `Rol no válido en la cuenta ${account.username}.`,
        refs: [account.uid],
      });
    }

    if (!["pending_activation", "active", "disabled"].includes(String(account.status))) {
      findings.push({
        level: "error",
        code: "ACCOUNT_INVALID_STATUS",
        message: `Estado no válido en la cuenta ${account.username}.`,
        refs: [account.uid],
      });
    }

    if (typeof account.claimsVersion !== "number" || !Number.isInteger(account.claimsVersion)) {
      findings.push({
        level: "error",
        code: "ACCOUNT_INVALID_CLAIMS_VERSION",
        message: `claimsVersion no entero en ${account.username}: las reglas comparan por igualdad estricta y esa cuenta no podrá acceder.`,
        refs: [account.uid],
      });
    }
  }

  for (const [username, count] of usernames) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "DUPLICATE_USERNAME",
        message: `Hay ${count} cuentas con el nombre de usuario «${username}».`,
        refs: [username],
      });
    }
  }

  findings.push({
    level: "info",
    code: "ACCOUNT_TOTALS",
    message: `Cuentas: ${accounts.length} (${accounts.filter((a) => a.status === "active").length} activas, ${accounts.filter((a) => a.status === "pending_activation").length} pendientes, ${accounts.filter((a) => a.status === "disabled").length} deshabilitadas).`,
  });

  return findings;
}

// ---------------------------------------------------------------------------
// 4. Cursos, versiones y claves
// ---------------------------------------------------------------------------

export function checkContent(
  courses: readonly CourseLite[],
  versions: readonly VersionLite[],
  answerKeys: readonly AnswerKeysLite[],
): Finding[] {
  const findings: Finding[] = [];
  const versionKey = (courseId: string, version: number) => `${courseId}@v${version}`;
  const versionMap = new Map(versions.map((version) => [versionKey(version.courseId, version.version), version]));
  const keysMap = new Map(answerKeys.map((keys) => [versionKey(keys.courseId, keys.version), keys]));

  for (const course of courses) {
    if (course.publishedVersion === null || course.publishedVersion === undefined) {
      findings.push({
        level: "info",
        code: "COURSE_WITHOUT_PUBLICATION",
        message: `El curso ${course.courseId} no tiene versión publicada (los alumnos no lo verán).`,
        refs: [course.courseId],
      });
      continue;
    }

    const published = versionMap.get(versionKey(course.courseId, course.publishedVersion));
    if (!published) {
      findings.push({
        level: "error",
        code: "PUBLISHED_VERSION_MISSING",
        message: `El curso ${course.courseId} apunta a la versión ${course.publishedVersion}, que no existe.`,
        refs: [course.courseId],
      });
      continue;
    }

    if (published.status !== "published") {
      findings.push({
        level: "error",
        code: "PUBLISHED_VERSION_NOT_PUBLISHED",
        message: `El curso ${course.courseId} apunta a la v${course.publishedVersion}, pero esa versión está en estado «${published.status}».`,
        refs: [course.courseId],
      });
    }

    if (!keysMap.has(versionKey(course.courseId, course.publishedVersion))) {
      findings.push({
        level: "error",
        code: "PUBLISHED_VERSION_WITHOUT_KEYS",
        message: `La versión publicada ${course.courseId} v${course.publishedVersion} no tiene claves de corrección: las evaluaciones no se podrían corregir.`,
        refs: [course.courseId],
      });
    }
  }

  // Claves huérfanas: apuntan a versiones que no existen.
  for (const keys of answerKeys) {
    if (!versionMap.has(versionKey(keys.courseId, keys.version))) {
      findings.push({
        level: "warning",
        code: "ORPHAN_ANSWER_KEYS",
        message: `Hay claves de corrección para ${keys.courseId} v${keys.version}, versión inexistente.`,
        refs: [`${keys.courseId}@v${keys.version}`],
      });
    }
  }

  findings.push({
    level: "info",
    code: "CONTENT_TOTALS",
    message: `Cursos: ${courses.length}; versiones: ${versions.length}; juegos de claves: ${answerKeys.length}.`,
  });

  return findings;
}

// ---------------------------------------------------------------------------
// 5. Cuota de almacenamiento de PDF
// ---------------------------------------------------------------------------

export interface StorageUsageLite {
  /** Contador atómico `meta/storage.usedBytes`. */
  counterBytes: number;
  /** Suma real de `bytes` de los documentos no archivados. */
  actualBytes: number;
  /** Presupuesto configurado. */
  budgetBytes: number;
}

/**
 * El contador de cuota se escribe en la misma transacción que los fragmentos.
 * Si deja de cuadrar con la suma real, la aplicación podría aceptar subidas que
 * no caben (o rechazar las que sí). Se compara en las dos direcciones.
 */
export function checkStorage(usage: StorageUsageLite): Finding[] {
  const findings: Finding[] = [];
  const difference = usage.counterBytes - usage.actualBytes;

  if (Math.abs(difference) > 1024) {
    findings.push({
      level: "error",
      code: "STORAGE_COUNTER_DRIFT",
      message: `El contador de cuota (${usage.counterBytes} B) no coincide con los documentos (${usage.actualBytes} B). Diferencia: ${difference} B. Recalcula el contador antes de seguir subiendo.`,
    });
  } else {
    findings.push({
      level: "info",
      code: "STORAGE_COUNTER_OK",
      message: `Contador de cuota coherente (${usage.actualBytes} B).`,
    });
  }

  if (usage.actualBytes > usage.budgetBytes) {
    findings.push({
      level: "error",
      code: "STORAGE_OVER_BUDGET",
      message: `Los PDF ocupan ${usage.actualBytes} B y el presupuesto es ${usage.budgetBytes} B: no caben más subidas. Archiva documentos u reduce el presupuesto de otros usos.`,
    });
  } else {
    const percent = Math.round((usage.actualBytes / usage.budgetBytes) * 1000) / 10;
    findings.push({
      level: percent >= 90 ? "warning" : "info",
      code: "STORAGE_USAGE",
      message: `PDF: ${usage.actualBytes} B de ${usage.budgetBytes} B (${percent} %).`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// 6. Progreso e intentos
// ---------------------------------------------------------------------------

export function checkLearning(
  progress: readonly ProgressLite[],
  attempts: readonly AttemptLite[],
  courses: readonly CourseLite[],
): Finding[] {
  const findings: Finding[] = [];
  const publishedByCourse = new Map(
    courses.map((course) => [course.courseId, course.publishedVersion ?? null]),
  );

  for (const entry of progress) {
    const published = publishedByCourse.get(entry.courseId);
    if (published === null || published === undefined) {
      findings.push({
        level: "warning",
        code: "PROGRESS_FOR_UNPUBLISHED_COURSE",
        message: `Hay progreso de ${entry.uid} en el curso ${entry.courseId}, que no está publicado.`,
        refs: [entry.uid, entry.courseId],
      });
      continue;
    }
    if (entry.version > published) {
      findings.push({
        level: "error",
        code: "PROGRESS_VERSION_AHEAD",
        message: `El progreso de ${entry.uid} en ${entry.courseId} está en v${entry.version} pero la publicada es v${published}.`,
        refs: [entry.uid, entry.courseId],
      });
    }
  }

  for (const attempt of attempts) {
    if (attempt.gradedBy !== "server") {
      findings.push({
        level: "error",
        code: "ATTEMPT_NOT_SERVER_GRADED",
        message: `Hay un intento sin marcar como corregido en servidor (${attempt.uid} / ${attempt.courseId}).`,
        refs: [attempt.uid, attempt.courseId],
      });
    }

    if (
      attempt.passed === true &&
      typeof attempt.correctCount === "number" &&
      typeof attempt.totalQuestions === "number" &&
      attempt.correctCount !== attempt.totalQuestions
    ) {
      findings.push({
        level: "error",
        code: "ATTEMPT_INCONSISTENT_PASS",
        message: `Intento marcado como aprobado con ${attempt.correctCount}/${attempt.totalQuestions} correctas (${attempt.uid} / ${attempt.courseId}). La regla es todo o nada.`,
        refs: [attempt.uid, attempt.courseId],
      });
    }
  }

  findings.push({
    level: "info",
    code: "LEARNING_TOTALS",
    message: `Documentos de progreso: ${progress.length}; intentos: ${attempts.length}; cursos completados: ${progress.filter((p) => p.completedAt).length}.`,
  });

  return findings;
}

/** Ejecuta todas las comprobaciones con los datos ya cargados. */
export function runChecks(input: {
  expectedSchemaVersion: number;
  meta: { schemaVersion?: unknown; initializedAt?: unknown } | null;
  accounts: readonly AccountLite[];
  courses: readonly CourseLite[];
  versions: readonly VersionLite[];
  answerKeys: readonly AnswerKeysLite[];
  progress: readonly ProgressLite[];
  attempts: readonly AttemptLite[];
  storage?: StorageUsageLite;
}): Finding[] {
  return [
    ...checkSchema(input.meta, input.expectedSchemaVersion),
    ...checkAdminOrigins(input.accounts),
    ...checkAccounts(input.accounts),
    ...checkContent(input.courses, input.versions, input.answerKeys),
    ...checkLearning(input.progress, input.attempts, input.courses),
    ...(input.storage ? checkStorage(input.storage) : []),
  ];
}
