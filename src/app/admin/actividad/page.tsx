import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { accounts as listAccounts, adminActivity } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * REGISTRO DE ACTIVIDAD
 * =====================
 *
 * Qué se hizo, quién y cuándo. Hasta ahora todas las operaciones sensibles
 * escribían en `audits` y **nadie podía leerlo**: el aviso «queda en la
 * auditoría» de la ficha de una cuenta no tenía comprobación posible.
 *
 * Esta pantalla es de solo lectura. No hay botón para borrar ni para editar: un
 * registro que el administrador puede modificar no sirve como registro.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string }>;
}) {
  const { tipo } = await searchParams;
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  let entries: Awaited<ReturnType<typeof adminActivity>>;
  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  try {
    [entries, accounts] = await Promise.all([
      adminActivity(session.actor),
      listAccounts(session.actor),
    ]);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }

  const nameOf = (uid: string | null): string => {
    if (!uid) return "—";
    const account = accounts.find((item) => item.uid === uid);
    return account?.username ?? uid;
  };

  const types = [...new Set(entries.map((entry) => entry.type))].sort();
  const selected = tipo && types.includes(tipo) ? tipo : null;
  const visible = selected ? entries.filter((entry) => entry.type === selected) : entries;

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        / <span>Actividad</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Auditoría</p>
          <h1 className="page-title mt-1">Registro de actividad</h1>
          <p className="muted mt-1 max-w-3xl text-sm leading-relaxed">
            Las últimas {entries.length} operaciones con efecto sobre las cuentas y el contenido. Se
            escribe al hacerlas, no al leerlas, y no se puede modificar desde aquí. Nunca contiene
            contraseñas, códigos de activación ni respuestas de examen.
          </p>
        </div>
        <a href="/api/admin/exports/activity" className="btn btn-secondary" download>
          Descargar en Excel (CSV)
        </a>
      </div>

      {types.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link
            href="/admin/actividad"
            className={selected === null ? "pill pill-ok" : "pill pill-off"}
          >
            Todo
          </Link>
          {types.map((type) => (
            <Link
              key={type}
              href={`/admin/actividad?tipo=${encodeURIComponent(type)}`}
              className={selected === type ? "pill pill-ok" : "pill pill-off"}
            >
              {type}
            </Link>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="card p-5">
          <p className="muted text-sm">
            Todavía no hay actividad registrada. Aparecerá aquí en cuanto se deshabilite una cuenta,
            se reemita un código, se importen personas o se restablezca una contraseña.
          </p>
        </div>
      ) : (
        <div className="card p-4">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Cuándo (UTC)</th>
                  <th scope="col">Qué</th>
                  <th scope="col">Quién</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry, index) => (
                  <tr key={entry.id ?? `${entry.type}-${entry.at ?? "sin-fecha"}-${index}`}>
                    <td className="muted whitespace-nowrap text-xs">{formatDateTime(entry.at)}</td>
                    <td>
                      <span className="font-medium">{entry.title}</span>
                      <span className="mono muted ml-2 text-[11px]">{entry.type}</span>
                    </td>
                    <td className="mono text-xs">{nameOf(entry.actorUid)}</td>
                    <td className="muted text-xs leading-relaxed">{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="muted text-xs leading-relaxed">
        Se conservan los {entries.length} eventos más recientes; no hay borrado ni rotación desde la
        aplicación. Si necesitas un histórico más largo o exportarlo, dímelo y lo añadimos.
      </p>
    </div>
  );
}
