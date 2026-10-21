import { DomainError } from "@/domain/text";
import type { BackupRecord, BackupSource, BackupTarget } from "@/server/backup/store";

/**
 * DOBLE EN MEMORIA DE FIRESTORE PARA PROBAR COPIAS
 * ===============================================
 *
 * Reproduce las invariantes que importan al exportar y restaurar:
 *
 *   · el almacén es plano por ruta completa (`coleccion/doc` y
 *     `courses/x/versions/1`), como en Firestore;
 *   · `collections()` devuelve todas las colecciones con datos, incluidas las
 *     subcolecciones;
 *   · `read()` devuelve los documentos ordenados por ruta;
 *   · `write()` es atómico por lote: si falla, no deja nada del lote;
 *   · `count()` cuenta todos los documentos, como el recuento real.
 *
 * Lo que NO reproduce: transacciones, límites de tamaño del servidor ni
 * latencia. Las pruebas que usan este doble verifican la lógica de copia, no
 * Firestore.
 */

/** Copia profunda que respeta los Buffer (structuredClone los convierte en Uint8Array). */
function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = clone(item);
    }
    return output as unknown as T;
  }
  return value;
}

export class InMemoryFirestore {
  readonly docs = new Map<string, Record<string, unknown>>();
  writes = 0;
  batches = 0;
  failOnBatch = -1;

  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, clone(data));
  }

  get(path: string): Record<string, unknown> | undefined {
    const found = this.docs.get(path);
    return found ? clone(found) : undefined;
  }

  /** Rutas de todas las colecciones que contienen documentos. */
  collectionPaths(): string[] {
    const found = new Set<string>();
    for (const path of this.docs.keys()) {
      const segments = path.split("/");
      // Prefijos de longitud impar: `accounts`, `courses`, `courses/x/versions`…
      for (let length = 1; length < segments.length; length += 2) {
        found.add(segments.slice(0, length).join("/"));
      }
    }
    return [...found].sort();
  }

  asSource(): BackupSource {
    return {
      collections: async () => this.collectionPaths(),
      read: async function* (this: InMemoryFirestore, collection: string) {
        const prefix = `${collection}/`;
        const depth = collection.split("/").length + 1;
        // Solo hijos directos, como una colección real: los documentos de una
        // subcolección pertenecen a otra "colección" (courses/x/versions).
        const paths = [...this.docs.keys()]
          .filter((path) => path.startsWith(prefix) && path.split("/").length === depth)
          .sort();
        for (const path of paths) {
          yield { path, data: clone(this.docs.get(path)!) } as BackupRecord;
        }
      }.bind(this),
    };
  }

  asTarget(): BackupTarget {
    return {
      isEmpty: async () => this.docs.size === 0,
      write: async (records: BackupRecord[]) => {
        const batchIndex = this.batches;
        this.batches += 1;
        if (batchIndex === this.failOnBatch) {
          throw new DomainError("SIMULATED_BATCH_FAILURE", "Fallo simulado del lote", 500);
        }
        // Atómico: se prepara y solo entonces se publica.
        const staged = records.map((record) => [record.path, clone(record.data)] as const);
        for (const [path, data] of staged) this.docs.set(path, data);
        this.writes += staged.length;
      },
      count: async () => this.docs.size,
    };
  }
}
