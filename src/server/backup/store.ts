import type { BackupValue } from "@/server/backup/codec";

/**
 * PUERTOS DE LA COPIA DE SEGURIDAD
 * ================================
 *
 * La exportación y la restauración no conocen Firestore: hablan con estos dos
 * puertos. El adaptador real (`src/server/firebase/backup-store.ts`) usa el
 * Admin SDK; las pruebas usan un doble en memoria con las mismas invariantes
 * (rutas con subcolecciones, documentos con Bytes y marcas de tiempo).
 *
 * Esto permite probar de verdad el recorrido completo —codificar, cifrar,
 * escribir, leer, descifrar, validar y volver a escribir— sin depender del
 * emulador. Lo que **no** prueba es el I/O real de Firestore; eso queda
 * declarado en el informe.
 */

export interface BackupRecord {
  /** Ruta completa: `coleccion/docId` o `courses/x/versions/1`. */
  path: string;
  data: Record<string, unknown>;
}

export interface BackupSource {
  /** Colecciones (y subcolecciones) que contienen datos. */
  collections(): Promise<string[]>;
  /** Documentos de una colección, en orden estable por ruta. */
  read(collection: string): AsyncIterable<BackupRecord>;
}

export interface BackupTarget {
  isEmpty(): Promise<boolean>;
  /** Escribe un lote de documentos. Debe ser atómico por lote. */
  write(records: BackupRecord[]): Promise<void>;
  /** Nº de documentos que hay ahora mismo (para verificar la restauración). */
  count(): Promise<number>;
}

export type { BackupValue };
