import { buildCsv, type CsvColumn } from "@/domain/exports/csv";
import type { ActivityEntry } from "@/server/audit/activity";

/**
 * INFORMES DESCARGABLES
 * =====================
 *
 * Dos exportaciones, con la misma idea: lo que ya se ve en pantalla, en un
 * fichero que se puede abrir, filtrar y archivar sin copiar a mano.
 *
 *   · **Progreso**: una fila por matrícula, con lo que falta y los intentos.
 *     Es lo que se pide cuando hay que justificar la formación de una persona.
 *   · **Actividad**: el registro de auditoría, que hasta ahora solo se leía en
 *     pantalla y se perdía al cambiar de página.
 *
 * Las columnas están definidas aquí, en un solo sitio, y no en la ruta HTTP: así
 * el fichero se prueba sin levantar el servidor y no hay dos listas de columnas
 * que se desvíen.
 */

export interface ProgressExportRow {
  username: string;
  personRol: string;
  courseTitle: string;
  courseId: string;
  status: string;
  percent: number;
  topicsPassed: number;
  topicsTotal: number;
  finalExamPassed: boolean;
  completed: boolean;
  pending: string[];
  attempts: number;
  enrolledAt: string;
}

export const PROGRESS_COLUMNS: ReadonlyArray<CsvColumn<ProgressExportRow>> = [
  { header: "Usuario", value: (row) => row.username },
  { header: "Rol de persona", value: (row) => row.personRol },
  { header: "Curso", value: (row) => row.courseTitle },
  { header: "Código del curso", value: (row) => row.courseId },
  { header: "Estado de la matrícula", value: (row) => row.status },
  { header: "Progreso (%)", value: (row) => row.percent },
  { header: "Temas superados", value: (row) => row.topicsPassed },
  { header: "Temas obligatorios", value: (row) => row.topicsTotal },
  { header: "Examen final", value: (row) => (row.finalExamPassed ? "Apto" : "No apto") },
  { header: "Completado", value: (row) => row.completed },
  { header: "Pendiente", value: (row) => row.pending.join(" · ") },
  { header: "Intentos", value: (row) => row.attempts },
  { header: "Fecha de alta", value: (row) => row.enrolledAt.slice(0, 10) },
];

export function progressCsv(rows: readonly ProgressExportRow[]): string {
  return buildCsv(rows, PROGRESS_COLUMNS);
}

export interface ActivityExportRow {
  at: string;
  type: string;
  title: string;
  actorUid: string;
  targetUid: string;
  detail: string;
}

export const ACTIVITY_COLUMNS: ReadonlyArray<CsvColumn<ActivityExportRow>> = [
  { header: "Fecha (UTC)", value: (row) => row.at },
  { header: "Tipo", value: (row) => row.type },
  { header: "Qué", value: (row) => row.title },
  { header: "Quién (uid)", value: (row) => row.actorUid },
  { header: "Afectado (uid)", value: (row) => row.targetUid },
  { header: "Detalle", value: (row) => row.detail },
];

/**
 * El registro exportado **no** incluye campos fuera de la lista blanca: se
 * construye desde `ActivityEntry`, que ya viene filtrada por el servicio. Lo que
 * no está en ese tipo no puede llegar al fichero.
 */
export function activityRows(entries: readonly ActivityEntry[]): ActivityExportRow[] {
  return entries.map((entry) => ({
    at: entry.at ?? "",
    type: entry.type,
    title: entry.title,
    actorUid: entry.actorUid ?? "",
    targetUid: entry.targetUid ?? "",
    detail: entry.detail,
  }));
}

export function activityCsv(entries: readonly ActivityEntry[]): string {
  return buildCsv(activityRows(entries), ACTIVITY_COLUMNS);
}

/** Cabeceras comunes a las descargas de datos del panel. */
export function csvHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    // Nunca se cachea: son datos personales del alumnado.
    "Cache-Control": "no-store, max-age=0, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
