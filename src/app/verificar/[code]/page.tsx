import Link from "next/link";
import { certificateVerification } from "@/server/portal";
import { formatCertificateDate } from "@/domain/certificates/certificate";
import { DomainError } from "@/domain/text";

export const dynamic = "force-dynamic";

/**
 * VERIFICACIÓN PÚBLICA DE UN CERTIFICADO
 * ======================================
 *
 * Esta página **no pide sesión**: quien recibe un certificado tiene que poder
 * comprobar que es auténtico sin tener cuenta aquí. Es justo lo que el PDF
 * promete cuando dice que su autenticidad se comprueba con el código.
 *
 * Lo que se enseña y lo que no:
 *
 *   · **sí**: curso, versión, fecha de finalización, fecha de emisión y el
 *     nombre **enmascarado** (`G*** L***, M***`), suficiente para que quien
 *     espera el documento lo reconozca;
 *   · **no**: el nombre completo, el usuario, el PDF ni el identificador de la
 *     cuenta. Un código reenviado no se convierte en una ficha de la persona.
 *
 * Un código con mala forma no consulta la base de datos: no puede existir.
 */
export default async function VerifyCodePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  let result: Awaited<ReturnType<typeof certificateVerification>>;
  try {
    result = await certificateVerification(code);
  } catch (error) {
    if (error instanceof DomainError) {
      // Un fallo de la base no es «certificado falso»: se dice tal cual.
      return (
        <div className="mx-auto max-w-xl">
          <div className="card p-6">
            <h1 className="page-title">No se ha podido verificar</h1>
            <p className="muted mt-2 text-sm leading-relaxed">{error.message}</p>
          </div>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <nav className="text-xs muted">
        <Link href="/verificar" className="underline">
          Verificar un certificado
        </Link>{" "}
        / <span>Código</span>
      </nav>

      {result.valid ? (
        <article className="card p-6">
          <span className="pill pill-ok">Certificado válido</span>
          <h1 className="page-title mt-3">Certificado de aprovechamiento</h1>
          <p className="muted mt-2 text-sm leading-relaxed">
            Este código corresponde a un certificado emitido por la aplicación de formación de la
            U.G.–U.S.
          </p>

          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="muted text-xs uppercase tracking-wide">A nombre de</dt>
              <dd className="mt-1 text-sm font-medium">{result.holderMasked}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Curso</dt>
              <dd className="mt-1 text-sm font-medium">{result.courseTitle}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Versión cursada</dt>
              <dd className="mt-1 text-sm font-medium">Versión {result.version}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Fecha de finalización</dt>
              <dd className="mt-1 text-sm font-medium">{formatCertificateDate(result.completedAt)}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Fecha de emisión</dt>
              <dd className="mt-1 text-sm font-medium">{formatCertificateDate(result.issuedAt)}</dd>
            </div>
            <div>
              <dt className="muted text-xs uppercase tracking-wide">Código</dt>
              <dd className="mono mt-1 break-all text-xs">{result.code}</dd>
            </div>
          </dl>

          <p className="muted mt-5 text-xs leading-relaxed">
            El nombre se muestra enmascarado a propósito: basta para reconocer el documento, pero no
            identifica a la persona. El nombre completo y el PDF solo los ve quien tiene la sesión
            de la persona certificada.
          </p>
        </article>
      ) : (
        <article className="card p-6">
          <span className="pill pill-error">No válido</span>
          <h1 className="page-title mt-3">No hay ningún certificado con ese código</h1>
          <p className="muted mt-2 text-sm leading-relaxed">
            Comprueba que lo has copiado entero: son 20 caracteres hexadecimales (números del 0 al 9
            y letras de la a a la f). Si el código viene de un documento en papel, revisa que no se
            haya confundido una letra.
          </p>
          <div className="mt-4">
            <Link href="/verificar" className="btn btn-secondary btn-sm">
              Probar con otro código
            </Link>
          </div>
        </article>
      )}
    </div>
  );
}
