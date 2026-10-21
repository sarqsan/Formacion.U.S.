import Link from "next/link";
import type { UiSession } from "@/demo/session";
import { demoAccountByUid } from "@/demo/store";
import { SessionControls } from "./session-controls";

/**
 * Cabecera del sitio: marca, navegación por rol y cierre de sesión.
 *
 * En modo demostración muestra además el usuario de demostración con el que se
 * está recorriendo la aplicación: nunca se presenta como una cuenta real.
 */
export function SiteHeader({ session }: { session: UiSession }) {
  const actor = session.actor;
  const account = actor && session.mode === "demo" ? demoAccountByUid(actor.uid) : null;

  const links: Array<{ href: string; label: string }> = [];
  if (actor) {
    links.push({ href: "/panel", label: "Mi formación" });
    if (actor.role === "admin") {
      links.push({ href: "/admin", label: "Administración" });
      links.push({ href: "/admin/cursos", label: "Cursos" });
      links.push({ href: "/admin/matriculas", label: "Matrículas" });
      links.push({ href: "/admin/progreso", label: "Progreso" });
    }
  }

  return (
    <header className="site-header">
      <div className="shell flex items-center justify-between gap-3 py-3">
        <Link href={actor ? "/panel" : "/"} className="brand">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          Formación U.G.–U.S.
        </Link>

        <div className="flex items-center gap-2">
          <nav aria-label="Principal" className="nav hidden sm:flex">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="nav-link">
                {link.label}
              </Link>
            ))}
            {!actor ? (
              <Link href="/login" className="nav-link">
                Iniciar sesión
              </Link>
            ) : null}
          </nav>

          {actor ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-right text-xs leading-tight sm:block">
                <span className="block font-semibold">{account?.username ?? "Sesión iniciada"}</span>
                <span className="muted">
                  {actor.role === "admin" ? "Administración" : "Alumno"}
                  {account ? ` · ${account.personRol}` : ""}
                </span>
              </span>
              <SessionControls mode={session.mode} />
            </div>
          ) : (
            <Link href="/login" className="btn btn-primary btn-sm sm:hidden">
              Entrar
            </Link>
          )}
        </div>
      </div>

      {links.length > 0 ? (
        <nav
          aria-label="Principal móvil"
          className="shell flex gap-1 overflow-x-auto pb-2 sm:hidden"
        >
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="nav-link whitespace-nowrap">
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
