import Link from "next/link";
import { redirect } from "next/navigation";
import { getUiSession } from "@/demo/session";
import { accounts as listAccounts } from "@/server/portal";
import { DataUnavailable, isUnavailable } from "@/app/components/data-unavailable";

export const dynamic = "force-dynamic";

/**
 * PERSONAS Y CUENTAS (bloque 09)
 * ==============================
 *
 * Lista de cuentas con su estado real y acceso a la ficha de cada una. Los
 * filtros son de servidor (`searchParams`): sin JavaScript, un enlace
 * compartido enseña lo mismo a todo el mundo y no hay estado escondido en el
 * navegador.
 *
 * Los estados que se ven aquí salen de la base de datos, no de un cálculo de la
 * interfaz: si algo no cuadra, se ve tal cual.
 */

const STATUS_LABEL: Record<string, string> = {
  pending_activation: "Pendiente de activación",
  active: "Activa",
  disabled: "Deshabilitada",
};

const STATUS_CLASS: Record<string, string> = {
  pending_activation: "pill pill-warn",
  active: "pill pill-ok",
  disabled: "pill pill-error",
};

const ROLE_LABEL: Record<string, string> = {
  admin: "Administración",
  learner: "Alumnado",
};

const STATUS_FILTERS = ["todas", "active", "pending_activation", "disabled"] as const;
const ROLE_FILTERS = ["todos", "learner", "admin"] as const;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes((value ?? "") as T) ? ((value ?? "") as T) : fallback;
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string; rol?: string; q?: string }>;
}) {
  const { estado, rol, q } = await searchParams;
  const session = await getUiSession();
  if (session.mode === "unconfigured") redirect("/admin");
  if (!session.actor) redirect("/login");
  if (session.actor.role !== "admin") redirect("/panel");

  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  try {
    accounts = await listAccounts(session.actor);
  } catch (error) {
    if (isUnavailable(error)) {
      return <DataUnavailable detail={error instanceof Error ? error.message : undefined} />;
    }
    throw error;
  }

  const status = pick(estado, STATUS_FILTERS, "todas");
  const role = pick(rol, ROLE_FILTERS, "todos");
  const query = (q ?? "").trim().toLowerCase();

  const filtered = accounts.filter((account) => {
    if (status !== "todas" && account.status !== status) return false;
    if (role !== "todos" && account.role !== role) return false;
    if (!query) return true;
    return (
      account.username.toLowerCase().includes(query) ||
      account.displayName.toLowerCase().includes(query) ||
      account.uid.toLowerCase().includes(query)
    );
  });

  const counts = {
    total: accounts.length,
    active: accounts.filter((account) => account.status === "active").length,
    pending: accounts.filter((account) => account.status === "pending_activation").length,
    disabled: accounts.filter((account) => account.status === "disabled").length,
  };

  const queryFor = (next: { estado?: string; rol?: string; q?: string }) => {
    const params = new URLSearchParams();
    const merged = { estado: status, rol: role, q: query, ...next };
    if (merged.estado !== "todas") params.set("estado", merged.estado);
    if (merged.rol !== "todos") params.set("rol", merged.rol);
    if (merged.q) params.set("q", merged.q);
    const serialized = params.toString();
    return serialized ? `/admin/personas?${serialized}` : "/admin/personas";
  };

  return (
    <div className="space-y-5">
      <nav className="text-xs muted">
        <Link href="/admin" className="underline">
          Administración
        </Link>{" "}
        / <span>Personas</span>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Cuentas</p>
          <h1 className="page-title mt-1">Personas y cuentas</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            Una cuenta no se borra: se activa, se deshabilita o se reactiva. Deshabilitar cierra la
            sesión abierta y anula cualquier código de activación pendiente.
          </p>
        </div>
        <Link href="/admin/importar" className="btn btn-secondary">
          Importar personas
        </Link>
      </div>

      <div className="grid-stats">
        <div className="stat">
          <p className="stat-value">{counts.total}</p>
          <p className="stat-label">Cuentas</p>
        </div>
        <div className="stat">
          <p className="stat-value">{counts.active}</p>
          <p className="stat-label">Activas</p>
        </div>
        <div className="stat">
          <p className="stat-value">{counts.pending}</p>
          <p className="stat-label">Pendientes</p>
        </div>
        <div className="stat">
          <p className="stat-value">{counts.disabled}</p>
          <p className="stat-label">Deshabilitadas</p>
        </div>
      </div>

      <form className="card flex flex-wrap items-end gap-3 p-4" action="/admin/personas" method="get">
        <div className="min-w-[12rem] flex-1">
          <label className="label" htmlFor="q">
            Buscar
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query}
            className="input"
            placeholder="Usuario, nombre o identificador"
          />
        </div>
        <div>
          <label className="label" htmlFor="estado">
            Estado
          </label>
          <select id="estado" name="estado" defaultValue={status} className="input">
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "todas" ? "Todas" : (STATUS_LABEL[value] ?? value)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="rol">
            Rol
          </label>
          <select id="rol" name="rol" defaultValue={role} className="input">
            {ROLE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "todos" ? "Todos" : (ROLE_LABEL[value] ?? value)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-secondary">
          Filtrar
        </button>
        <Link href="/admin/personas" className="text-xs underline muted">
          Quitar filtros
        </Link>
      </form>

      {filtered.length === 0 ? (
        <div className="card p-5 text-sm muted">
          Ninguna cuenta coincide con el filtro.{" "}
          <Link href={queryFor({ estado: "todas", rol: "todos", q: "" })} className="underline">
            Ver todas
          </Link>
        </div>
      ) : (
        <div className="table-wrap card p-0">
          <table className="data">
            <thead>
              <tr>
                <th>Usuario</th>
                <th>Nombre</th>
                <th>Rol de persona</th>
                <th>Rol de cuenta</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((account) => (
                <tr key={account.uid}>
                  <td className="mono">{account.username || account.uid}</td>
                  <td>{account.displayName}</td>
                  <td>{account.personRol}</td>
                  <td>{ROLE_LABEL[account.role] ?? account.role}</td>
                  <td>
                    <span className={STATUS_CLASS[account.status] ?? "pill pill-warn"}>
                      {STATUS_LABEL[account.status] ?? account.status}
                    </span>
                  </td>
                  <td className="text-right">
                    <Link
                      href={`/admin/personas/${encodeURIComponent(account.uid)}`}
                      className="btn btn-secondary btn-sm"
                    >
                      Ver ficha
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted text-xs leading-relaxed">
        Mostrando {filtered.length} de {accounts.length} cuentas. La lista completa se lee del
        almacén con el rol comprobado en el servidor; los filtros no cambian qué se puede ver, solo
        qué se muestra.
      </p>
    </div>
  );
}
