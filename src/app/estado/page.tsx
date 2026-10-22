import Link from "next/link";
import { getUiSession } from "@/demo/session";
import { isFirebaseMode } from "@/server/portal";

export const dynamic = "force-dynamic";

interface Row {
  feature: string;
  state: "real" | "demo" | "pending";
  detail: string;
}

const ROWS: Row[] = [
  {
    feature: "Inicio de sesión y activación",
    state: "real",
    detail:
      "Conectado a Firebase Authentication: la contraseña se comprueba allí, el servidor emite una cookie httpOnly y vuelve a verificar la cuenta en cada petición. En la demostración se sustituye por un selector de cuenta ficticia: no hay contraseñas.",
  },
  {
    feature: "Cursos, temas, matrículas y progreso",
    state: "real",
    detail:
      "Escrituras y lecturas conectadas a Firestore (versiones, matrículas, progreso e intentos). En la demostración las mismas funciones se ejecutan contra un almacén en memoria.",
  },
  {
    feature: "Publicación de versiones",
    state: "real",
    detail:
      "Servicio real: valida el contenido, impide publicar saltándose versiones y hace inmutable lo publicado.",
  },
  {
    feature: "Lectura en orden",
    state: "real",
    detail:
      "El servidor rechaza cualquier salto de página o pantalla. Los PDF por fragmentos están implementados y probados con dobles; la demostración usa texto para no necesitar documentos reales.",
  },
  {
    feature: "Cuestionarios y examen final",
    state: "real",
    detail:
      "Corrección en servidor con claves separadas del contenido público. El desbloqueo del examen final se comprueba en el servicio, no en la interfaz.",
  },
  {
    feature: "Matrículas",
    state: "real",
    detail:
      "Sin matrícula activa no hay acceso. Administración matricula y revoca desde el panel.",
  },
  {
    feature: "Progreso e intentos",
    state: "real",
    detail:
      "Panel de alumno y de administración con el estado real del progreso guardado.",
  },
  {
    feature: "Importación de Excel (Rol y Apellido)",
    state: "pending",
    detail:
      "La vista previa y la validación funcionan. La creación de cuentas requiere Firebase Authentication: no se ha ejecutado nunca contra el servicio real.",
  },
  {
    feature: "Subida de PDF por partes y cuota",
    state: "pending",
    detail:
      "Implementada y probada con dobles y en la demostración: reserva de cuota, partes de 768 KiB en orden, verificación de SHA-256 y cancelación que libera la reserva. La transacción real de Firestore no se ha ejecutado (sin emulador): la subida no se declara verificada contra Firestore.",
  },
  {
    feature: "Lectura de PDF por páginas",
    state: "pending",
    detail:
      "El servidor sirve rangos de páginas autorizados por matrícula y en orden, pero falta el visor: la página no dibuja el PDF y la demostración usa pantallas de texto. No se ha ejecutado con documentos reales.",
  },
  {
    feature: "Reglas de Firestore",
    state: "pending",
    detail:
      "41 pruebas escritas, 0 ejecutadas: el emulador oficial no se pudo descargar en este entorno. Ver docs/ENTORNO-PRUEBAS.md.",
  },
  {
    feature: "Copia de seguridad cifrada",
    state: "real",
    detail:
      "Exportación y restauración con AES-256-GCM probadas con datos sintéticos; el ensayo contra el emulador está bloqueado por lo mismo que las reglas.",
  },
];

const LABEL: Record<Row["state"], { text: string; className: string }> = {
  real: { text: "Lógica real", className: "pill pill-ok" },
  demo: { text: "Solo en demostración", className: "pill pill-info" },
  pending: { text: "Pendiente de conexión", className: "pill pill-warn" },
};

export default async function StatusPage() {
  const session = await getUiSession();

  // No se afirma «conectado» sin hablar con la base: en modo real se hace una
  // lectura de comprobación en cada carga de esta página.
  let connection: { ok: boolean; detail: string } | null = null;
  if (isFirebaseMode()) {
    const { checkConnection } = await import("@/server/portal/firebase");
    connection = await checkConnection();
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow">Transparencia</p>
        <h1 className="page-title mt-1">Qué está conectado y qué no</h1>
        <p className="lead mt-2 max-w-2xl">
          Esta página existe para no confundir una interfaz que se puede recorrer con un sistema
          conectado. «Lógica real» significa que la regla se aplica en el servidor con el mismo
          código que se usará en producción; no significa que se haya probado contra Firebase.
        </p>
      </div>

      <div className="alert alert-info">
        Modo actual:{" "}
        {session.mode === "demo" ? (
          <strong>demostración con datos en memoria</strong>
        ) : session.mode === "firebase" ? (
          <strong>Firebase configurado</strong>
        ) : (
          <strong>sin Firebase configurado</strong>
        )}
        .
      </div>

      {connection ? (
        <div className={connection.ok ? "alert alert-ok" : "alert alert-error"}>
          <strong>
            {connection.ok
              ? "Firestore ha respondido a la comprobación."
              : "Firestore no está disponible."}
          </strong>{" "}
          {connection.detail}
        </div>
      ) : null}

      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Función</th>
              <th>Estado</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.feature}>
                <td className="font-semibold">{row.feature}</td>
                <td>
                  <span className={LABEL[row.state].className}>{LABEL[row.state].text}</span>
                </td>
                <td className="muted">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-5 text-sm">
        <h2 className="font-semibold">Cómo arrancar la versión demostrable</h2>
        <pre className="mono mt-2 overflow-x-auto rounded-md bg-[#f4f6f3] p-3 text-xs">
          DEMO_MODE=1 npm run dev
        </pre>
        <p className="muted mt-2">
          Sin <code className="mono">DEMO_MODE</code>, la aplicación exige Firebase configurado.
          Consulta <Link href="/login" className="underline">acceso</Link> y la documentación del
          repositorio (<code className="mono">docs/ENTREGA-DEMO.md</code>).
        </p>
      </div>
    </div>
  );
}
