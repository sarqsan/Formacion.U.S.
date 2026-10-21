import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getUiSession } from "@/demo/session";
import { SiteHeader } from "./components/site-header";
import { resetDemo } from "./actions/demo";

export const metadata: Metadata = {
  title: "Formación U.G.–U.S.",
  description: "Aplicación independiente de formación del personal (U.G.–U.S.).",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getUiSession();

  return (
    <html lang="es" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        {session.mode === "demo" ? (
          <div className="demo-strip">
            <div className="shell">
              <strong>Modo demostración</strong>
              <span>
                Datos inventados en memoria. No hay Firebase, ni cuentas reales, ni documentos reales;
                al reiniciar el servidor todo vuelve al inicio.
              </span>
              <form action={resetDemo} className="ml-auto">
                <button type="submit" className="btn btn-secondary btn-sm">
                  Reiniciar datos de la demostración
                </button>
              </form>
            </div>
          </div>
        ) : null}

        <SiteHeader session={session} />

        <main className="shell w-full flex-1 py-7">{children}</main>

        <footer className="site-footer">
          <div className="shell flex flex-wrap items-center justify-between gap-2 py-4 text-xs muted">
            <span>
              Aplicación independiente de formación. No comparte datos ni credenciales con la
              aplicación de cuadrantes.
            </span>
            <Link href="/estado" className="underline">
              Qué está conectado y qué no
            </Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
