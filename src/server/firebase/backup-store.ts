import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { DomainError } from "@/domain/text";
import { mapTimestamps } from "@/server/backup/codec";
import type { BackupRecord, BackupSource, BackupTarget } from "@/server/backup/store";
import { COLLECTIONS } from "@/server/db/schema.constants";

/**
 * COPIAS SOBRE FIRESTORE (adaptador)
 * ==================================
 *
 * Implementa los puertos de copia con el Admin SDK. No conoce el cifrado ni el
 * formato del archivo: solo enumera colecciones, lee documentos completos y
 * escribe lotes.
 *
 * Se recorren también las subcolecciones (hoy `courses/{id}/versions`), porque
 * sin ellas la copia no reconstruiría los cursos.
 *
 * AVISO: este adaptador **no se ha ejecutado** en este entorno (el emulador de
 * Firestore no se puede descargar aquí). La lógica de exportación y
 * restauración sí está probada con un doble que reproduce las mismas
 * invariantes; el I/O real queda pendiente de la primera ejecución con
 * emulador o proyecto de pruebas.
 */

const MAX_DEPTH = 4;
const MAX_COLLECTIONS = 80;

export class FirestoreBackupSource implements BackupSource {
  constructor(private readonly db: Firestore) {}

  async collections(): Promise<string[]> {
    const found = new Set<string>();
    const roots = [...new Set(Object.values(COLLECTIONS))];

    for (const root of roots) {
      found.add(root);
      await this.discover(this.db.collection(root), 1, found);
    }

    if (found.size > MAX_COLLECTIONS) {
      throw new DomainError(
        "BACKUP_TOO_MANY_COLLECTIONS",
        `Se han encontrado ${found.size} colecciones; el máximo previsto es ${MAX_COLLECTIONS}. Revisa el esquema antes de continuar.`,
        500,
      );
    }

    return [...found].sort();
  }

  private async discover(
    collection: FirebaseFirestore.CollectionReference,
    depth: number,
    found: Set<string>,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;

    const snapshot = await collection.limit(500).get();
    for (const document of snapshot.docs) {
      const subcollections = await document.ref.listCollections();
      for (const subcollection of subcollections) {
        if (found.has(subcollection.path)) continue;
        found.add(subcollection.path);
        await this.discover(subcollection, depth + 1, found);
      }
    }
  }

  async *read(collectionPath: string): AsyncIterable<BackupRecord> {
    const collection = collectionOf(this.db, collectionPath);
    const query = collection.orderBy("__name__").limit(500);

    let last: FirebaseFirestore.DocumentSnapshot | null = null;
    for (;;) {
      const snapshot: FirebaseFirestore.QuerySnapshot = last
        ? await query.startAfter(last).get()
        : await query.get();
      if (snapshot.empty) return;

      for (const document of snapshot.docs) {
        yield { path: document.ref.path, data: document.data() ?? {} };
      }

      last = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < 500) return;
    }
  }
}

export class FirestoreBackupTarget implements BackupTarget {
  constructor(private readonly db: Firestore) {}

  async isEmpty(): Promise<boolean> {
    const roots = await this.db.listCollections();
    for (const collection of roots) {
      const snapshot = await collection.limit(1).get();
      if (!snapshot.empty) return false;
    }
    return true;
  }

  async write(records: BackupRecord[]): Promise<void> {
    if (records.length === 0) return;
    const batch = this.db.batch();

    for (const record of records) {
      const data = mapTimestamps(record.data, (stamp) => new Timestamp(stamp.seconds, stamp.nanoseconds)) as Record<
        string,
        unknown
      >;
      batch.set(this.db.doc(record.path), data, { merge: false });
    }

    await batch.commit();
  }

  async count(): Promise<number> {
    let total = 0;
    for (const root of await this.db.listCollections()) {
      total += await countCollection(root);
    }
    return total;
  }
}

async function countCollection(collection: FirebaseFirestore.CollectionReference): Promise<number> {
  const snapshot = await collection.count().get();
  let total = snapshot.data().count;

  const documents = await collection.limit(200).get();
  for (const document of documents.docs) {
    for (const subcollection of await document.ref.listCollections()) {
      total += await countCollection(subcollection);
    }
  }
  return total;
}

/**
 * `db.collection("courses/x/versions")` no existe: para una ruta con padre hay
 * que partir desde el documento padre.
 */
function collectionOf(db: Firestore, path: string): FirebaseFirestore.CollectionReference {
  const segments = path.split("/");
  if (segments.length % 2 !== 1) {
    throw new DomainError(
      "BACKUP_INVALID_PATH",
      `Ruta de colección no válida: «${path}».`,
      500,
    );
  }

  const parent = segments.slice(0, -1).join("/");
  const name = segments[segments.length - 1];
  return parent ? db.doc(parent).collection(name) : db.collection(name);
}
