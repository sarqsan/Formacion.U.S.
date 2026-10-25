import { NextResponse, type NextRequest } from "next/server";
import { demoEnabled } from "@/server/config/demo-gate";

/**
 * PUERTA DE ENTRADA (defensa en profundidad, NO autorización)
 * ==========================================================
 *
 * El proxy solo comprueba que exista una cookie de sesión y redirige a
 * /login si no la hay. No puede validar la firma (el edge no ejecuta
 * firebase-admin), así que NO es la línea de defensa real:
 *
 * - Las páginas y APIs protegidas verifican la cookie con Admin SDK
 *   (`getActor` / `requireActor`).
 * - Las reglas de Firestore y Storage impiden leer o escribir sin permisos.
 *
 * Una cookie falsificada pasa este filtro y es rechazada en el servidor.
 *
 * (En Next 16 la convención `middleware` se llama `proxy`; el matcher y la
 * semántica son los mismos.)
 */
const PROTECTED_PREFIXES = ["/panel", "/admin", "/cursos"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return NextResponse.next();

  const cookieName = process.env.SESSION_COOKIE_NAME ?? "formacion_session";
  const hasSessionCookie = Boolean(request.cookies.get(cookieName)?.value);

  // Modo demostración (DEMO_MODE=1): la "sesión" es una cookie con el uid de
  // una cuenta ficticia. Este proxy solo evita entrar sin elegir perfil; la
  // autorización real de la demostración se comprueba en cada página y
  // servicio (`getUiSession` + `assertAdmin`/`assertCourseAccess`).
  // El candado es el mismo que usa el resto de la aplicación: en producción la
  // demostración está cerrada aunque alguien deje DEMO_MODE=1 en el entorno.
  const hasDemoCookie =
    demoEnabled() && Boolean(request.cookies.get("formacion_demo")?.value);

  if (hasSessionCookie || hasDemoCookie) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/panel/:path*", "/admin/:path*", "/cursos/:path*"],
};
