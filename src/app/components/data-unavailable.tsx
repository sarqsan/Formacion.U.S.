import Link from "next/link";

/**
 * ERROR DE PERSISTENCIA (sin conmutación silenciosa)
 * ================================================
 *
 * Si la aplicación está configurada contra Firestore y la base no responde,
 * se muestra esto. Lo que **no** se hace es caer al almacén en memoria de la
 * demostración: el usuario creería que sus matrículas y su progreso siguen ahí
 * cuando en realidad se estarían leyendo datos inventados.
 */
export function DataUnavailable({ detail }: { detail?: string }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="card p-6">
        <p className="eyebrow">Datos no disponibles</p>
        <h1 className="page-title mt-1">No se ha podido leer la base de datos</h1>
        <p className="lead mt-2 text-sm">
          {detail ??
            "Firestore no ha respondido. No se ha cambiado a los datos de ejemplo: lo que ves aquí es un fallo real, no una demostración."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/estado" className="btn btn-primary">
            Ver el estado del sistema
          </Link>
          <Link href="/" className="btn btn-secondary">
            Volver al inicio
          </Link>
        </div>
        <p className="muted mt-4 text-xs leading-relaxed">
          Comprueba que el proyecto tiene Firestore creado, que las credenciales de servicio siguen
          siendo válidas y que no se ha agotado la cuota diaria del plan gratuito.
        </p>
      </div>
    </div>
  );
}

/** ¿Este error es un fallo de infraestructura y no de negocio? */
export function isUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FIREBASE_UNAVAILABLE"
  );
}
